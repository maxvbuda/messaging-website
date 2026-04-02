const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://maxvbuda.github.io',
  'https://messaging-website-6qqt.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── Middleware ──
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Persistence ──
const DEFAULT_DATA = {
  users: [],
  channels: [
    { id: 'c_general', name: 'general', topic: 'Company-wide announcements and work-based matters', createdBy: 'system' },
    { id: 'c_random', name: 'random', topic: 'Non-work banter and water cooler conversation', createdBy: 'system' },
  ],
  messages: {},
};

let data;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!data.users) data.users = [];
      if (!data.channels) data.channels = DEFAULT_DATA.channels;
      if (!data.messages) data.messages = {};
    } else {
      data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
  } catch {
    data = JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

let saveTimeout;
function saveData() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const toWrite = JSON.parse(JSON.stringify(data));
    toWrite.users = toWrite.users.map(u => ({ ...u, status: 'offline' }));
    fs.writeFileSync(DATA_FILE, JSON.stringify(toWrite, null, 2));
  }, 500);
}

function saveDataSync() {
  const toWrite = JSON.parse(JSON.stringify(data));
  toWrite.users = toWrite.users.map(u => ({ ...u, status: 'offline' }));
  fs.writeFileSync(DATA_FILE, JSON.stringify(toWrite, null, 2));
}

loadData();

// ── Token store: token → userId ──
const tokens = new Map();

function generateToken() {
  return uuidv4() + '-' + Date.now().toString(36);
}

function getUserByToken(token) {
  const userId = tokens.get(token);
  if (!userId) return null;
  return data.users.find(u => u.id === userId) || null;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, username: u.username, status: u.status, role: u.role, createdAt: u.createdAt };
}

// ── REST: Auth ──

app.post('/api/register', async (req, res) => {
  const { username, password, name } = req.body;

  if (!username || !password || !name) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (username.length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  }
  if (password.length < 3) {
    return res.status(400).json({ error: 'Password must be at least 3 characters.' });
  }

  const uname = username.trim().toLowerCase();
  if (data.users.find(u => u.username === uname)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: 'u_' + uuidv4().slice(0, 8),
    username: uname,
    passwordHash: hash,
    name: name.trim(),
    status: 'online',
    role: 'Member',
    createdAt: Date.now(),
  };

  data.users.push(user);
  saveData();

  const token = generateToken();
  tokens.set(token, user.id);

  io.emit('user_joined', { user: publicUser(user) });

  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }

  const uname = username.trim().toLowerCase();
  const user = data.users.find(u => u.username === uname);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  user.status = 'online';
  saveData();

  const token = generateToken();
  tokens.set(token, user.id);

  io.emit('user_status', { userId: user.id, status: 'online' });

  res.json({ token, user: publicUser(user) });
});

// ── REST: Data bootstrap (after login, client fetches everything) ──

app.get('/api/data', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  res.json({
    users: data.users.map(publicUser),
    channels: data.channels,
    messages: data.messages,
  });
});

// ── Socket.IO ──

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('authenticate', (token) => {
    currentUser = getUserByToken(token);
    if (!currentUser) {
      socket.emit('auth_error', 'Invalid token');
      return;
    }

    currentUser.status = 'online';
    saveData();

    socket.emit('authenticated', { user: publicUser(currentUser) });
    socket.broadcast.emit('user_status', { userId: currentUser.id, status: 'online' });
  });

  // ── Join / leave channel rooms ──

  socket.on('join_channel', (channelId) => {
    if (!currentUser) return;
    socket.join(channelId);
  });

  socket.on('leave_channel', (channelId) => {
    socket.leave(channelId);
  });

  // ── Send message ──

  socket.on('send_message', ({ channelId, text }) => {
    if (!currentUser || !text?.trim()) return;

    const msg = {
      id: 'msg_' + uuidv4().slice(0, 12),
      userId: currentUser.id,
      text: text.trim(),
      ts: Date.now(),
      reactions: {},
      threadReplies: [],
    };

    if (!data.messages[channelId]) data.messages[channelId] = [];
    data.messages[channelId].push(msg);
    saveData();

    io.to(channelId).emit('new_message', { channelId, message: msg });
  });

  // ── Thread reply ──

  socket.on('thread_reply', ({ channelId, parentMsgId, text }) => {
    if (!currentUser || !text?.trim()) return;

    const msgs = data.messages[channelId];
    if (!msgs) return;
    const parent = msgs.find(m => m.id === parentMsgId);
    if (!parent) return;

    const reply = {
      id: 'reply_' + uuidv4().slice(0, 12),
      userId: currentUser.id,
      text: text.trim(),
      ts: Date.now(),
    };

    if (!parent.threadReplies) parent.threadReplies = [];
    parent.threadReplies.push(reply);
    saveData();

    io.to(channelId).emit('thread_reply', { channelId, parentMsgId, reply });
  });

  // ── Reaction ──

  socket.on('reaction', ({ channelId, msgId, emoji }) => {
    if (!currentUser) return;

    const msgs = data.messages[channelId];
    if (!msgs) return;
    const msg = msgs.find(m => m.id === msgId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const idx = msg.reactions[emoji].indexOf(currentUser.id);
    if (idx > -1) {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(currentUser.id);
    }
    saveData();

    io.to(channelId).emit('reaction_updated', { channelId, msgId, reactions: msg.reactions });
  });

  // ── Delete message ──

  socket.on('delete_message', ({ channelId, msgId }) => {
    if (!currentUser) return;

    const msgs = data.messages[channelId];
    if (!msgs) return;
    const idx = msgs.findIndex(m => m.id === msgId && m.userId === currentUser.id);
    if (idx === -1) return;

    msgs.splice(idx, 1);
    saveData();

    io.to(channelId).emit('message_deleted', { channelId, msgId });
  });

  // ── Create channel ──

  socket.on('create_channel', ({ name, topic }) => {
    if (!currentUser || !name?.trim()) return;

    const slug = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!slug) return;
    if (data.channels.find(c => c.name === slug)) {
      socket.emit('error_msg', 'Channel already exists');
      return;
    }

    const channel = {
      id: 'c_' + uuidv4().slice(0, 8),
      name: slug,
      topic: (topic || '').trim(),
      createdBy: currentUser.id,
    };

    data.channels.push(channel);
    data.messages[channel.id] = [];
    saveData();

    io.emit('channel_created', { channel });
  });

  // ── Open DM ──

  socket.on('open_dm', ({ targetUserId }) => {
    if (!currentUser) return;

    const target = data.users.find(u => u.id === targetUserId);
    if (!target) return;

    const ids = [currentUser.id, targetUserId].sort();
    const dmChannelId = 'dm_' + ids.join('_');

    if (!data.channels.find(c => c.id === dmChannelId)) {
      const channel = {
        id: dmChannelId,
        name: target.name,
        topic: `Direct message with ${target.name}`,
        createdBy: currentUser.id,
        isDM: true,
        participants: ids,
      };
      data.channels.push(channel);
      data.messages[dmChannelId] = [];
      saveData();
    }

    socket.emit('dm_opened', { channelId: dmChannelId });
    socket.join(dmChannelId);
  });

  // ── Typing ──

  socket.on('typing', ({ channelId }) => {
    if (!currentUser) return;
    socket.to(channelId).emit('user_typing', { channelId, userId: currentUser.id, userName: currentUser.name });
  });

  // ── Profile update ──

  socket.on('update_profile', ({ name }) => {
    if (!currentUser || !name?.trim()) return;
    currentUser.name = name.trim();
    saveData();
    io.emit('user_updated', { user: publicUser(currentUser) });
  });

  // ── Disconnect ──

  socket.on('disconnect', () => {
    if (currentUser) {
      currentUser.status = 'offline';
      saveData();
      io.emit('user_status', { userId: currentUser.id, status: 'offline' });
    }
  });
});

// ── Graceful shutdown ──
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  saveDataSync();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveDataSync();
  process.exit(0);
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`SlackFlow server running on http://localhost:${PORT}`);
});
