// SlackFlow Server — MongoDB persistence enabled
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { MongoClient } = require('mongodb');

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
const MONGODB_URI = process.env.MONGODB_URI;

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

// ── MongoDB ──
let db;
let usersCol, channelsCol, messagesCol, sessionsCol;

const DEFAULT_CHANNELS = [
  { id: 'c_general', name: 'general', topic: 'Company-wide announcements and work-based matters', createdBy: 'system' },
  { id: 'c_random', name: 'random', topic: 'Non-work banter and water cooler conversation', createdBy: 'system' },
];

async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('No MONGODB_URI set — data will not persist across restarts.');
    return false;
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('slackflow');
  usersCol = db.collection('users');
  channelsCol = db.collection('channels');
  messagesCol = db.collection('messages');
  sessionsCol = db.collection('sessions');
  // Auto-expire sessions after 30 days
  await sessionsCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

  // Seed default channels if none exist
  const count = await channelsCol.countDocuments();
  if (count === 0) {
    await channelsCol.insertMany(DEFAULT_CHANNELS);
  }

  console.log('Connected to MongoDB');
  return true;
}

// ── In-memory fallback (no MongoDB) ──
let memData = {
  users: [],
  channels: JSON.parse(JSON.stringify(DEFAULT_CHANNELS)),
  messages: {},
};

// ── Data helpers (work with both Mongo and memory) ──
async function getUsers() {
  if (db) return usersCol.find().toArray();
  return memData.users;
}

async function findUser(query) {
  if (db) return usersCol.findOne(query);
  if (query.username) return memData.users.find(u => u.username === query.username) || null;
  if (query.id) return memData.users.find(u => u.id === query.id) || null;
  return null;
}

async function insertUser(user) {
  if (db) { await usersCol.insertOne(user); return; }
  memData.users.push(user);
}

async function updateUser(id, updates) {
  if (db) { await usersCol.updateOne({ id }, { $set: updates }); return; }
  const u = memData.users.find(x => x.id === id);
  if (u) Object.assign(u, updates);
}

async function getChannels() {
  if (db) return channelsCol.find().toArray();
  return memData.channels;
}

async function findChannel(query) {
  if (db) return channelsCol.findOne(query);
  if (query.id) return memData.channels.find(c => c.id === query.id) || null;
  if (query.name) return memData.channels.find(c => c.name === query.name) || null;
  return null;
}

async function insertChannel(channel) {
  if (db) { await channelsCol.insertOne(channel); return; }
  memData.channels.push(channel);
}

async function getMessages(channelId) {
  if (db) {
    const doc = await messagesCol.findOne({ channelId });
    return doc ? doc.messages : [];
  }
  return memData.messages[channelId] || [];
}

async function getAllMessages() {
  if (db) {
    const docs = await messagesCol.find().toArray();
    const result = {};
    docs.forEach(d => { result[d.channelId] = d.messages; });
    return result;
  }
  return memData.messages;
}

async function appendMessage(channelId, msg) {
  if (db) {
    await messagesCol.updateOne(
      { channelId },
      { $push: { messages: msg } },
      { upsert: true }
    );
    return;
  }
  if (!memData.messages[channelId]) memData.messages[channelId] = [];
  memData.messages[channelId].push(msg);
}

async function updateMessagesForChannel(channelId, msgs) {
  if (db) {
    await messagesCol.updateOne({ channelId }, { $set: { messages: msgs } }, { upsert: true });
    return;
  }
  memData.messages[channelId] = msgs;
}

// ── Token store: token → userId (in-memory is fine, users just re-login after restart) ──
const tokens = new Map();

function generateToken() {
  return uuidv4() + '-' + Date.now().toString(36);
}

async function getUserByToken(token) {
  // Check in-memory map first (fast path)
  let userId = tokens.get(token);
  if (!userId && db) {
    // Fall back to MongoDB (covers server restarts)
    const session = await sessionsCol.findOne({ token });
    if (session) {
      userId = session.userId;
      tokens.set(token, userId); // restore to memory
    }
  }
  if (!userId) return null;
  return findUser({ id: userId });
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, username: u.username, status: u.status, role: u.role, createdAt: u.createdAt };
}

// ── REST: Auth ──

app.post('/api/register', async (req, res) => {
  const { username, password, name } = req.body;

  if (!username || !password || !name) return res.status(400).json({ error: 'All fields are required.' });
  if (username.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters.' });

  const uname = username.trim().toLowerCase();
  if (await findUser({ username: uname })) return res.status(409).json({ error: 'That username is already taken.' });

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

  await insertUser(user);

  const token = generateToken();
  tokens.set(token, user.id);
  if (db) await sessionsCol.insertOne({ token, userId: user.id, createdAt: new Date() });

  io.emit('user_joined', { user: publicUser(user) });
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) return res.status(400).json({ error: 'Please fill in all fields.' });

  const uname = username.trim().toLowerCase();
  const user = await findUser({ username: uname });
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid username or password.' });

  await updateUser(user.id, { status: 'online' });

  const token = generateToken();
  tokens.set(token, user.id);
  if (db) await sessionsCol.insertOne({ token, userId: user.id, createdAt: new Date() });

  io.emit('user_status', { userId: user.id, status: 'online' });
  res.json({ token, user: publicUser({ ...user, status: 'online' }) });
});

// ── REST: Data bootstrap ──

app.get('/api/data', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const [users, channels, messages] = await Promise.all([getUsers(), getChannels(), getAllMessages()]);

  res.json({
    currentUser: publicUser(user),
    users: users.map(publicUser),
    channels,
    messages,
  });
});

// ── Socket.IO ──

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('authenticate', async (token) => {
    currentUser = await getUserByToken(token);
    if (!currentUser) { socket.emit('auth_error', 'Invalid token'); return; }

    await updateUser(currentUser.id, { status: 'online' });
    currentUser.status = 'online';

    // Auto-join all non-DM channels so messages are always received
    try {
      const allChannels = await getChannels();
      allChannels.forEach(ch => { if (!ch.isDM) socket.join(ch.id); });
    } catch (e) { /* non-fatal */ }

    socket.emit('authenticated', { user: publicUser(currentUser) });
    socket.broadcast.emit('user_status', { userId: currentUser.id, status: 'online' });
  });

  socket.on('join_channel', (channelId) => { if (currentUser) socket.join(channelId); });
  socket.on('leave_channel', (channelId) => { socket.leave(channelId); });

  socket.on('send_message', async ({ channelId, text }) => {
    if (!currentUser || !text?.trim()) return;

    const msg = {
      id: 'msg_' + uuidv4().slice(0, 12),
      userId: currentUser.id,
      text: text.trim(),
      ts: Date.now(),
      reactions: {},
      threadReplies: [],
    };

    // Emit immediately so real-time always works, then persist
    io.to(channelId).emit('new_message', { channelId, message: msg });
    try { await appendMessage(channelId, msg); } catch (e) { console.error('DB write error (send_message):', e.message); }
  });

  socket.on('thread_reply', async ({ channelId, parentMsgId, text }) => {
    if (!currentUser || !text?.trim()) return;

    try {
      const msgs = await getMessages(channelId);
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
      await updateMessagesForChannel(channelId, msgs);
      io.to(channelId).emit('thread_reply', { channelId, parentMsgId, reply });
    } catch (e) { console.error('DB error (thread_reply):', e.message); }
  });

  socket.on('reaction', async ({ channelId, msgId, emoji }) => {
    if (!currentUser) return;

    try {
      const msgs = await getMessages(channelId);
      const msg = msgs.find(m => m.id === msgId);
      if (!msg) return;

      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

      const idx = msg.reactions[emoji].indexOf(currentUser.id);
      if (idx > -1) {
        msg.reactions[emoji].splice(idx, 1);
        if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
      } else {
        msg.reactions[emoji].push(currentUser.id);
      }

      await updateMessagesForChannel(channelId, msgs);
      io.to(channelId).emit('reaction_updated', { channelId, msgId, reactions: msg.reactions });
    } catch (e) { console.error('DB error (reaction):', e.message); }
  });

  socket.on('delete_message', async ({ channelId, msgId }) => {
    if (!currentUser) return;

    try {
      const msgs = await getMessages(channelId);
      const idx = msgs.findIndex(m => m.id === msgId && m.userId === currentUser.id);
      if (idx === -1) return;

      msgs.splice(idx, 1);
      await updateMessagesForChannel(channelId, msgs);
      io.to(channelId).emit('message_deleted', { channelId, msgId });
    } catch (e) { console.error('DB error (delete_message):', e.message); }
  });

  socket.on('create_channel', async ({ name, topic }) => {
    if (!currentUser || !name?.trim()) return;

    try {
      const slug = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!slug) return;
      if (await findChannel({ name: slug })) { socket.emit('error_msg', 'Channel already exists'); return; }

      const channel = {
        id: 'c_' + uuidv4().slice(0, 8),
        name: slug,
        topic: (topic || '').trim(),
        createdBy: currentUser.id,
      };

      await insertChannel(channel);
      io.emit('channel_created', { channel });
    } catch (e) { console.error('DB error (create_channel):', e.message); }
  });

  socket.on('open_dm', async ({ targetUserId }) => {
    if (!currentUser) return;

    try {
      const target = await findUser({ id: targetUserId });
      if (!target) return;

      const ids = [currentUser.id, targetUserId].sort();
      const dmChannelId = 'dm_' + ids.join('_');

      if (!(await findChannel({ id: dmChannelId }))) {
        const channel = {
          id: dmChannelId,
          name: target.name,
          topic: `Direct message with ${target.name}`,
          createdBy: currentUser.id,
          isDM: true,
          participants: ids,
        };
        await insertChannel(channel);
      }

      socket.emit('dm_opened', { channelId: dmChannelId });
      socket.join(dmChannelId);
    } catch (e) { console.error('DB error (open_dm):', e.message); }
  });

  socket.on('typing', ({ channelId }) => {
    if (!currentUser) return;
    socket.to(channelId).emit('user_typing', { channelId, userId: currentUser.id, userName: currentUser.name });
  });

  socket.on('update_profile', async ({ name }) => {
    if (!currentUser || !name?.trim()) return;
    try {
      await updateUser(currentUser.id, { name: name.trim() });
      currentUser.name = name.trim();
      io.emit('user_updated', { user: publicUser(currentUser) });
    } catch (e) { console.error('DB error (update_profile):', e.message); }
  });

  socket.on('disconnect', async () => {
    if (currentUser) {
      try {
        await updateUser(currentUser.id, { status: 'offline' });
      } catch (e) { console.error('DB error (disconnect):', e.message); }
      io.emit('user_status', { userId: currentUser.id, status: 'offline' });
    }
  });
});

// ── Start ──
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`SlackFlow server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  // Start anyway with in-memory fallback
  server.listen(PORT, () => {
    console.log(`SlackFlow server running on http://localhost:${PORT} (in-memory mode)`);
  });
});
