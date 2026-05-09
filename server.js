// SlackFlow Server — MongoDB persistence
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { MongoClient } = require('mongodb');
const multer = require('multer');
const crypto = require('crypto');
const { normalizeChatText } = require('./public/chatNormalize.js');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://maxvbuda.github.io',
  'https://maxbuda.github.io',
  'https://messaging-website-6qqt.onrender.com',
];

const CORS_EXTRA_ORIGINS = String(process.env.CORS_EXTRA_ORIGINS || process.env.ADMIN_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (CORS_EXTRA_ORIGINS.includes(origin)) return true;
  // Allow any localhost or 127.0.0.1 origin regardless of port
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
/** Database name in the cluster (override with MONGODB_DB or MONGODB_DB_NAME). Defaults to slackflow. */
const MONGODB_DB_NAME = (process.env.MONGODB_DB || process.env.MONGODB_DB_NAME || 'slackflow').trim() || 'slackflow';

// ── Middleware ──
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

let db;
let usersCol, channelsCol, messagesCol, sessionsCol, filesCol, joinRequestsCol, featureLabCol;

const DEFAULT_CHANNELS = [
  { id: 'c_general', name: 'general', topic: 'Company-wide announcements and work-based matters', createdBy: 'system' },
  { id: 'c_random', name: 'random', topic: 'Non-work banter and water cooler conversation', createdBy: 'system' },
];

/** Synthetic Dungeon Master participant (not persisted in Mongo). */
const ROBOT_DM_ID = 'u_sf_robot_dm';

function getRobotDmDocument() {
  return {
    id: ROBOT_DM_ID,
    username: 'robot_dm',
    name: 'Robot DM',
    status: 'online',
    statusMsg: '',
    role: 'bot',
    createdAt: 0,
    avatarUrl: null,
  };
}

function withRobotDmUserList(users) {
  const list = Array.isArray(users) ? users.slice() : [];
  if (!list.some((u) => u && u.id === ROBOT_DM_ID)) list.push(getRobotDmDocument());
  return list;
}

async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('No MONGODB_URI set — data will not persist across restarts.');
    return false;
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(MONGODB_DB_NAME);
  usersCol = db.collection('users');
  channelsCol = db.collection('channels');
  messagesCol = db.collection('messages');
  sessionsCol = db.collection('sessions');
  filesCol = db.collection('files');
  joinRequestsCol = db.collection('joinRequests');
  featureLabCol = db.collection('featureLab');
  try {
    await featureLabCol.createIndex({ userId: 1 }, { unique: true });
  } catch (e) { /* index may exist */ }
  // Auto-expire sessions after 30 days
  await sessionsCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

  // Seed default channels if none exist
  const count = await channelsCol.countDocuments();
  if (count === 0) {
    await channelsCol.insertMany(DEFAULT_CHANNELS);
  }

  console.log(`Connected to MongoDB (database: ${MONGODB_DB_NAME})`);
  return true;
}

// ── In-memory fallback (no MongoDB) ──
let memData = {
  users: [],
  channels: JSON.parse(JSON.stringify(DEFAULT_CHANNELS)),
  messages: {},
  /** @type {Record<string, object>} userId -> feature lab doc */
  featureLabThreads: {},
};

// ── Data helpers (work with both Mongo and memory) ──
async function getUsers() {
  if (db) return usersCol.find().toArray();
  return memData.users;
}

async function findUser(query) {
  if (query && query.id === ROBOT_DM_ID) return getRobotDmDocument();
  if (db) return usersCol.findOne(query);
  if (query.username) return memData.users.find(u => u.username === query.username) || null;
  if (query.id) return memData.users.find(u => u.id === query.id) || null;
  if (query.email) return memData.users.find(u => u.email && String(u.email).toLowerCase() === String(query.email).toLowerCase()) || null;
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

async function patchChannel(channelId, updates) {
  if (db) {
    await channelsCol.updateOne({ id: channelId }, { $set: updates });
    return;
  }
  const c = memData.channels.find((x) => x.id === channelId);
  if (c) Object.assign(c, updates);
}

async function removeChannel(channelId) {
  if (!channelId) return;
  if (db) {
    await messagesCol.deleteOne({ channelId });
    await channelsCol.deleteOne({ id: channelId });
    return;
  }
  delete memData.messages[channelId];
  memData.channels = memData.channels.filter((c) => c.id !== channelId);
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

function avatarUrlReferencesFile(url, fileId) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('/api/files/' + fileId);
}

/** Removes msg.file / thread reply attachments matching fileId; returns payload for socket clients. */
async function pruneUploadedFileRefs(fileId) {
  const updates = [];
  if (db) {
    const docs = await messagesCol.find({}).toArray();
    for (const doc of docs) {
      const channelId = doc.channelId;
      const msgs = doc.messages;
      if (!msgs || !msgs.length) continue;
      let docTouched = false;
      for (const m of msgs) {
        if (m.file && m.file.id === fileId) {
          updates.push({ channelId, msgId: m.id });
          delete m.file;
          docTouched = true;
        }
        const tr = m.threadReplies;
        if (tr && Array.isArray(tr)) {
          for (const r of tr) {
            if (r.file && r.file.id === fileId) {
              updates.push({ channelId, msgId: m.id, replyId: r.id });
              delete r.file;
              docTouched = true;
            }
          }
        }
      }
      if (docTouched) await updateMessagesForChannel(channelId, msgs);
    }
  } else {
    const byCh = memData.messages || {};
    for (const channelId of Object.keys(byCh)) {
      const msgs = byCh[channelId];
      if (!msgs || !msgs.length) continue;
      let touched = false;
      for (const m of msgs) {
        if (m.file && m.file.id === fileId) {
          updates.push({ channelId, msgId: m.id });
          delete m.file;
          touched = true;
        }
        const tr = m.threadReplies;
        if (tr && Array.isArray(tr)) {
          for (const r of tr) {
            if (r.file && r.file.id === fileId) {
              updates.push({ channelId, msgId: m.id, replyId: r.id });
              delete r.file;
              touched = true;
            }
          }
        }
      }
      if (touched) await updateMessagesForChannel(channelId, msgs);
    }
  }
  return updates;
}

async function clearAvatarsPointingAtFile(fileId) {
  const usersList = await getUsers();
  for (const u of usersList) {
    if (!avatarUrlReferencesFile(u.avatarUrl, fileId)) continue;
    await updateUser(u.id, { avatarUrl: null });
    const refreshed = await findUser({ id: u.id });
    io.emit('user_updated', { user: publicUser(refreshed) });
  }
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
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    status: u.status,
    statusMsg: u.statusMsg || '',
    role: u.role,
    createdAt: u.createdAt,
    avatarUrl: u.avatarUrl || null,
    featureLabUnlocked: !!u.featureLabUnlocked,
  };
}

/** Admin Users tab: include moderation flags not exposed in publicUser. */
function adminListedUser(u) {
  const pub = publicUser(u);
  if (!pub) return null;
  return { ...pub, banned: !!(u && u.banned), suspended: !!(u && u.suspended) };
}

// ── REST: Auth ──

// Names/usernames blocked from registering or logging in (substring match, case-insensitive)
const BLOCKED_NAMES = [];

// Blocked IPs (populated at runtime from banned users' last known IPs)
const BLOCKED_IPS = new Set();

// ── Brute-force protection ──
// Map: bucket key -> { count, windowStart, lockedUntil } (user login uses ip+username so VPN/NAT exits don’t lock each other out)
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000;   // 10-minute sliding window
const LOCKOUT_MS = 15 * 60 * 1000;  // 15-minute lockout

function checkBruteForce(bucketKey) {
  if (!bucketKey) return null;
  const now = Date.now();
  const rec = loginAttempts.get(bucketKey) || { count: 0, windowStart: now, lockedUntil: 0 };

  if (rec.lockedUntil > now) {
    const secs = Math.ceil((rec.lockedUntil - now) / 1000);
    return `Too many failed attempts. Try again in ${secs} seconds.`;
  }

  // Reset window if it has expired
  if (now - rec.windowStart > WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }

  loginAttempts.set(bucketKey, rec);
  return null; // allowed
}

function recordFailedAttempt(bucketKey) {
  if (!bucketKey) return;
  const now = Date.now();
  const rec = loginAttempts.get(bucketKey) || { count: 0, windowStart: now, lockedUntil: 0 };

  if (now - rec.windowStart > WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }

  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    console.log(`[brute-force] bucket ${bucketKey} locked out for 15 min after ${rec.count} failed attempts`);
  }
  loginAttempts.set(bucketKey, rec);
}

function clearAttempts(bucketKey) {
  if (bucketKey) loginAttempts.delete(bucketKey);
}

function envTruthy(v) {
  return /^1|true|yes$/i.test(String(v == null ? '' : v).trim());
}

/** When true, trust CDN/proxy headers for the real client IP (set on Render, Fly, behind nginx, etc.). */
const TRUST_PROXY = envTruthy(process.env.TRUST_PROXY)
  || envTruthy(process.env.RENDER)
  || !!process.env.FLY_APP_NAME
  || envTruthy(process.env.RAILWAY_ENVIRONMENT)
  || envTruthy(process.env.VERCEL);

function normalizeClientIp(raw) {
  if (raw == null || raw === '') return '';
  let s = String(raw).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

function parseXForwardedFor(val) {
  if (!val || typeof val !== 'string') return [];
  return val.split(',').map((p) => normalizeClientIp(p)).filter(Boolean);
}

/**
 * Best-effort client IP for abuse tracking and moderation.
 * With TRUST_PROXY, prefers headers the edge sets (before client-spoofable XFF when alone).
 * Without it, uses the TCP peer only so arbitrary X-Forwarded-For is ignored.
 */
function getClientIp(req) {
  const direct = normalizeClientIp(req.socket && req.socket.remoteAddress);

  if (TRUST_PROXY) {
    const cf = normalizeClientIp(req.headers['cf-connecting-ip']);
    if (cf) return cf;
    const trueClient = normalizeClientIp(req.headers['true-client-ip']);
    if (trueClient) return trueClient;
    const fly = normalizeClientIp(req.headers['fly-client-ip']);
    if (fly) return fly;
    const realIp = normalizeClientIp(req.headers['x-real-ip']);
    if (realIp) return realIp;
    const chain = parseXForwardedFor(req.headers['x-forwarded-for']);
    if (chain.length) return chain[0];
  }

  return direct;
}

function loginBruteKey(ip, usernameLower) {
  return `login:${ip || 'unknown'}:${usernameLower || '_'}`;
}

function adminBruteKey(ip) {
  return `admin:${ip || 'unknown'}`;
}

// IP block middleware
app.use((req, res, next) => {
  const ip = getClientIp(req);
  if (ip && BLOCKED_IPS.has(ip)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  next();
});

function isBlockedName(username, displayName) {
  const check = (s) => BLOCKED_NAMES.some(b => s.toLowerCase().includes(b));
  return check(username || '') || check(displayName || '');
}

function normalizeEmailInput(e) {
  const t = typeof e === 'string' ? e.trim().toLowerCase() : '';
  return t || '';
}

function isValidEmailFormat(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

function parseMarketingOptIn(body) {
  if (!body || typeof body !== 'object') return false;
  const v = body.marketingEmails ?? body.marketingOptIn;
  if (v === true || v === 1) return true;
  if (typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim())) return true;
  return false;
}

async function findExistingUserByNormalizedEmail(emailNorm) {
  if (!emailNorm) return null;
  if (db) return usersCol.findOne({ email: emailNorm });
  return memData.users.find(u => u.email && String(u.email).toLowerCase() === emailNorm) || null;
}

async function findPendingJoinRequestByEmail(emailNorm) {
  if (!emailNorm) return null;
  const q = { status: 'pending', passwordHash: { $exists: true }, email: emailNorm };
  if (db) return joinRequestsCol.findOne(q);
  return (memData.joinRequests || []).find((r) => r.status === 'pending' && r.passwordHash && r.email === emailNorm);
}

app.post('/api/register', (_req, res) => {
  res.status(403).json({
    error: 'Self-service registration is disabled. Use Request access on the sign-in screen; an administrator must approve each new account.',
  });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);

  if (!username || !password) return res.status(400).json({ error: 'Please fill in all fields.' });

  const uname = username.trim().toLowerCase();
  const bruteKey = loginBruteKey(ip, uname);
  const lockMsg = checkBruteForce(bruteKey);
  if (lockMsg) return res.status(429).json({ error: lockMsg });

  if (username.trim().length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });

  const user = await findUser({ username: uname });
  if (!user) { recordFailedAttempt(bruteKey); return res.status(401).json({ error: 'Invalid username or password.' }); }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) { recordFailedAttempt(bruteKey); return res.status(401).json({ error: 'Invalid username or password.' }); }

  if (user.banned || isBlockedName(user.username, user.name)) {
    BLOCKED_IPS.add(ip);
    await updateUser(user.id, { banned: true, lastIp: ip });
    return res.status(403).json({ error: 'This account has been banned.' });
  }

  if (user.suspended) {
    return res.status(403).json({ error: 'This account has been suspended. Contact your workspace administrator.' });
  }

  // Log the IP for future reference
  if (ip) await updateUser(user.id, { lastIp: ip });
  clearAttempts(bruteKey); // successful login — reset brute-force counter

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
  if (user.banned || isBlockedName(user.username, user.name)) {
    return res.status(403).json({ error: 'This account has been banned.' });
  }
  if (user.suspended) {
    return res.status(403).json({ error: 'This account has been suspended.' });
  }

  const [usersRaw, rawChannels, allMessages] = await Promise.all([getUsers(), getChannels(), getAllMessages()]);
  const users = withRobotDmUserList(usersRaw);

  const channels = rawChannels.filter((ch) => userCanSeeChannel(user.id, ch));
  const visibleIds = new Set(channels.map((c) => c.id));
  const messages = {};
  visibleIds.forEach((cid) => {
    if (allMessages[cid]) messages[cid] = allMessages[cid];
  });

  const liveUsers = users.map(u => {
    const pub = publicUser(u);
    const sockets = activeSocketByUser.get(u.id) || 0;
    const live = sockets > 0;
    let status = u.id === user.id ? 'online' : (live ? 'online' : 'offline');
    if (u.id === ROBOT_DM_ID) status = 'online';
    return { ...pub, status };
  });

  res.json({
    currentUser: { ...publicUser(user), status: 'online' },
    users: liveUsers,
    channels,
    messages,
  });
});

// ── Feature Lab (unlock via UI easter egg; private user ↔ admin collaboration thread)
async function getAuthedBearerUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const user = await getUserByToken(token);
  if (!user) return null;
  if (user.banned || isBlockedName(user.username, user.name)) return null;
  if (user.suspended) return null;
  return user;
}

async function getFeatureLabDoc(userId) {
  if (!userId || userId === ROBOT_DM_ID) return null;
  if (db) return featureLabCol.findOne({ userId });
  return memData.featureLabThreads[userId] || null;
}

async function saveFeatureLabDoc(doc) {
  if (!doc || !doc.userId) return;
  if (db) {
    await featureLabCol.replaceOne({ userId: doc.userId }, doc, { upsert: true });
    return;
  }
  memData.featureLabThreads[doc.userId] = doc;
}

async function ensureFeatureLabThreadInitialized(userId) {
  let doc = await getFeatureLabDoc(userId);
  const now = Date.now();
  if (!doc) {
    doc = {
      userId,
      unlockedAt: now,
      updatedAt: now,
      messages: [{
        from: 'system',
        text: 'Welcome to Feature Lab — a quiet channel with admins. Propose improvements, brainstorm together, or ask for tooling here. Someone on the workspace team will read and reply when they can.',
        ts: now,
      }],
    };
    await saveFeatureLabDoc(doc);
  }
  return doc;
}

function emitFeatureLabUpdated(userId, messagesPayload) {
  try {
    io.to('uid_' + userId).emit('feature_lab_updated', { messages: messagesPayload });
  } catch (e) { /* non-fatal */ }
}

async function appendFeatureLabMessage(userId, msg) {
  let doc = await getFeatureLabDoc(userId);
  if (!doc) return null;
  if (!Array.isArray(doc.messages)) doc.messages = [];
  doc.messages.push(msg);
  doc.updatedAt = Date.now();
  await saveFeatureLabDoc(doc);
  emitFeatureLabUpdated(userId, doc.messages);
  return doc;
}

async function listFeatureLabDocs() {
  if (db) return featureLabCol.find({}).sort({ updatedAt: -1 }).toArray();
  return Object.values(memData.featureLabThreads || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

app.post('/api/feature-lab/unlock', async (req, res) => {
  try {
    const user = await getAuthedBearerUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    await updateUser(user.id, { featureLabUnlocked: true });
    const doc = await ensureFeatureLabThreadInitialized(user.id);
    const fresh = await findUser({ id: user.id });
    res.json({ ok: true, user: publicUser({ ...(fresh || user), status: fresh?.status || user.status }), messages: doc.messages });
  } catch (e) {
    console.error('feature-lab/unlock:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/feature-lab', async (req, res) => {
  try {
    const user = await getAuthedBearerUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const u = await findUser({ id: user.id });
    if (!u || !u.featureLabUnlocked) return res.status(403).json({ error: 'Feature Lab is not available yet.' });
    const doc = await ensureFeatureLabThreadInitialized(user.id);
    res.json({ messages: doc.messages || [] });
  } catch (e) {
    console.error('feature-lab/get:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/feature-lab/message', async (req, res) => {
  try {
    const user = await getAuthedBearerUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const u = await findUser({ id: user.id });
    if (!u || !u.featureLabUnlocked) return res.status(403).json({ error: 'Feature Lab is not available yet.' });

    await ensureFeatureLabThreadInitialized(user.id);
    const text = processOutgoingChatText(String((req.body && req.body.text) || ''), {});
    if (!text.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
    const msg = { from: 'user', userId: user.id, userName: user.name, text, ts: Date.now() };
    const doc = await appendFeatureLabMessage(user.id, msg);
    if (!doc) return res.status(500).json({ error: 'Could not save message.' });
    res.json({ ok: true, messages: doc.messages });
  } catch (e) {
    console.error('feature-lab/message:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/admin/feature-lab', requireAdmin, async (req, res) => {
  try {
    const docs = await listFeatureLabDocs();
    const userList = await getUsers();
    const byId = new Map(userList.map((x) => [x.id, x]));
    const threads = docs.map((d) => {
      const u = byId.get(d.userId);
      const msgs = d.messages || [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      const previewRaw = last ? (last.from === 'user' ? `${last.userName || 'User'}: ${last.text || ''}` : (last.from === 'admin' ? `Admin: ${last.text}` : last.text || '')) : '';
      return {
        userId: d.userId,
        userName: u ? u.name : 'Unknown user',
        username: u ? u.username : '',
        unlockedAt: d.unlockedAt,
        updatedAt: d.updatedAt,
        messageCount: msgs.length,
        lastPreview: String(previewRaw).slice(0, 140),
        lastTs: last ? last.ts : d.updatedAt,
      };
    });
    res.json({ threads });
  } catch (e) {
    console.error('admin feature-lab:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/admin/feature-lab/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const doc = await getFeatureLabDoc(userId);
    if (!doc) return res.status(404).json({ error: 'No Feature Lab thread for this user.' });
    const u = await findUser({ id: userId });
    res.json({ user: publicUser(u) || { id: userId }, doc });
  } catch (e) {
    console.error('admin feature-lab/detail:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/admin/feature-lab/:userId/message', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    let doc = await getFeatureLabDoc(userId);
    if (!doc) {
      doc = await ensureFeatureLabThreadInitialized(userId);
    }
    await updateUser(userId, { featureLabUnlocked: true });
    const text = processOutgoingChatText(String((req.body && req.body.text) || ''), {});
    if (!text.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
    const msg = { from: 'admin', text, ts: Date.now() };
    const saved = await appendFeatureLabMessage(userId, msg);
    if (!saved) return res.status(500).json({ error: 'Could not save message.' });
    res.json({ ok: true, messages: saved.messages });
  } catch (e) {
    console.error('admin feature-lab/message:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

function formatAiContextLine(msg) {
  if (!msg) return null;
  const name = msg.userName || 'Someone';
  const t = String(msg.text || '').trim();
  const bit = t || (msg.file ? '[attachment]' : '');
  if (!bit) return null;
  return `${name}: ${bit}`;
}

/** Draft a chat message via OpenAI. Requires OPENAI_API_KEY. Body: instruction?, replyToLatest?, channelId, threadParentMsgId? */
app.post('/api/ai/draft-message', async (req, res) => {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({
      error: 'AI message help is not enabled on this server (set OPENAI_API_KEY).',
    });
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const instruction = typeof body.instruction === 'string' ? body.instruction : '';
  const replyToLatest = !!body.replyToLatest;
  const channelId = body.channelId;
  const threadParentMsgId = body.threadParentMsgId ? String(body.threadParentMsgId) : null;

  if (!channelId) return res.status(400).json({ error: 'channelId is required.' });

  try {
    if (!(await ensureChannelParticipantAccess(channelId, user.id))) {
      return res.status(403).json({ error: 'You do not have access to this channel.' });
    }
  } catch (e) {
    console.error('draft-message access:', e.message);
    return res.status(500).json({ error: 'Failed to verify channel access.' });
  }

  const ch = await findChannel({ id: channelId }).catch(() => null);
  const isDm = !!(ch && (ch.isDM || String(channelId).startsWith('dm_')));
  const channelLabel = ch ? (isDm ? 'a direct message' : `#${ch.name}`) : 'the channel';

  const msgs = await getMessages(channelId);
  let contextLine = null;
  let threadRootLine = null;

  if (threadParentMsgId) {
    const parent = msgs.find((m) => m.id === threadParentMsgId);
    if (!parent) return res.status(400).json({ error: 'That thread was not found in this channel.' });

    threadRootLine = formatAiContextLine(parent);

    if (replyToLatest) {
      const candidates = [parent, ...(parent.threadReplies || [])];
      const withContent = candidates.map(formatAiContextLine).filter(Boolean);
      if (!withContent.length) {
        return res.status(400).json({ error: 'There is no text to reply to in this thread yet.' });
      }
      const sorted = [...candidates].filter((m) => formatAiContextLine(m)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const latest = sorted[sorted.length - 1];
      contextLine = formatAiContextLine(latest);
    }
  } else if (replyToLatest) {
    const sorted = [...msgs].filter((m) => formatAiContextLine(m)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const latest = sorted[sorted.length - 1];
    contextLine = formatAiContextLine(latest);
    if (!contextLine) {
      return res.status(400).json({ error: 'There are no messages to reply to in this channel yet.' });
    }
  }

  const model = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

  const sysParts = [
    'You help users write short, natural chat messages for a team messaging app.',
    'Output only the message text the user should send: no quotes around it, no "Here is" preamble, markdown only if it fits chat.',
    'Keep it concise unless the user asks for detail.',
    `The user's display name is ${user.name}. They are writing in ${channelLabel}.`,
  ];
  if (threadParentMsgId && threadRootLine) {
    sysParts.push(`This is a reply in a thread that started with: ${threadRootLine}`);
  }
  if (replyToLatest && contextLine) {
    sysParts.push(`They want to respond to the newest message in context: ${contextLine}`);
  }

  const ins = instruction.trim();
  const userMsg =
    ins ||
    (replyToLatest
      ? 'Write an appropriate reply to that message.'
      : threadParentMsgId
        ? 'Write an appropriate reply in this thread.'
        : 'Draft a sensible message for this channel.');

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 55000);
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sysParts.join(' ') },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 600,
        temperature: 0.65,
      }),
    });
    clearTimeout(t);
    if (!r.ok) {
      const errText = await r.text();
      console.error('OpenAI draft-message:', r.status, errText.slice(0, 500));
      return res.status(502).json({ error: 'AI service returned an error. Try again later.' });
    }
    const data = await r.json();
    let draft = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    draft = String(draft).trim().replace(/^["']|["']$/g, '');
    if (!draft) return res.status(502).json({ error: 'AI returned an empty draft.' });
    res.json({ draft });
  } catch (e) {
    console.error('draft-message:', e.message);
    return res.status(502).json({ error: 'Could not reach the AI service. Try again later.' });
  }
});

/** Extra STUN for ICE gathering (TURN still needed for hard NATs). */
const DEFAULT_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },
];

function iceServersFromEnvTurn() {
  const turnUrls = (process.env.TURN_URLS || process.env.TURN_URL || '').trim();
  const tu = (process.env.TURN_USERNAME || process.env.TURN_USER || '').trim();
  const tp = (process.env.TURN_PASSWORD || process.env.TURN_CREDENTIAL || '').trim();
  if (!turnUrls || !tu || !tp) return null;
  const urls = turnUrls.split(',').map(s => s.trim()).filter(Boolean);
  if (!urls.length) return null;
  return { urls, username: tu, credential: tp };
}

/** Metered Open Relay “static auth” secret (public; see https://www.metered.ca/tools/openrelay). Ephemeral username per coturn REST/HMAC. */
function openRelayMeteredEphemeral(userId) {
  if (/^(1|true|yes)$/i.test(process.env.OPEN_RELAY_TURN_DISABLED || '')) return null;
  const secret = (process.env.OPEN_RELAY_TURN_SECRET || 'openrelayprojectsecret').trim();
  const host = (process.env.OPEN_RELAY_TURN_HOST || 'staticauth.openrelay.metered.ca').trim();
  const ttl = parseInt(process.env.OPEN_RELAY_TURN_TTL_SEC || '86400', 10) || 86400;
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:${String(userId || 'u').replace(/:/g, '_').slice(0, 120)}`;
  const credential = crypto.createHmac('sha1', secret).update(username, 'utf8').digest('base64');
  const urls = [
    `turn:${host}:80`,
    `turn:${host}:80?transport=tcp`,
    `turn:${host}:443`,
    `turn:${host}:443?transport=tcp`,
    `turns:${host}:443?transport=tcp`,
  ];
  return { urls, username, credential };
}

async function fetchMeteredTurnCredentials() {
  const apiKey = (process.env.METERED_TURN_API_KEY || '').trim();
  const app = (process.env.METERED_TURN_APPNAME || process.env.METERED_TURN_APP || '').trim();
  if (!apiKey || !app) return null;
  const region = (process.env.METERED_TURN_REGION || '').trim();
  let url = `https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
  if (region) url += `&region=${encodeURIComponent(region)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) && data.length ? data : null;
  } catch (e) {
    console.warn('METERED_TURN fetch failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** WebRTC ICE: optional ICE_SERVERS_JSON override; else Metered API if configured; else Open Relay + STUN + optional env TURN. */
async function buildIceServersForUser(userId) {
  const raw = process.env.ICE_SERVERS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {
      console.warn('ICE_SERVERS_JSON parse error:', e.message);
    }
  }

  const metered = await fetchMeteredTurnCredentials();
  if (metered) {
    const envTurn = iceServersFromEnvTurn();
    return envTurn ? [...metered, envTurn, ...DEFAULT_STUN_SERVERS] : [...metered, ...DEFAULT_STUN_SERVERS];
  }

  const servers = [...DEFAULT_STUN_SERVERS];
  const envTurn = iceServersFromEnvTurn();
  if (envTurn) servers.push(envTurn);
  const openRelay = openRelayMeteredEphemeral(userId);
  if (openRelay) servers.push(openRelay);
  return servers;
}

app.get('/api/ice', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const iceServers = await buildIceServersForUser(user.id);
    res.json({ iceServers });
  } catch (e) {
    console.error('buildIceServersForUser:', e);
    res.json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  }
});

// ── Admin auth (signed Bearer tokens — no server memory; works across restarts / instances) ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'slackflow-admin';
const ADMIN_SIGNING_SECRET = process.env.ADMIN_SESSION_SECRET || ADMIN_PASSWORD;

function createAdminBearerToken() {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 7;
  const payload = `${exp}.${uuidv4()}`;
  const sig = crypto.createHmac('sha256', ADMIN_SIGNING_SECRET).update(payload).digest('hex');
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  return `${b64}.${sig}`;
}

function verifyAdminBearerToken(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const dotSep = raw.lastIndexOf('.');
  if (dotSep <= 0) return false;
  const b64 = raw.slice(0, dotSep);
  const sig = raw.slice(dotSep + 1);
  let payload;
  try {
    payload = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const expectSig = crypto.createHmac('sha256', ADMIN_SIGNING_SECRET).update(payload).digest('hex');
  if (sig.length !== expectSig.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectSig))) return false;
  } catch {
    return false;
  }
  const nonceDot = payload.indexOf('.');
  const expSec = nonceDot === -1 ? NaN : parseInt(payload.slice(0, nonceDot), 10);
  if (!Number.isFinite(expSec)) return false;
  if (Math.floor(Date.now() / 1000) > expSec) return false;
  return true;
}

app.post('/api/admin/login', (req, res) => {
  const ip = getClientIp(req);
  const adminKey = adminBruteKey(ip);
  const lockMsg = checkBruteForce(adminKey);
  if (lockMsg) return res.status(429).json({ error: lockMsg });

  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    recordFailedAttempt(adminKey);
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  clearAttempts(adminKey);
  res.json({ token: createAdminBearerToken() });
});

function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !verifyAdminBearerToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── REST: Join / pending account requests ──

function ensureJrMessages(jr) {
  if (!jr) return jr;
  if (!Array.isArray(jr.messages)) jr.messages = [];
  if (!jr.messages.length && jr.message) {
    jr.messages.push({ from: 'guest', text: String(jr.message), ts: jr.createdAt || Date.now() });
  }
  return jr;
}

async function findPendingRegistrationByUsername(uname) {
  const u = uname.trim().toLowerCase();
  if (db) return await joinRequestsCol.findOne({ username: u, status: 'pending', passwordHash: { $exists: true } });
  return (memData.joinRequests || []).find((r) => r.username === u && r.status === 'pending' && r.passwordHash);
}

function rateLimitCheck(map, bucketKey, max, windowMs) {
  const k = bucketKey && String(bucketKey).trim() ? String(bucketKey).trim() : '__none__';
  const now = Date.now();
  const rec = map.get(k) || { count: 0, windowStart: now };
  if (now - rec.windowStart > windowMs) { rec.count = 0; rec.windowStart = now; }
  if (rec.count >= max) return true;
  rec.count++;
  map.set(k, rec);
  return false;
}

const pendingRegPerIpEmail = new Map();
const pendingRegPerIpCap = new Map();

app.post('/api/register-request', async (req, res) => {
  const ip = getClientIp(req);

  const { name, username, password, email } = req.body;
  const marketingEmails = parseMarketingOptIn(req.body);
  if (!username || !password || !name) return res.status(400).json({ error: 'All fields are required.' });
  const emailNorm = normalizeEmailInput(email);
  if (!emailNorm || !isValidEmailFormat(emailNorm)) return res.status(400).json({ error: 'A valid email address is required.' });
  if (username.trim().length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters.' });

  const uname = username.trim().toLowerCase();
  if (isBlockedName(uname, name)) return res.status(403).json({ error: 'This request cannot be submitted.' });
  if (await findUser({ username: uname })) return res.status(409).json({ error: 'That username is already taken.' });
  if (await findPendingRegistrationByUsername(uname)) return res.status(409).json({ error: 'That username already has a pending request.' });
  if (await findExistingUserByNormalizedEmail(emailNorm)) return res.status(409).json({ error: 'That email is already registered.' });
  if (await findPendingJoinRequestByEmail(emailNorm)) return res.status(409).json({ error: 'That email already has a pending request.' });

  // Prevent display-name impersonation
  const trimmedReqName = name.trim();
  const existingForName = await getUsers();
  if (existingForName.some(u => u.name.toLowerCase() === trimmedReqName.toLowerCase())) {
    return res.status(409).json({ error: 'That display name is already in use. Please choose a different name.' });
  }

  // Count only submissions that passed validation (mistyped fields must not consume the hourly budget).
  // Per-(IP+email) avoids punishing unrelated people on the same VPN/NAT exit; a per-IP cap still limits abuse.
  const ipEmailKey = `${ip}|${emailNorm}`;
  if (rateLimitCheck(pendingRegPerIpEmail, ipEmailKey, 8, 60 * 60 * 1000)) {
    return res.status(429).json({
      error: 'Too many signup attempts for this email from your connection in the last hour. Try again later or contact an administrator.',
    });
  }
  if (rateLimitCheck(pendingRegPerIpCap, ip || '__no_ip__', 24, 60 * 60 * 1000)) {
    return res.status(429).json({
      error: 'Too many join requests from this network in the last hour. Try again later or contact an administrator.',
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const id = 'jr_' + uuidv4().slice(0, 12);
  const pendingToken = uuidv4();
  const ts = Date.now();
  const req_ = {
    id,
    pendingToken,
    name: trimmedReqName,
    username: uname,
    email: emailNorm,
    marketingEmails,
    passwordHash: hash,
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
    submittedIp: ip || null,
  };

  if (db) await joinRequestsCol.insertOne(req_);
  else { if (!memData.joinRequests) memData.joinRequests = []; memData.joinRequests.push(req_); }

  res.json({ ok: true, id, pendingToken });
});

app.get('/api/register-pending/:id/status', async (req, res) => {
  const { id } = req.params;
  const pendingToken = req.query.pendingToken;
  if (!pendingToken) return res.status(400).json({ error: 'Missing token.' });

  let jr;
  if (db) jr = await joinRequestsCol.findOne({ id });
  else jr = (memData.joinRequests || []).find((r) => r.id === id);
  if (!jr || jr.pendingToken !== pendingToken) return res.status(404).json({ error: 'Not found.' });

  if (jr.status === 'denied') return res.json({ status: 'denied' });

  if (jr.status === 'approved' && jr.passwordHash) {
    if (jr.authDeliveryToken) {
      const tok = jr.authDeliveryToken;
      const userId = jr.createdUserId;
      if (db) await joinRequestsCol.updateOne({ id }, { $unset: { authDeliveryToken: '' } });
      else delete jr.authDeliveryToken;
      const user = await findUser({ id: userId });
      if (!user) return res.json({ status: 'pending' });
      return res.json({ status: 'approved', token: tok, user: publicUser(user) });
    }
    return res.json({ status: 'ready_sign_in' });
  }

  return res.json({ status: 'pending' });
});

app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  let requests;
  if (db) requests = await joinRequestsCol.find().sort({ createdAt: -1 }).toArray();
  else requests = (memData.joinRequests || []).slice().reverse();
  requests = requests.map((jr) => {
    ensureJrMessages(jr);
    const pub = { ...jr };
    delete pub.guestToken;
    delete pub.pendingToken;
    delete pub.passwordHash;
    delete pub.authDeliveryToken;
    return pub;
  });
  res.json({ requests });
});

app.delete('/api/admin/requests', requireAdmin, async (req, res) => {
  if (db) await joinRequestsCol.deleteMany({});
  else memData.joinRequests = [];
  res.json({ ok: true });
});

app.post('/api/admin/requests/:id/approve', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let jr;
  if (db) jr = await joinRequestsCol.findOne({ id });
  else jr = (memData.joinRequests || []).find((r) => r.id === id);
  if (!jr) return res.status(404).json({ error: 'Request not found.' });
  if (jr.status !== 'pending') return res.status(400).json({ error: 'Request is not pending.' });

  // Pending account (password on file): create user and deliver session on poll
  if (jr.passwordHash) {
    if (await findUser({ username: jr.username })) {
      return res.status(409).json({ error: 'That username is already registered. Deny this request.' });
    }
    const emailNorm = normalizeEmailInput(jr.email);
    if (!emailNorm || !isValidEmailFormat(emailNorm)) {
      return res.status(400).json({ error: 'This request has no valid email on file. Deny it and ask the applicant to submit a new request with email.' });
    }
    if (await findExistingUserByNormalizedEmail(emailNorm)) {
      return res.status(409).json({ error: 'That email is already registered. Deny this request.' });
    }
    const approvedName = (jr.name || '').trim() || jr.username;
    const approvedAllUsers = await getUsers();
    if (approvedAllUsers.some(u => u.name.toLowerCase() === approvedName.toLowerCase())) {
      return res.status(409).json({ error: 'That display name is already taken. Ask the applicant to choose a different name.' });
    }
    const user = {
      id: 'u_' + uuidv4().slice(0, 10),
      username: jr.username,
      passwordHash: jr.passwordHash,
      name: approvedName,
      email: emailNorm,
      marketingEmails: !!jr.marketingEmails,
      status: 'online',
      role: 'Member',
      createdAt: Date.now(),
      createdIp: jr.submittedIp || null,
      banned: false,
      suspended: false,
    };
    await insertUser(user);
    const token = generateToken();
    tokens.set(token, user.id);
    if (db) await sessionsCol.insertOne({ token, userId: user.id, createdAt: new Date() });
    io.emit('user_joined', { user: publicUser(user) });

    if (db) {
      await joinRequestsCol.updateOne(
        { id },
        { $set: { status: 'approved', authDeliveryToken: token, createdUserId: user.id, updatedAt: Date.now() } },
      );
    } else {
      jr.status = 'approved';
      jr.authDeliveryToken = token;
      jr.createdUserId = user.id;
      jr.updatedAt = Date.now();
    }
    return res.json({ ok: true, accountCreated: true });
  }

  return res.status(400).json({
    error: 'This older chat-only request can no longer be approved with a link. Deny it and ask the person to use “Request access” on the sign-in page instead.',
  });
});

app.post('/api/admin/requests/:id/deny', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let jr;
  if (db) jr = await joinRequestsCol.findOne({ id });
  else jr = (memData.joinRequests || []).find((r) => r.id === id);
  if (!jr) return res.status(404).json({ error: 'Request not found.' });

  if (db) await joinRequestsCol.updateOne({ id }, { $set: { status: 'denied', updatedAt: Date.now() } });
  else {
    jr.status = 'denied';
    jr.updatedAt = Date.now();
  }

  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await getUsers();
  res.json({ users: users.map(adminListedUser).filter(Boolean) });
});

/** Subscribers who opted in to product / marketing email (deduped by normalized email). */
app.get('/api/admin/marketing-emails', requireAdmin, async (req, res) => {
  try {
    const users = await getUsers();
    const seen = new Set();
    const subscribers = [];
    for (const u of users) {
      if (!u.marketingEmails || !u.email) continue;
      const em = String(u.email).toLowerCase().trim();
      if (!em || seen.has(em)) continue;
      seen.add(em);
      subscribers.push({
        email: em,
        name: u.name || '',
        username: u.username || '',
        createdAt: u.createdAt || null,
      });
    }
    subscribers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ count: subscribers.length, subscribers });
  } catch (e) {
    console.error('admin marketing-emails:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await updateUser(id, { banned: true });
  kickSocketsForUser(id, 'This account has been banned.');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  await updateUser(req.params.id, { banned: false });
  res.json({ ok: true });
});

/** Reversible moderation: block sign-in and bootstrap; does not add IPs to the brute-force block list. */
app.post('/api/admin/users/:id/suspend', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await updateUser(id, { suspended: true });
  kickSocketsForUser(id, 'This account has been suspended.');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unsuspend', requireAdmin, async (req, res) => {
  await updateUser(req.params.id, { suspended: false });
  res.json({ ok: true });
});

/** Unban and unsuspend every user, clear derived IP blocks, clear name blocklist (runtime), and reset login lockouts. */
app.post('/api/admin/unban-all', requireAdmin, async (req, res) => {
  try {
    if (db) {
      await usersCol.updateMany({}, { $set: { banned: false, suspended: false } });
    } else {
      for (const u of memData.users) {
        u.banned = false;
        u.suspended = false;
      }
    }
    BLOCKED_IPS.clear();
    BLOCKED_NAMES.length = 0;
    loginAttempts.clear();
    res.json({ ok: true });
  } catch (e) {
    console.error('admin unban-all:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (db) {
    await usersCol.deleteOne({ id });
    await sessionsCol.deleteMany({ userId: id });
  } else {
    memData.users = memData.users.filter(u => u.id !== id);
  }
  activeSocketByUser.delete(id);
  io.emit('user_status', { userId: id, status: 'offline' });
  res.json({ ok: true });
});

/** Admin: group users by creation IP to surface potential duplicate accounts. */
app.get('/api/admin/users/by-ip', requireAdmin, async (req, res) => {
  const users = await getUsers();
  const byIp = {};
  for (const u of users) {
    const ip = u.createdIp || u.lastIp || 'unknown';
    if (!byIp[ip]) byIp[ip] = [];
    byIp[ip].push(publicUser(u));
  }
  // Return only IPs with more than one account (suspicious), sorted by count desc
  const suspicious = Object.entries(byIp)
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([ip, accounts]) => ({
      ip,
      count: accounts.length,
      accounts,
      hint: 'Shared VPN, carrier NAT, or office gateways often put unrelated people on one public IP—treat as a lead, not certainty.',
    }));
  res.json({ suspicious, total: users.length });
});

// ── Admin: Message search & delete ──

app.get('/api/admin/messages/search', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const channelFilter = (req.query.channel || '').trim().toLowerCase();
    if (!q) return res.status(400).json({ error: 'Query parameter q is required.' });

    const [channels, allUsers] = await Promise.all([getChannels(), getUsers()]);
    const userMap = {};
    allUsers.forEach(u => { userMap[u.id] = u.name; });

    const results = [];
    const qLower = q.toLowerCase();

    for (const ch of channels) {
      const isDM = !!ch.isDM;

      // Build a human-readable display name
      let displayName = ch.name;
      if (isDM && Array.isArray(ch.participants) && ch.participants.length === 2) {
        const nameA = userMap[ch.participants[0]] || ch.participants[0];
        const nameB = userMap[ch.participants[1]] || ch.participants[1];
        displayName = `DM: ${nameA} ↔ ${nameB}`;
      }

      // Apply channel filter
      if (channelFilter) {
        if (isDM) {
          // Match against display name, either participant's name, or the raw channel id
          const participantNames = (ch.participants || []).map(id => (userMap[id] || id).toLowerCase());
          const matches =
            displayName.toLowerCase().includes(channelFilter) ||
            participantNames.some(n => n.includes(channelFilter)) ||
            ch.id.toLowerCase().includes(channelFilter) ||
            channelFilter === 'dm';
          if (!matches) continue;
        } else {
          if (ch.name.toLowerCase() !== channelFilter) continue;
        }
      }

      const msgs = await getMessages(ch.id);
      for (const m of msgs) {
        if (results.length >= 100) break;
        const textLower = (m.text || '').toLowerCase();
        if (textLower.includes(qLower)) {
          results.push({
            id: m.id,
            channelId: ch.id,
            channelName: displayName,
            isDM,
            userId: m.userId,
            userName: m.userName || m.userId,
            text: m.text || '',
            ts: m.ts,
            isThreadReply: false,
            parentMsgId: null,
          });
        }
        // Search thread replies
        for (const r of (m.threadReplies || [])) {
          if (results.length >= 100) break;
          const replyTextLower = (r.text || '').toLowerCase();
          if (replyTextLower.includes(qLower)) {
            results.push({
              id: r.id,
              channelId: ch.id,
              channelName: displayName,
              isDM,
              userId: r.userId,
              userName: r.userName || r.userId,
              text: r.text || '',
              ts: r.ts,
              isThreadReply: true,
              parentMsgId: m.id,
            });
          }
        }
      }
      if (results.length >= 100) break;
    }

    results.sort((a, b) => b.ts - a.ts);
    res.json({ messages: results });
  } catch (e) {
    console.error('admin messages/search:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/api/admin/messages/:channelId/:msgId', requireAdmin, async (req, res) => {
  try {
    const { channelId, msgId } = req.params;
    const isThreadReply = req.query.threadReply === 'true';
    const parentMsgId = req.query.parentMsgId || null;

    const msgs = await getMessages(channelId);

    if (isThreadReply && parentMsgId) {
      const parent = msgs.find(m => m.id === parentMsgId);
      if (!parent) return res.status(404).json({ error: 'Parent message not found.' });
      const idx = (parent.threadReplies || []).findIndex(r => r.id === msgId);
      if (idx === -1) return res.status(404).json({ error: 'Thread reply not found.' });
      parent.threadReplies.splice(idx, 1);
    } else {
      const idx = msgs.findIndex(m => m.id === msgId);
      if (idx === -1) return res.status(404).json({ error: 'Message not found.' });
      msgs.splice(idx, 1);
    }

    await updateMessagesForChannel(channelId, msgs);
    io.to(channelId).emit('message_deleted', { channelId, msgId });
    res.json({ ok: true });
  } catch (e) {
    console.error('admin messages/delete:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── Admin: stored uploads (attachments + avatar blobs) ──

function fileDocToPublicMeta(f) {
  if (!f) return null;
  return {
    id: f.id,
    name: f.name || '',
    type: f.type || '',
    size: typeof f.size === 'number' ? f.size : 0,
    uploadedBy: f.uploadedBy || null,
    uploadedAt: f.uploadedAt || 0,
    isAvatar: !!f.isAvatar,
  };
}

app.get('/api/admin/files', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const qRaw = (req.query.q || '').trim().toLowerCase();

    let rows;
    let normalized;
    if (db) {
      rows = await filesCol.find({}).project({ data: 0 }).sort({ uploadedAt: -1 }).limit(2000).toArray();
      normalized = rows.map((raw) => fileDocToPublicMeta(raw));
    } else {
      normalized = Object.values(memData.files || {}).map(fileDocToPublicMeta)
        .filter(Boolean)
        .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
    }

    const allUsers = await getUsers();
    const userMap = {};
    allUsers.forEach((u) => { userMap[u.id] = u.name; });

    normalized = normalized.map((m) => ({
      ...m,
      uploadedByName: (m.uploadedBy && userMap[m.uploadedBy]) || m.uploadedBy || '—',
    }));

    const filtered = !qRaw
      ? normalized
      : normalized.filter((f) =>
        (f.name || '').toLowerCase().includes(qRaw) ||
        (f.id || '').toLowerCase().includes(qRaw) ||
        (f.uploadedByName || '').toLowerCase().includes(qRaw));

    res.json({ files: filtered.slice(0, limit) });
  } catch (e) {
    console.error('admin files/list:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/api/admin/files/:id', requireAdmin, async (req, res) => {
  try {
    const fileId = req.params.id;
    let existed = false;
    if (db) {
      const doc = await filesCol.findOne({ id: fileId }, { projection: { id: 1 } });
      existed = !!doc;
    } else {
      existed = !!(memData.files && memData.files[fileId]);
    }

    if (!existed) return res.status(404).json({ error: 'File not found.' });

    const attachmentUpdates = await pruneUploadedFileRefs(fileId);
    await clearAvatarsPointingAtFile(fileId);

    if (db) await filesCol.deleteOne({ id: fileId });
    else if (memData.files) delete memData.files[fileId];

    if (attachmentUpdates.length) {
      io.emit('message_file_removed', { updates: attachmentUpdates });
    }

    res.json({ ok: true, strippedAttachments: attachmentUpdates.length });
  } catch (e) {
    console.error('admin files/delete:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Serve admin panel (avoid stale tab markup in browsers/CDNs)
function sendAdminPanel(req, res) {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
}
app.get('/admin', sendAdminPanel);
app.get('/admin/', sendAdminPanel);

// ── REST: File upload ──

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const fileId = 'file_' + uuidv4().slice(0, 16);
  const fileDoc = {
    id: fileId,
    name: req.file.originalname,
    type: req.file.mimetype,
    size: req.file.size,
    data: req.file.buffer,
    uploadedBy: user.id,
    uploadedAt: Date.now(),
  };

  if (db) {
    await filesCol.insertOne(fileDoc);
  } else {
    if (!memData.files) memData.files = {};
    memData.files[fileId] = fileDoc;
  }

  res.json({ id: fileId, name: fileDoc.name, type: fileDoc.type, size: fileDoc.size });
});

// ── REST: Profile avatar upload (multipart photo) ──
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

app.post('/api/profile/avatar', avatarUpload.single('file'), async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Only JPEG, PNG, GIF, and WEBP are allowed' });
  }

  const fileId = 'av_' + uuidv4().slice(0, 16);
  const ext = req.file.mimetype.split('/')[1] || 'jpg';
  const fileDoc = {
    id: fileId,
    name: 'avatar.' + ext,
    type: req.file.mimetype,
    size: req.file.size,
    data: req.file.buffer,
    uploadedBy: user.id,
    uploadedAt: Date.now(),
    isAvatar: true,
  };

  if (db) await filesCol.insertOne(fileDoc);
  else { if (!memData.files) memData.files = {}; memData.files[fileId] = fileDoc; }

  const avatarUrl = '/api/files/' + fileId;
  await updateUser(user.id, { avatarUrl });
  const updated = await findUser({ id: user.id });
  io.emit('user_updated', { user: publicUser({ ...updated, avatarUrl }) });
  res.json({ avatarUrl });
});

// ── REST: Profile avatar from data URL (avatar builder) ──
app.post('/api/profile/avatar/dataurl', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { dataUrl } = req.body;
  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid data URL' });
  }

  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid data URL format' });

  const mimeType = match[1];
  let buffer;
  try { buffer = Buffer.from(match[2], 'base64'); } catch { return res.status(400).json({ error: 'Invalid base64 data' }); }

  if (buffer.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 2MB)' });

  const fileId = 'av_' + uuidv4().slice(0, 16);
  const ext = mimeType.split('/')[1] || 'png';
  const fileDoc = {
    id: fileId,
    name: 'avatar.' + ext,
    type: mimeType,
    size: buffer.length,
    data: buffer,
    uploadedBy: user.id,
    uploadedAt: Date.now(),
    isAvatar: true,
  };

  if (db) await filesCol.insertOne(fileDoc);
  else { if (!memData.files) memData.files = {}; memData.files[fileId] = fileDoc; }

  const avatarUrl = '/api/files/' + fileId;
  await updateUser(user.id, { avatarUrl });
  const updated = await findUser({ id: user.id });
  io.emit('user_updated', { user: publicUser({ ...updated, avatarUrl }) });
  res.json({ avatarUrl });
});

// ── REST: Profile name update ──
app.patch('/api/profile/name', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const trimmed = name.trim();

  // Prevent display-name impersonation: reject if another user already has this name
  const allUsersForName = await getUsers();
  if (allUsersForName.some(u => u.id !== user.id && u.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(409).json({ error: 'That display name is already in use.' });
  }

  await updateUser(user.id, { name: trimmed });
  const updated = await findUser({ id: user.id });
  io.emit('user_updated', { user: publicUser(updated) });
  res.json({ user: publicUser(updated) });
});

// ── REST: Profile avatar reset (back to initials) ──
app.delete('/api/profile/avatar', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  await updateUser(user.id, { avatarUrl: null });
  const updated = await findUser({ id: user.id });
  io.emit('user_updated', { user: publicUser(updated) });
  res.json({ user: publicUser(updated) });
});

// ── REST: File serve ──

app.get('/api/files/:id', async (req, res) => {
  let fileDoc;
  if (db) {
    fileDoc = await filesCol.findOne({ id: req.params.id });
  } else {
    fileDoc = (memData.files || {})[req.params.id];
  }
  if (!fileDoc) return res.status(404).json({ error: 'File not found' });

  const buf = Buffer.isBuffer(fileDoc.data) ? fileDoc.data : Buffer.from(fileDoc.data.buffer || fileDoc.data);
  res.setHeader('Content-Type', fileDoc.type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileDoc.name)}"`);
  res.setHeader('Cache-Control', 'public, max-age=31536000');
  res.send(buf);
});

function parseDmPair(dmChannelId) {
  if (!dmChannelId || typeof dmChannelId !== 'string' || !dmChannelId.startsWith('dm_')) return null;
  const inner = dmChannelId.slice(3);
  const m = inner.match(/^(u_[0-9a-f]+)_(u_[0-9a-f]+)$/i);
  if (!m) return null;
  return [m[1], m[2]];
}

// ── Channel visibility (non-DM) ──

/** Workspace-wide channel: everyone logged in sees it; private lists explicit member ids + creator. */
function channelViewerIds(channel) {
  if (!channel || channel.isDM) return null;
  if (!channel.visibility || channel.visibility !== 'private') return null;
  const ids = new Set((Array.isArray(channel.memberIds) ? channel.memberIds : []).filter(Boolean));
  if (channel.createdBy) ids.add(channel.createdBy);
  return ids;
}

function userCanSeeChannel(userId, channel) {
  if (!userId || !channel) return false;
  if (channel.isDM) {
    if (Array.isArray(channel.participants) && channel.participants.length) return channel.participants.includes(userId);
    const parts = parseDmPair(channel.id);
    return !!(parts && parts.includes(userId));
  }
  const viewers = channelViewerIds(channel);
  if (!viewers) return true;
  return viewers.has(userId);
}

async function enumerateUserIdsPreviouslyCouldSee(nonDmChannelDoc) {
  if (!nonDmChannelDoc || nonDmChannelDoc.isDM) return new Set();
  const viewers = channelViewerIds(nonDmChannelDoc);
  if (!viewers) return new Set((await getUsers()).map((u) => u.id));
  return viewers;
}

async function userIdsLostChannelAccess(previousNonDmDoc, updatedChannelDoc) {
  const had = await enumerateUserIdsPreviouslyCouldSee(previousNonDmDoc);
  const now = updatedChannelDoc && !updatedChannelDoc.isDM
    ? channelViewerIds(updatedChannelDoc)
    : null;
  const nowSet = now || new Set((await getUsers()).map((u) => u.id));
  return [...had].filter((id) => !nowSet.has(id));
}

function broadcastChannelCreated(io, channel) {
  const payload = { channel };
  const viewers = channelViewerIds(channel);
  if (!viewers) io.emit('channel_created', payload);
  else [...viewers].forEach((uid) => io.to('uid_' + uid).emit('channel_created', payload));
}

/**
 * Delivers new_message to the channel room and, for private channels, each viewer's
 * uid_* room so clients still receive if they momentarily miss the channel room.
 * Client dedups by message id if both paths arrive.
 */
async function emitNewMessagePayload(io, channelId, payload, channelDocMaybe) {
  io.to(channelId).emit('new_message', payload);
  let ch = channelDocMaybe;
  if (!ch) {
    try {
      ch = await findChannel({ id: channelId });
    } catch (_) {
      ch = null;
    }
  }
  const viewers = ch ? channelViewerIds(ch) : null;
  if (viewers && viewers.size) {
    for (const uid of viewers) {
      if (uid === ROBOT_DM_ID) continue;
      io.to('uid_' + uid).emit('new_message', payload);
    }
  }
}

async function ensureChannelParticipantAccess(channelId, userId) {
  if (!channelId || !userId) return false;
  if (channelId.startsWith('dm_')) {
    const dmCh = await findChannel({ id: channelId });
    if (!dmCh) return false;
    if (Array.isArray(dmCh.participants) && !dmCh.participants.includes(userId)) return false;
    return true;
  }
  const ch = await findChannel({ id: channelId });
  return !!(ch && userCanSeeChannel(userId, ch));
}

// ── Socket.IO ──
/** Live socket count per userId (authenticated connections). DB status can go stale; this is source of truth for "online". */
const activeSocketByUser = new Map();

/** Disconnect authenticated sockets after ban/suspend so the client cannot keep chatting. */
function kickSocketsForUser(userId, authErrorMessage) {
  if (!userId) return;
  const msg = authErrorMessage || 'Session ended.';
  for (const [, sock] of io.sockets.sockets) {
    if (sock.sfUserId !== userId) continue;
    try { sock.emit('auth_error', msg); } catch (_) { /* noop */ }
    try { sock.disconnect(true); } catch (_) { /* noop */ }
  }
}

async function assertWebRtcRelay(channelId, fromUserId, toUserId) {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return false;
  const ch = await findChannel({ id: channelId });
  if (!ch) return false;
  if (ch.isDM) {
    // Prefer the authoritative participants array stored on the channel document.
    if (Array.isArray(ch.participants) && ch.participants.length) {
      return ch.participants.includes(fromUserId) && ch.participants.includes(toUserId);
    }
    // Fallback: parse the two user IDs out of the channel ID.
    const parts = parseDmPair(channelId);
    if (!parts || !parts.includes(fromUserId) || !parts.includes(toUserId)) return false;
    return true;
  }
  const u1 = await findUser({ id: fromUserId });
  const u2 = await findUser({ id: toUserId });
  return !!(u1 && u2 && userCanSeeChannel(fromUserId, ch) && userCanSeeChannel(toUserId, ch));
}

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('authenticate', async (token) => {
    currentUser = await getUserByToken(token);
    if (!currentUser) { socket.emit('auth_error', 'Invalid token'); return; }
    if (currentUser.banned || isBlockedName(currentUser.username, currentUser.name)) {
      socket.emit('auth_error', 'This account has been banned.');
      return;
    }
    if (currentUser.suspended) {
      socket.emit('auth_error', 'This account has been suspended.');
      return;
    }

    const uid = currentUser.id;
    const prevSockets = activeSocketByUser.get(uid) || 0;
    activeSocketByUser.set(uid, prevSockets + 1);

    await updateUser(uid, { status: 'online' });
    currentUser.status = 'online';

    socket.join('uid_' + uid);

    // Join channel rooms user is allowed to read (respects private channels).
    try {
      const allChannels = await getChannels();
      const ok = allChannels.filter((ch) => userCanSeeChannel(uid, ch));
      await Promise.all(ok.map((ch) => socket.join(ch.id)));
    } catch (e) { /* non-fatal */ }

    socket.sfUserId = uid;

    socket.emit('authenticated', { user: publicUser(currentUser) });
    if (prevSockets === 0) {
      socket.broadcast.emit('user_status', { userId: uid, status: 'online' });
    }
  });

  socket.on('join_channel', async (channelId) => {
    if (!currentUser || !channelId) return;
    try {
      if (!(await ensureChannelParticipantAccess(channelId, currentUser.id))) return;
    } catch (e) { return; }
    try {
      await socket.join(channelId);
    } catch (e) {
      console.error('join_channel:', e.message);
    }
  });
  socket.on('leave_channel', (channelId) => { socket.leave(channelId); });

  socket.on('send_message', async ({ channelId, text, file }) => {
    if (!currentUser || (!text?.trim() && !file) || !channelId) return;

    try {
      if (!(await ensureChannelParticipantAccess(channelId, currentUser.id))) return;
    } catch (e) { console.error('DB error (send_message access):', e.message); return; }

    let skipChatNormalize = false;
    let chSnap = null;
    try {
      chSnap = await findChannel({ id: channelId });
      skipChatNormalize = !!(chSnap && chSnap.ddGame);
    } catch (_) { /* non-fatal */ }

    try {
      await socket.join(channelId);
    } catch (e) {
      console.error('socket.join(channel):', e.message);
    }

    const msg = {
      id: 'msg_' + uuidv4().slice(0, 12),
      userId: currentUser.id,
      userName: currentUser.name,
      text: processOutgoingChatText(text || '', { skipChatNormalize }),
      file: file || null,
      ts: Date.now(),
      reactions: {},
      threadReplies: [],
    };

    try {
      await emitNewMessagePayload(io, channelId, { channelId, message: msg }, chSnap);
    } catch (e) {
      console.error('emit new_message:', e.message);
    }
    try { await appendMessage(channelId, msg); } catch (e) { console.error('DB write error (send_message):', e.message); }
    scheduleRobotDmReply(io, channelId, currentUser.id, text || '', chSnap);
  });

  socket.on('thread_reply', async ({ channelId, parentMsgId, text }) => {
    if (!currentUser || !text?.trim() || !channelId) return;

    try {
      if (!(await ensureChannelParticipantAccess(channelId, currentUser.id))) return;

      const msgs = await getMessages(channelId);
      const parent = msgs.find(m => m.id === parentMsgId);
      if (!parent) return;

      let skipChatNormalize = false;
      let chSnap = null;
      try {
        chSnap = await findChannel({ id: channelId });
        skipChatNormalize = !!(chSnap && chSnap.ddGame);
      } catch (_) { /* non-fatal */ }

      try {
        await socket.join(channelId);
      } catch (e) {
        console.error('socket.join(thread_reply):', e.message);
      }

      const reply = {
        id: 'reply_' + uuidv4().slice(0, 12),
        userId: currentUser.id,
        userName: currentUser.name,
        text: processOutgoingChatText(text, { skipChatNormalize }),
        ts: Date.now(),
      };

      if (!parent.threadReplies) parent.threadReplies = [];
      parent.threadReplies.push(reply);
      await updateMessagesForChannel(channelId, msgs);
      io.to(channelId).emit('thread_reply', { channelId, parentMsgId, reply });
      scheduleRobotDmReply(io, channelId, currentUser.id, text, chSnap);
    } catch (e) { console.error('DB error (thread_reply):', e.message); }
  });

  socket.on('reaction', async ({ channelId, msgId, emoji }) => {
    if (!currentUser || !channelId) return;

    try {
      if (!(await ensureChannelParticipantAccess(channelId, currentUser.id))) return;

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
    if (!currentUser || !channelId) return;

    try {
      if (!(await ensureChannelParticipantAccess(channelId, currentUser.id))) return;

      const msgs = await getMessages(channelId);
      const idx = msgs.findIndex(m => m.id === msgId && m.userId === currentUser.id);
      if (idx === -1) return;

      msgs.splice(idx, 1);
      await updateMessagesForChannel(channelId, msgs);
      io.to(channelId).emit('message_deleted', { channelId, msgId });
    } catch (e) { console.error('DB error (delete_message):', e.message); }
  });

  socket.on('create_channel', async ({ name, topic, visibility, memberIds }) => {
    if (!currentUser || !name?.trim()) return;

    try {
      const slug = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!slug) return;
      if (await findChannel({ name: slug })) { socket.emit('error_msg', 'Channel already exists'); return; }

      const isPrivate = visibility === 'private';
      let mids = [];
      if (isPrivate) {
        const allU = withRobotDmUserList(await getUsers());
        const ok = new Set(allU.map((u) => u.id));
        mids = (Array.isArray(memberIds) ? memberIds : []).filter((id) => typeof id === 'string' && ok.has(id));
        if (!mids.includes(currentUser.id)) mids.push(currentUser.id);
      }

      const channel = {
        id: 'c_' + uuidv4().slice(0, 8),
        name: slug,
        topic: (topic || '').trim(),
        createdBy: currentUser.id,
        visibility: isPrivate ? 'private' : 'workspace',
        memberIds: isPrivate ? mids : [],
      };

      await insertChannel(channel);
      broadcastChannelCreated(io, channel);
    } catch (e) { console.error('DB error (create_channel):', e.message); }
  });

  socket.on('start_dd_session', async ({ dmUserId, adventurerIds }) => {
    if (!currentUser || !dmUserId) return;
    try {
      const dm = await findUser({ id: dmUserId });
      if (!dm) {
        socket.emit('error_msg', 'Could not find that DM.');
        return;
      }
      const allU = withRobotDmUserList(await getUsers());
      const validIds = new Set(allU.map((u) => u.id));

      const members = new Set([currentUser.id, dmUserId]);
      const advList = Array.isArray(adventurerIds) ? adventurerIds : [];
      for (const id of advList) {
        if (typeof id === 'string' && validIds.has(id)) members.add(id);
      }

      const slugBase = uuidv4().replace(/-/g, '').slice(0, 10);
      const slug = `dungeons-dragons-${slugBase}`;
      if (await findChannel({ name: slug })) return;

      const channel = {
        id: 'c_' + uuidv4().slice(0, 12),
        name: slug,
        topic:
          `D&D tabletop — DM: ${dm.name}. Invite-only session; host or DM can end it to remove this channel.`,
        createdBy: currentUser.id,
        visibility: 'private',
        memberIds: [...members],
        ddGame: true,
        ddDmUserId: dmUserId,
        ddStartedByUserId: currentUser.id,
      };

      await insertChannel(channel);
      broadcastChannelCreated(io, channel);
      if (dmUserId === ROBOT_DM_ID) {
        setTimeout(() => { void emitRobotDmWelcome(io, channel.id); }, 400);
      }
    } catch (e) {
      console.error('DB error (start_dd_session):', e.message);
    }
  });

  socket.on('end_dd_session', async ({ channelId }) => {
    if (!currentUser || !channelId) return;
    try {
      const ch = await findChannel({ id: channelId });
      if (!ch || !ch.ddGame || ch.isDM) return;
      const uid = currentUser.id;
      if (uid !== ch.ddStartedByUserId && uid !== ch.ddDmUserId) {
        socket.emit('error_msg', 'Only the session host or the DM can end the game.');
        return;
      }
      const viewers = channelViewerIds(ch);
      await removeChannel(channelId);
      try {
        const socks = await io.in(channelId).fetchSockets();
        for (const s of socks) s.leave(channelId);
      } catch (_) { /* non-fatal */ }

      const notify = viewers || new Set();
      [...notify].forEach((rid) => io.to('uid_' + rid).emit('channel_access_revoked', { channelId }));
    } catch (e) {
      console.error('DB error (end_dd_session):', e.message);
    }
  });

  socket.on('update_channel_visibility', async ({ channelId, visibility, memberIds }) => {
    if (!currentUser || !channelId) return;
    try {
      const prev = await findChannel({ id: channelId });
      if (!prev || prev.isDM || prev.ddGame) return;
      if (prev.createdBy !== currentUser.id) {
        socket.emit('error_msg', 'Only the channel creator can change visibility.');
        return;
      }

      const isPrivate = visibility === 'private';
      let mids = [];
      if (isPrivate) {
        const allU = withRobotDmUserList(await getUsers());
        const ok = new Set(allU.map((u) => u.id));
        mids = (Array.isArray(memberIds) ? memberIds : []).filter((id) => typeof id === 'string' && ok.has(id));
        if (!mids.includes(currentUser.id)) mids.push(currentUser.id);
      }

      const updates = {
        visibility: isPrivate ? 'private' : 'workspace',
        memberIds: isPrivate ? mids : [],
      };
      await patchChannel(channelId, updates);
      const next = { ...prev, ...updates };

      const revoked = await userIdsLostChannelAccess(prev, next);
      for (const rid of revoked) {
        io.to('uid_' + rid).emit('channel_access_revoked', { channelId });
        try {
          const socks = await io.in(channelId).fetchSockets();
          for (const s of socks) {
            if (s.sfUserId === rid) s.leave(channelId);
          }
        } catch (_) { /* non-fatal */ }
      }

      const viewers = channelViewerIds(next);
      if (!viewers) io.emit('channel_updated', { channel: next });
      else [...viewers].forEach((uid2) => io.to('uid_' + uid2).emit('channel_updated', { channel: next }));
    } catch (e) { console.error('DB error (update_channel_visibility):', e.message); }
  });

  socket.on('open_dm', async ({ targetUserId }) => {
    if (!currentUser) return;
    if (targetUserId === ROBOT_DM_ID) {
      socket.emit('error_msg', 'Robot DM is for D&D channels only, not direct messages.');
      return;
    }

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

  socket.on('typing', async ({ channelId }) => {
    if (!currentUser || !channelId) return;
    try {
      if (!(await ensureChannelParticipantAccess(channelId, currentUser.id))) return;
    } catch (e) { return; }
    socket.to(channelId).emit('user_typing', { channelId, userId: currentUser.id, userName: currentUser.name });
  });

  socket.on('webrtc_relay', async ({ toUserId, channelId, dmChannelId, type, sdp, candidate, iceDone }) => {
    const chId = channelId || dmChannelId;
    if (!currentUser || !toUserId || !chId) return;
    const okTypes = new Set(['offer', 'answer', 'ice', 'hangup', 'decline']);
    if (!okTypes.has(type)) return;
    try {
      if (!(await assertWebRtcRelay(chId, currentUser.id, toUserId))) return;
    } catch {
      return;
    }
    const out = {
      fromUserId: currentUser.id,
      channelId: chId,
      type,
      sdp: sdp || undefined,
    };
    if (candidate !== undefined && candidate !== null) out.candidate = candidate;
    if (iceDone === true) out.iceDone = true;
    io.to('uid_' + toUserId).emit('webrtc_peer', out);
  });

  socket.on('update_profile', async ({ name, statusMsg }) => {
    if (!currentUser) return;
    try {
      const updates = {};
      if (name?.trim()) {
        const newName = name.trim();
        // Prevent display-name impersonation
        const allUsersProf = await getUsers();
        const conflict = allUsersProf.find(u => u.id !== currentUser.id && u.name.toLowerCase() === newName.toLowerCase());
        if (conflict) {
          socket.emit('error_msg', 'That display name is already in use.');
          return;
        }
        updates.name = newName;
      }
      updates.statusMsg = (statusMsg || '').trim();
      await updateUser(currentUser.id, updates);
      Object.assign(currentUser, updates);
      io.emit('user_updated', { user: publicUser(currentUser) });
    } catch (e) { console.error('DB error (update_profile):', e.message); }
  });

  socket.on('disconnect', async () => {
    if (!currentUser) return;
    const uid = currentUser.id;
    const prev = activeSocketByUser.get(uid) || 0;
    const next = Math.max(0, prev - 1);
    if (next === 0) {
      activeSocketByUser.delete(uid);
      try {
        await updateUser(uid, { status: 'offline' });
      } catch (e) { console.error('DB error (disconnect):', e.message); }
      io.emit('user_status', { userId: uid, status: 'offline' });
    } else {
      activeSocketByUser.set(uid, next);
    }
  });
});

/**
 * Comprehensive alphabetical list of explicit words to filter from chat messages.
 * Includes profanity, slurs, sexual terms, drug refs, and offensive slang along with
 * common variations (-s, -es, -ed, -er, -ers, -ing, -in, -y).
 * Short entries (<4 chars) are matched only as exact words; longer entries also match
 * spaced-out / dotted obfuscations like "f u c k", "s.h.i.t", "b-i-t-c-h".
 */
const EXPLICIT_WORDS = [
  'anal','analed','analing','anally','analsex','anus','anuses','arse','arsebag','arsebags',
  'arsebandit','arsebandits','arsed','arsefuck','arsefucked','arsefucker','arsefuckers','arsefucking','arsefucks','arsehat',
  'arsehats','arsehead','arseheads','arsehole','arseholes','arses','arsewipe','arsewipes','ass','assbag',
  'assbags','assbang','assbanged','assbanger','assbangers','assbanging','assbangs','assbreath','assclown','assclowns',
  'asscock','asscocks','asscrack','asscracker','asscrackers','asscracks','assdick','assdicks','assed','asses',
  'assface','assfaces','assfuck','assfucked','assfucker','assfuckers','assfucking','assfucks','assgoblin','assgoblins',
  'asshat','asshats','asshattery','asshead','assheads','asshole','assholery','assholes','assholish','asslick',
  'asslicked','asslicker','asslickers','asslicking','asslicks','asslover','asslovers','assmaster','assmasters','assmonkey',
  'assmonkeys','assmunch','assmuncher','assmunchers','assmunches','assmunching','asspirate','asspirates','assplay','asspuppies',
  'asspuppy','assram','assrammer','assrammers','assramming','assrams','asssucker','asssuckers','asswad','asswads',
  'asswagon','asswagons','asswipe','asswiped','asswiper','asswipers','asswipes','asswiping','autoerotic','autoerotism',
  'ballbag','ballbags','ballsack','ballsacks','ballsucker','ballsuckers','bastard','bastardly','bastards','beaner',
  'beaners','beaver','beavers','biatch','biatches','bigot','bigotry','bigots','bimbo','bimbos',
  'bint','bints','bitch','bitchass','bitchasses','bitched','bitcher','bitchers','bitches','bitchier',
  'bitchiest','bitchin','bitching','bitchtits','bitchy','blowjob','blowjobs','blumpkin','blumpkins','bollock',
  'bollocks','boner','boners','boob','boobies','boobs','booby','bukkake','bullshit','bullshits',
  'bullshitted','bullshitter','bullshitters','bullshitting','bunghole','bungholes','butt','buttbang','buttbanged','buttbanger',
  'buttbangers','buttbanging','buttbangs','buttcheek','buttcheeks','buttface','buttfaces','buttfuck','buttfucked','buttfucker',
  'buttfuckers','buttfucking','buttfucks','butthead','buttheads','butthole','buttholes','buttmunch','buttmuncher','buttmunchers',
  'buttmunches','buttmunching','buttplug','buttplugs',
  'camwhore','camwhores','carpetmuncher','carpetmunchers','chickenfucker','chickenfuckers','chinaman','chinamen','chink','chinks',
  'choad','choads','chode','chodes','chuff','chuffer','chuffers','chuffing','chuffs','circlejerk',
  'circlejerks','clit','clitfuck','clitfucked','clitfucker','clitfuckers','clitfucking','clitfucks','clitoris','clitorises',
  'clits','clitties','clitty','clusterfuck','clusterfucks','cock','cockass','cockasses','cockbag','cockbags',
  'cockblock','cockblocked','cockblocker','cockblockers','cockblocking','cockblocks','cockboy','cockboys','cockface','cockfaces',
  'cockfucker','cockfuckers','cockhead','cockheads','cockknob','cockknobs','cockmaster','cockmasters','cockmonkey','cockmonkeys',
  'cockmonster','cockmonsters','cockmunch','cockmuncher','cockmunchers','cockmunching','cocknose','cocknoses','cocknut','cocknuts',
  'cockpipe','cockpipes','cocks','cocksmith','cocksmiths','cocksniffer','cocksniffers','cocksuck','cocksucked','cocksucker',
  'cocksuckers','cocksucking','cocksucks','cockwaffle','cockwaffles','coochie','coochies','coon','coonass','coonasses',
  'coons','cooter','cooters','cornhole','cornholed','cornholes','cornholing','crackbabies','crackbaby','crackhead',
  'crackheads','crackho','crackhoes','crackhouse','crackhouses','crackwhore','crackwhores','crap','crapped','crapper',
  'crappers','crappier','crappiest','crapping','crappy','craps','creampie','creampied','creampieing','creampies',
  'cretin','cretins','crotch','crotchrocket','crotchrockets','cum','cumbag','cumbags','cumbubble','cumbubbles',
  'cumdumpster','cumdumpsters','cumguzzler','cumguzzlers','cumjockey','cumjockeys','cummed','cumming','cums','cumshot',
  'cumshots','cumslut','cumsluts','cumstain','cumstains','cumtart','cumtarts','cunilingus','cunnilingus','cunt',
  'cuntbag','cuntbags','cuntface','cuntfaces','cuntfuck','cuntfucker','cuntfuckers','cuntfucking','cunthole','cuntholes',
  'cunthunter','cunthunters','cuntlick','cuntlicker','cuntlickers','cuntlicking','cuntlicks','cuntmuncher','cuntmunchers','cuntmunching',
  'cunts','cuntsicle','cuntsicles','cuntspaz','cuntspazzes',
  'dammit','damn','damned','damning','damnit','damns','darkie','darkies','deepthroat','deepthroated',
  'deepthroater','deepthroaters','deepthroating','deepthroats','dick','dickbag','dickbags','dickbeater','dickbeaters','dickbeating',
  'dickface','dickfaces','dickfuck','dickfucked','dickfucker','dickfuckers','dickfucking','dickfucks','dickhead','dickheads',
  'dickhole','dickholes','dickjuice','dickjuices','dickless','dicklick','dicklicker','dicklickers','dicklicking','dicklicks',
  'dickmonger','dickmongers','dicks','dickslap','dickslapper','dickslappers','dickslapping','dickslaps','dicksuck','dicksucker',
  'dicksuckers','dicksucking','dicksucks','dickwad','dickwads','dickweasel','dickweasels','dickweed','dickweeds','dickwod',
  'dickwods','dildo','dildos','dink','dinks','dipshit','dipshits','dipstick','dipsticks','doggie',
  'doggystyle','doggystyles','dong','dongs','dookie','dookies','douche','douchebag','douchebags','douched',
  'douches','douchewaffle','douchewaffles','douchey','douching','dumbass','dumbasses','dumbcunt','dumbcunts','dumbfuck',
  'dumbfucks','dumbshit','dumbshits','dumbtwat','dumbtwats','dyke','dykes',
  'ejaculate','ejaculated','ejaculates','ejaculating','ejaculation','ejaculations','ejaculator','ejaculators','erect','erected',
  'erecting','erection','erections','erects','erotic','erotica','erotically','erotism',
  'fag','fagbag','fagbags','fagdom','fagged','fagging','faggit','faggity','faggot','faggotcock',
  'faggotcocks','faggotry','faggots','faggoty','fags','fagtard','fagtards','fannies','fanny','fap',
  'fapped','fapper','fappers','fapping','faps','fartbag','fartbags','farted','farter','farters',
  'fartface','fartfaces','farting','fartknocker','fartknockers','farts','fatass','fatasses','felch','felched',
  'felcher','felchers','felches','felching','fellatio','feltch','feltcher','feltchers','feltching','fingerbang',
  'fingerbanged','fingerbanger','fingerbangers','fingerbanging','fingerbangs','fingerfuck','fingerfucked','fingerfucker','fingerfuckers','fingerfucking',
  'fingerfucks','fistfuck','fistfucked','fistfucker','fistfuckers','fistfucking','fistfucks','fooker','fookers','fookin',
  'fooking','footfuck','footfucked','footfucker','footfuckers','footfucking','footfucks','frigger','friggers','frigging',
  'fuck','fuckable','fucked','fucker','fuckers','fuckface','fuckfaces','fuckhead','fuckheads','fuckhole',
  'fuckholes','fuckin','fucking','fuckings','fuckme','fuckmeat','fucknugget','fucknuggets','fuckoff','fuckoffs',
  'fucks','fuckstick','fucksticks','fucktard','fucktards','fucktwat','fucktwats','fuckup','fuckups','fuckwad',
  'fuckwads','fuckwhit','fuckwhits','fuckwit','fuckwits','fudgepacker','fudgepackers','fugly',
  'gangbang','gangbanged','gangbanger','gangbangers','gangbanging','gangbangs','gayass','gayasses','gaybob','gaybobs',
  'gayboy','gayboys','gaycock','gaycocks','gayfuck','gayfucker','gayfuckers','gayfucking','gayfucks','gaylord',
  'gaylords','gaytard','gaytards','gaywad','gaywads','gigolo','gigolos','godcursed','goddam','goddammit',
  'goddamn','goddamned','goddamning','goddamnit','goddamns','gook','gooks','gringo','gringos',
  'handjob','handjobs','hardon','hardons','hell','hellbent','hellish','hentai','hermaphrodite','hermaphrodites',
  'heshe','heshes','hick','hicks','hillbillies','hillbilly','hitler','hitlers','hoe','hoer',
  'hoers','hoes','homo','homoerotic','homos','homosexual','homosexuality','homosexuals','hooker','hookers',
  'hornbag','hornbags','horny','horseshit','horseshits','hotbox','hotboxed','hotboxes','hotboxing','hump',
  'humped','humper','humpers','humping','humps',
  'incest','intercourse',
  'jackass','jackasses','jackoff','jackoffs','jagoff','jagoffs','jailbait','jailbaits','jap','japs',
  'jerkoff','jerkoffs','jigaboo','jigaboos','jissom','jissoms','jiz','jizm','jizz','jizzed',
  'jizzes','jizzing','jizzy',
  'kike','kikes','killyourself','knob','knobend','knobends','knobhead','knobheads','knobjocky','knobs',
  'kooch','kootch','kraut','krauts','kunt','kunts','kyke','kykes',
  'labia','labias','lardass','lardasses','lesbo','lesbos','libtard','libtards','limpdick','limpdicks',
  'livesex','lubejob','lubejobs',
  'mafucker','mafuckers','masochist','masochists','masturbate','masturbated','masturbater','masturbaters','masturbates','masturbating',
  'masturbation','masturbations','meth','methhead','methheads','midget','midgets','milf','milfs','minge',
  'minger','minges','mof','mofo','mofos','molest','molested','molester','molesters','molesting',
  'molests','mong','mongoloid','mongoloids','mongs','moolie','moolies','moron','morons','motherfuck',
  'motherfucked','motherfucker','motherfuckers','motherfuckin','motherfucking','motherfucks','muff','muffdive','muffdived','muffdiver',
  'muffdivers','muffdives','muffdiving','muffs','muthafucka','muthafuckas','muthafucker','muthafuckers','muthafucking',
  'nads','nazi','nazis','necrophiliac','negro','negroes','nig','nigga','niggas','nigger',
  'niggered','niggering','niggers','niglet','niglets','nimrod','nimrods','nip','nipple','nipples',
  'nips','nob','nobhead','nobheads','nobs','nonce','nonces','numbnut','numbnuts','nutsack',
  'nutsacks','nutter','nutters',
  'oral','organ','organs','orgasm','orgasmed','orgasmic','orgasming','orgasms','orgies','orgy',
  'paedo','paedophile','paedophiles','paedos','paki','pakis','panooch','panties','panty','pecker',
  'peckerhead','peckerheads','peckers','pedo','pedophile','pedophiles','pedophilia','pedos','penis','penises',
  'perv','perve','perved','perversion','perversions','pervert','perverted','perves','pervo','pervos',
  'pervs','piss','pissed','pisser','pissers','pisses','pissflaps','pissing','pissoff','pissy',
  'polack','polacks','poof','poofs','pooftah','poofter','poofters','poon','poons','poontang',
  'poontangs','poop','pooper','poopers','poopface','poopfaces','pooping','poops','poopy','porchmonkey',
  'porchmonkeys','porn','porno','pornographic','pornography','pornos','prick','pricked','pricking','pricks',
  'prig','prigs','pron','prons','prostitute','prostitutes','pube','pubes','punani','punanis',
  'punannies','punany','punta','puntas','pussies','pussy','pussyfart','pussyfarts','pussylicker','pussylickers',
  'pussylicking','pussylicks','pussylover','pussylovers','pussypounder','pussypounders',
  'queef','queefed','queefing','queefs','queer','queerbait','queerbaits','queerbo','queerbos','queers',
  'quim',
  'racism','racist','racists','raghead','ragheads','randy','rape','raped','raper','rapers',
  'rapes','raping','rapist','rapists','rectum','rectums','redneck','rednecks','retard','retarded',
  'retards','rimjob','rimjobs',
  'sandnigger','sandniggers','scag','scags','scank','scanks','schlong','schlongs','screw','screwed',
  'screwing','screws','scromp','scrotum','scrotums','scumbag','scumbags','semen','semens','sexcam',
  'sexcams','sexed','sexes','sexist','sexists','sexpot','sexpots','sextape','sextapes','sexually',
  'sexy','shag','shagged','shagger','shaggers','shagging','shags','shemale','shemales','shit',
  'shitass','shitasses','shitbag','shitbags','shitbird','shitbirds','shitblimp','shitblimps','shitbrain','shitbrains',
  'shitbreath','shitcanned','shitcunt','shitcunts','shitdick','shitdicks','shiteater','shiteaters','shited','shites',
  'shitey','shitface','shitfaced','shitfaces','shitforbrains','shitfuck','shitfucker','shitfuckers','shitfucking','shitfucks',
  'shitfull','shithead','shitheads','shithole','shitholes','shithouse','shithouses','shitkicker','shitkickers','shitload',
  'shitloads','shitlord','shitlords','shitmuncher','shitmunchers','shits','shitspitter','shitstain','shitstains','shitstick',
  'shitstorm','shitstorms','shitter','shitters','shittier','shittiest','shittin','shitting','shitty','shitwhore',
  'shiz','shizz','shizzle','sissy','skank','skanks','skanky','sleaze','sleazebag','sleazebags',
  'sleazes','slut','slutbag','slutbags','slutface','slutfaces','sluts','slutty','smegma','smut',
  'smuts','snatch','snatches','sodom','sodomite','sodomites','sodomize','sodomized','sodomizes','sodomizing',
  'spaz','spazz','spazzed','spazzes','spazzing','spazzy','sperm','sperms','spic','spicks',
  'spics','spook','spooks','spunk','spunks','stripper','strippers','stupidass','stupidasses','suckass',
  'taintlicker','taintlickers','tampon','tampons','tard','tards','teabag','teabagged','teabagger','teabaggers',
  'teabagging','teabags','testicle','testicles','threesome','threesomes','throating','tit','titbag','titbags',
  'titfuck','titfucked','titfucker','titfuckers','titfucking','titfucks','tits','tittie','titties','titty',
  'tittyfuck','tittyfucked','tittyfucker','tittyfuckers','tittyfucking','tittyfucks','tonguefuck','tonguefucks','toolbag','toolbags',
  'tosser','tossers','towelhead','towelheads','tramp','tramps','trannies','tranny','trashbag','trashbags',
  'turd','turdface','turdfaces','turds','twat','twatface','twatfaces','twathead','twatheads','twatlip',
  'twatlips','twats','twatwaffle','twatwaffles','twink','twinkie','twinkies','twinks',
  'unclefucker','unclefuckers','urinate',
  'vagina','vaginal','vaginas','vibrator','vibrators','vulva',
  'wank','wanked','wanker','wankers','wanking','wankjob','wankjobs','wanks','wankstain','wankstains',
  'wanky','wedgie','wedgies','wetback','wetbacks','whore','whored','whoreface','whorefaces','whorehouse',
  'whorehouses','whores','whoring','whorish','wigger','wiggers','wiggery','willies','willy','wog',
  'wogs','wop','wops',
  'xrated','xxx',
  'yobbo','yobs',
  'zoophile','zoophilia',
];

/**
 * Compiled regex that matches any explicit word, including spaced-out obfuscations
 * (e.g. "f u c k", "s.h.i.t", "b-i-t-c-h"). Built once at module load for speed.
 * Word-boundary anchored so we don't match inside legitimate words ("hello", "class", etc).
 * Spaced detection only applies to entries with 4+ characters to avoid over-matching short words.
 */
const _EXPLICIT_REGEX = (() => {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = '[\\s._\\-]+';
  const byLengthDesc = (a, b) => b.length - a.length;
  const direct = EXPLICIT_WORDS.slice().sort(byLengthDesc).map(escape).join('|');
  const spaced = EXPLICIT_WORDS
    .filter((w) => w.length >= 4)
    .sort(byLengthDesc)
    .map((w) => w.split('').map(escape).join(sep))
    .join('|');
  return new RegExp(`\\b(?:${direct}|${spaced})\\b`, 'gi');
})();

function filterExplicit(text) {
  if (!text) return text;
  return text.replace(_EXPLICIT_REGEX, (match) => '*'.repeat(match.length));
}

/** Slash easter egg: /roll-dN for N in {2,3,4,6,8,10,12,20,100} (case-insensitive). */
function expandPolyhedralRollEasterEgg(rawTrimmed) {
  const t = (rawTrimmed || '').trim();
  const m = /^\/roll-d(\d+)$/i.exec(t);
  if (!m) return null;
  const sides = parseInt(m[1], 10);
  const allowed = new Set([2, 3, 4, 6, 8, 10, 12, 20, 100]);
  if (!allowed.has(sides)) {
    return '🎒 That die isn’t in the SlackFlow pouch. Use /roll-d2, d3, d4, d6, d8, d10, d12, d20, or d100.';
  }

  if (sides === 2) {
    const heads = Math.random() < 0.5;
    return heads
      ? '🪙 D2 → Heads — The coin chooses violence (for good).'
      : '🪙 D2 → Tails — Probability shrugs.';
  }

  const n = 1 + Math.floor(Math.random() * sides);
  const core = `🎲 D${sides} → ${n}`;
  let tag = '';
  if (n === 1) {
    const low = {
      3: ' — Minimal triangle.',
      4: ' — Pyramid point-first. Ouch.',
      6: ' — The one dot stares into your soul.',
      8: ' — Basement of the octahedron.',
      10: ' — Single-digit despair.',
      12: ' — Even the d12 pities this roll.',
      20: ' — …how?',
      100: ' — Natural “please no” on percentile.',
    };
    tag = low[sides] || '';
  } else if (n === sides) {
    const high = {
      3: ' — Tri-corner crit (for very small dragons).',
      4: ' — Apex predator.',
      6: ' — Boxcars energy.',
      8: ' — Peak octahedron.',
      10: ' — Maximum single digit.',
      12: ' — The d12 actually mattered!',
      20: ' — Natural twenty! SlackFlow nerds rejoice.',
      100: ' — 💯 on the percentile. Legend.',
    };
    tag = high[sides] || '';
  }
  return core + tag;
}

const ROBOT_DM_WELCOME_TEXT = "🤖 **Robot DM** is online. Type **/robot** for prompts, mention **Robot DM** for a nudge, or ask the table a question—I'll chime in sometimes. Have fun!";
const ROBOT_DM_PROMPTS = [
  'What does your character notice first in this beat?',
  'Does the party press forward, flank, negotiate, or improvise?',
  'Name one sense-smell sound texture-and build the room from there.',
  'Who speaks first—and what stakes are they protecting?',
];
const ROBOT_DM_NUDGES = [
  'Still here—keep scenes moving with “what do you try?” followed by narration.',
  'If someone stalls, bounce to another PC: What would you sacrifice to succeed here?',
];
const ROBOT_DM_QUESTION_RSP = [
  'Good question—the table chooses; anchor the answer to a flaw, bond, or goal.',
  'Let dice or consensus decide—then describe how it bends the fiction.',
];

function robotDmPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function emitRobotDmWelcome(io, channelId) {
  if (!channelId) return;
  const botMsg = {
    id: 'msg_' + uuidv4().slice(0, 12),
    userId: ROBOT_DM_ID,
    userName: 'Robot DM',
    text: ROBOT_DM_WELCOME_TEXT,
    file: null,
    ts: Date.now(),
    reactions: {},
    threadReplies: [],
  };
  let ch = null;
  try {
    ch = await findChannel({ id: channelId });
  } catch (_) { /* non-fatal */ }
  try {
    await emitNewMessagePayload(io, channelId, { channelId, message: botMsg }, ch);
  } catch (e) {
    console.error('emit robot welcome:', e.message);
  }
  try {
    await appendMessage(channelId, botMsg);
  } catch (e) {
    console.error('robot_dm_welcome:', e.message);
  }
}

function normalizeRobotTriggerText(raw) {
  return (raw || '')
    .replace(/\uFEFF/g, '')
    .replace(/\u200B/g, '')
    .replace(/\u2060/g, '')
    .replace(/\uFF0F/g, '/')
    .trim();
}

function scheduleRobotDmReply(io, channelId, fromUserId, rawText, channelSnap) {
  if (!channelId || !fromUserId || fromUserId === ROBOT_DM_ID) return;

  const t = normalizeRobotTriggerText(rawText);
  const lowered = t.toLowerCase();
  let reply = null;
  if (/^\s*\/robot\b/i.test(t)) reply = robotDmPick(ROBOT_DM_PROMPTS);
  else if (lowered.includes('robot dm')) reply = robotDmPick(ROBOT_DM_NUDGES);
  else if (/\?\s*$/.test(t) && Math.random() < 0.32) reply = robotDmPick(ROBOT_DM_QUESTION_RSP);

  if (!reply) return;

  const delayMs = 480 + Math.floor(Math.random() * 720);
  setTimeout(async () => {
    try {
      let ch = channelSnap && String(channelSnap.id) === String(channelId) ? channelSnap : null;
      if (!ch) ch = await findChannel({ id: channelId });
      if (!ch || !ch.ddGame || String(ch.ddDmUserId) !== String(ROBOT_DM_ID)) return;

      const botMsg = {
        id: 'msg_' + uuidv4().slice(0, 12),
        userId: ROBOT_DM_ID,
        userName: 'Robot DM',
        text: reply,
        file: null,
        ts: Date.now(),
        reactions: {},
        threadReplies: [],
      };
      await emitNewMessagePayload(io, channelId, { channelId, message: botMsg }, ch);
      await appendMessage(channelId, botMsg);
    } catch (e) {
      console.error('robot_dm_reply:', e.message);
    }
  }, delayMs);
}

function processOutgoingChatText(raw, options) {
  const t = (raw || '').trim();
  if (!t) return t;
  const rolled = expandPolyhedralRollEasterEgg(t);
  if (rolled) return rolled;
  const skipNorm = options && options.skipChatNormalize;
  const body = skipNorm ? t : normalizeChatText(t);
  return filterExplicit(body);
}

// ── Cleanup orphaned messages (from deleted users) ──
async function loadBlockedIps() {
  if (!db) return;
  const banned = await usersCol.find({ banned: true }).toArray();
  banned.forEach(u => { if (u.lastIp) BLOCKED_IPS.add(u.lastIp); });

  // Also block IPs of name-blocked users who have logged in before
  const nameBlocked = await usersCol.find().toArray();
  nameBlocked.filter(u => isBlockedName(u.username, u.name)).forEach(u => {
    if (u.lastIp) BLOCKED_IPS.add(u.lastIp);
  });

  if (BLOCKED_IPS.size) console.log(`Loaded ${BLOCKED_IPS.size} blocked IP(s).`);
}

async function cleanupOrphanedMessages() {
  if (!db) return 0;
  const allUsers = await getUsers();
  const validIds = new Set(allUsers.map(u => u.id));
  validIds.add(ROBOT_DM_ID);

  const msgDocs = await messagesCol.find().toArray();
  let removed = 0;

  for (const doc of msgDocs) {
    const before = (doc.messages || []).length;
    const cleaned = (doc.messages || [])
      .filter(m => validIds.has(m.userId))
      .map(m => ({
        ...m,
        threadReplies: (m.threadReplies || []).filter(r => validIds.has(r.userId)),
      }));
    if (cleaned.length !== before) {
      removed += before - cleaned.length;
      await messagesCol.updateOne({ channelId: doc.channelId }, { $set: { messages: cleaned } });
    }
  }

  console.log(`Cleanup: removed ${removed} orphaned message(s).`);
  return removed;
}

// Admin endpoint — POST /api/admin/cleanup
app.post('/api/admin/cleanup', requireAdmin, async (req, res) => {
  const removed = await cleanupOrphanedMessages();
  res.json({ removed });
});

// ── Start ──
connectDB().then(async () => {
  await loadBlockedIps();
  await cleanupOrphanedMessages();
  server.listen(PORT, () => {
    console.log(`SlackFlow server running on http://localhost:${PORT}`);
    console.log(`[http] Client IP: TRUST_PROXY=${TRUST_PROXY ? 'on (edge headers)' : 'off (socket peer only; set TRUST_PROXY=1 behind your own reverse proxy)'}`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  server.listen(PORT, () => {
    console.log(`SlackFlow server running on http://localhost:${PORT} (in-memory mode)`);
    console.log(`[http] Client IP: TRUST_PROXY=${TRUST_PROXY ? 'on (edge headers)' : 'off (socket peer only; set TRUST_PROXY=1 behind your own reverse proxy)'}`);
  });
});
