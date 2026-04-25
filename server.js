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

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://maxvbuda.github.io',
  'https://messaging-website-6qqt.onrender.com',
];

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
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
/** Database name in the cluster (override with MONGODB_DB). Defaults to slackflow. */
const MONGODB_DB_NAME = process.env.MONGODB_DB || 'slackflow';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://maxvbuda.github.io/messaging-website/').replace(/\/?$/, '/');

// ── Middleware ──
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
let usersCol, channelsCol, messagesCol, sessionsCol, filesCol, invitesCol, joinRequestsCol;

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
  db = client.db(MONGODB_DB_NAME);
  usersCol = db.collection('users');
  channelsCol = db.collection('channels');
  messagesCol = db.collection('messages');
  sessionsCol = db.collection('sessions');
  filesCol = db.collection('files');
  invitesCol = db.collection('invites');
  joinRequestsCol = db.collection('joinRequests');
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
  return { id: u.id, name: u.name, username: u.username, status: u.status, statusMsg: u.statusMsg || '', role: u.role, createdAt: u.createdAt };
}

// ── Invite helpers ──

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function findInvite(code) {
  const upper = code.trim().toUpperCase();
  if (db) return invitesCol.findOne({ code: upper, used: false });
  return (memData.invites || []).find(i => i.code === upper && !i.used) || null;
}

async function markInviteUsed(code, userId) {
  const upper = code.trim().toUpperCase();
  if (db) {
    await invitesCol.updateOne({ code: upper }, { $set: { used: true, usedBy: userId, usedAt: Date.now() } });
    return;
  }
  const inv = (memData.invites || []).find(i => i.code === upper);
  if (inv) { inv.used = true; inv.usedBy = userId; }
}

async function createInvite(createdBy) {
  const code = generateInviteCode();
  const inv = { code, createdBy, createdAt: Date.now(), used: false };
  if (db) await invitesCol.insertOne(inv);
  else { if (!memData.invites) memData.invites = []; memData.invites.push(inv); }
  return code;
}

// ── REST: Invite generate ──
app.post('/api/invite/generate', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const code = await createInvite(user.id);
  res.json({ code });
});

// ── REST: Invite list (own invites) ──
app.get('/api/invite/list', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  let invites;
  if (db) invites = await invitesCol.find({ createdBy: user.id }).sort({ createdAt: -1 }).toArray();
  else invites = (memData.invites || []).filter(i => i.createdBy === user.id);
  res.json({ invites: invites.map(i => ({ code: i.code, used: i.used, createdAt: i.createdAt })) });
});

// ── REST: Auth ──

// Names/usernames blocked from registering or logging in (substring match, case-insensitive)
const BLOCKED_NAMES = [];

// Blocked IPs (populated at runtime from banned users' last known IPs)
const BLOCKED_IPS = new Set();

// ── Brute-force protection ──
// Map: ip -> { count, windowStart, lockedUntil }
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000;   // 10-minute sliding window
const LOCKOUT_MS = 15 * 60 * 1000;  // 15-minute lockout

function checkBruteForce(ip) {
  if (!ip) return null;
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, windowStart: now, lockedUntil: 0 };

  if (rec.lockedUntil > now) {
    const secs = Math.ceil((rec.lockedUntil - now) / 1000);
    return `Too many failed attempts. Try again in ${secs} seconds.`;
  }

  // Reset window if it has expired
  if (now - rec.windowStart > WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }

  loginAttempts.set(ip, rec);
  return null; // allowed
}

function recordFailedAttempt(ip) {
  if (!ip) return;
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, windowStart: now, lockedUntil: 0 };

  if (now - rec.windowStart > WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
  }

  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    console.log(`[brute-force] IP ${ip} locked out for 15 min after ${rec.count} failed attempts`);
  }
  loginAttempts.set(ip, rec);
}

function clearAttempts(ip) {
  if (ip) loginAttempts.delete(ip);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || '').trim();
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

app.post('/api/register', async (req, res) => {
  const { username, password, name, inviteCode } = req.body;

  if (!username || !password || !name) return res.status(400).json({ error: 'All fields are required.' });
  if (username.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters.' });

  // Require invite code (skip only if no users exist yet — first account bootstraps)
  const existingUsers = await getUsers();
  if (existingUsers.length > 0) {
    if (!inviteCode) return res.status(403).json({ error: 'An invite code is required to register.' });
    const invite = await findInvite(inviteCode);
    if (!invite) return res.status(403).json({ error: 'Invalid or already-used invite code.' });
  }

  const uname = username.trim().toLowerCase();

  if (isBlockedName(uname, name)) {
    const ip = getClientIp(req);
    if (ip) BLOCKED_IPS.add(ip);
    return res.status(403).json({ error: 'This account cannot be created.' });
  }
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
  if (inviteCode) await markInviteUsed(inviteCode, user.id);

  const token = generateToken();
  tokens.set(token, user.id);
  if (db) await sessionsCol.insertOne({ token, userId: user.id, createdAt: new Date() });

  io.emit('user_joined', { user: publicUser(user) });
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);

  const lockMsg = checkBruteForce(ip);
  if (lockMsg) return res.status(429).json({ error: lockMsg });

  if (!username || !password) return res.status(400).json({ error: 'Please fill in all fields.' });

  const uname = username.trim().toLowerCase();
  const user = await findUser({ username: uname });
  if (!user) { recordFailedAttempt(ip); return res.status(401).json({ error: 'Invalid username or password.' }); }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) { recordFailedAttempt(ip); return res.status(401).json({ error: 'Invalid username or password.' }); }

  if (user.banned || isBlockedName(user.username, user.name)) {
    BLOCKED_IPS.add(ip);
    await updateUser(user.id, { banned: true, lastIp: ip });
    return res.status(403).json({ error: 'This account has been banned.' });
  }

  // Log the IP for future reference
  if (ip) await updateUser(user.id, { lastIp: ip });
  clearAttempts(ip); // successful login — reset brute-force counter

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

  const liveUsers = users.map(u => {
    const pub = publicUser(u);
    const sockets = activeSocketByUser.get(u.id) || 0;
    const live = sockets > 0;
    const status = u.id === user.id ? 'online' : (live ? 'online' : 'offline');
    return { ...pub, status };
  });

  res.json({
    currentUser: { ...publicUser(user), status: 'online' },
    users: liveUsers,
    channels,
    messages,
  });
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

// ── Admin auth ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'slackflow-admin';
const adminTokens = new Set();

app.post('/api/admin/login', (req, res) => {
  const ip = getClientIp(req);
  const lockMsg = checkBruteForce(ip);
  if (lockMsg) return res.status(429).json({ error: lockMsg });

  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  clearAttempts(ip);
  const token = uuidv4();
  adminTokens.add(token);
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !adminTokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
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

function buildInviteUrl(code, jr) {
  let u = FRONTEND_URL + '?invite=' + encodeURIComponent(code);
  if (jr.name && jr.name !== 'Applicant') u += '&name=' + encodeURIComponent(jr.name);
  const uname = jr.username && !String(jr.username).startsWith('pending_') ? jr.username : '';
  if (uname) u += '&username=' + encodeURIComponent(uname);
  return u;
}

async function findPendingRegistrationByUsername(uname) {
  const u = uname.trim().toLowerCase();
  if (db) return await joinRequestsCol.findOne({ username: u, status: 'pending', passwordHash: { $exists: true } });
  return (memData.joinRequests || []).find((r) => r.username === u && r.status === 'pending' && r.passwordHash);
}

function rateLimitCheck(map, ip, max, windowMs) {
  if (!ip) return null;
  const now = Date.now();
  const rec = map.get(ip) || { count: 0, windowStart: now };
  if (now - rec.windowStart > windowMs) { rec.count = 0; rec.windowStart = now; }
  if (rec.count >= max) return true;
  rec.count++;
  map.set(ip, rec);
  return false;
}

const pendingRegAttempts = new Map();

app.post('/api/register-request', async (req, res) => {
  const ip = getClientIp(req);
  if (rateLimitCheck(pendingRegAttempts, ip, 3, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { name, username, password } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'All fields are required.' });
  if (username.trim().length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters.' });

  const uname = username.trim().toLowerCase();
  if (isBlockedName(uname, name)) return res.status(403).json({ error: 'This request cannot be submitted.' });
  if (await findUser({ username: uname })) return res.status(409).json({ error: 'That username is already taken.' });
  if (await findPendingRegistrationByUsername(uname)) return res.status(409).json({ error: 'That username already has a pending request.' });

  const hash = await bcrypt.hash(password, 10);
  const id = 'jr_' + uuidv4().slice(0, 12);
  const pendingToken = uuidv4();
  const ts = Date.now();
  const req_ = {
    id,
    pendingToken,
    name: name.trim(),
    username: uname,
    passwordHash: hash,
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
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
    const user = {
      id: 'u_' + uuidv4().slice(0, 10),
      username: jr.username,
      passwordHash: jr.passwordHash,
      name: (jr.name || '').trim() || jr.username,
      status: 'online',
      role: 'Member',
      createdAt: Date.now(),
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

  // Legacy chat-style request: issue invite link only
  const code = await createInvite('admin');
  ensureJrMessages(jr);
  const url = buildInviteUrl(code, jr);
  const linkMsg = { from: 'admin', text: `You're approved. Create your account with this link:\n${url}`, ts: Date.now() };

  if (db) {
    await joinRequestsCol.updateOne(
      { id },
      {
        $set: { status: 'approved', inviteCode: code, updatedAt: Date.now() },
        $push: { messages: linkMsg },
      },
    );
  } else {
    jr.status = 'approved';
    jr.inviteCode = code;
    ensureJrMessages(jr);
    jr.messages.push(linkMsg);
    jr.updatedAt = Date.now();
  }

  res.json({ code });
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
  res.json({ users: users.map(publicUser) });
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  await updateUser(req.params.id, { banned: true });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  await updateUser(req.params.id, { banned: false });
  res.json({ ok: true });
});

/** Unban every user, clear derived IP blocks, clear name blocklist (runtime), and reset login lockouts. */
app.post('/api/admin/unban-all', requireAdmin, async (req, res) => {
  try {
    if (db) {
      await usersCol.updateMany({}, { $set: { banned: false } });
    } else {
      for (const u of memData.users) u.banned = false;
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

app.get('/api/admin/invites', requireAdmin, async (req, res) => {
  let invites;
  if (db) invites = await invitesCol.find().sort({ createdAt: -1 }).toArray();
  else invites = (memData.invites || []).slice().reverse();
  res.json({ invites: invites.map(i => ({ code: i.code, used: i.used, createdAt: i.createdAt })) });
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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

// ── Socket.IO ──
/** Live socket count per userId (authenticated connections). DB status can go stale; this is source of truth for "online". */
const activeSocketByUser = new Map();

function parseDmPair(dmChannelId) {
  if (!dmChannelId || typeof dmChannelId !== 'string' || !dmChannelId.startsWith('dm_')) return null;
  const parts = dmChannelId.slice(3).split('_');
  if (parts.length !== 2) return null;
  return parts;
}

async function assertWebRtcRelay(channelId, fromUserId, toUserId) {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return false;
  const ch = await findChannel({ id: channelId });
  if (!ch) return false;
  if (ch.isDM) {
    const parts = parseDmPair(channelId);
    if (!parts || !parts.includes(fromUserId) || !parts.includes(toUserId)) return false;
    if (Array.isArray(ch.participants) && ch.participants.length) {
      return ch.participants.includes(fromUserId) && ch.participants.includes(toUserId);
    }
    return true;
  }
  const u1 = await findUser({ id: fromUserId });
  const u2 = await findUser({ id: toUserId });
  return !!(u1 && u2);
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

    const uid = currentUser.id;
    const prevSockets = activeSocketByUser.get(uid) || 0;
    activeSocketByUser.set(uid, prevSockets + 1);

    await updateUser(uid, { status: 'online' });
    currentUser.status = 'online';

    socket.join('uid_' + uid);

    // Auto-join all non-DM channels so messages are always received
    try {
      const allChannels = await getChannels();
      allChannels.forEach(ch => { if (!ch.isDM) socket.join(ch.id); });
    } catch (e) { /* non-fatal */ }

    socket.emit('authenticated', { user: publicUser(currentUser) });
    if (prevSockets === 0) {
      socket.broadcast.emit('user_status', { userId: uid, status: 'online' });
    }
  });

  socket.on('join_channel', (channelId) => { if (currentUser) socket.join(channelId); });
  socket.on('leave_channel', (channelId) => { socket.leave(channelId); });

  socket.on('send_message', async ({ channelId, text, file }) => {
    if (!currentUser || (!text?.trim() && !file)) return;

    const msg = {
      id: 'msg_' + uuidv4().slice(0, 12),
      userId: currentUser.id,
      userName: currentUser.name,
      text: (text || '').trim(),
      file: file || null,
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
        userName: currentUser.name,
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
      if (name?.trim()) updates.name = name.trim();
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
app.post('/api/admin/cleanup', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const removed = await cleanupOrphanedMessages();
  res.json({ removed });
});

// ── Start ──
connectDB().then(async () => {
  await loadBlockedIps();
  await cleanupOrphanedMessages();
  server.listen(PORT, () => {
    console.log(`SlackFlow server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  server.listen(PORT, () => {
    console.log(`SlackFlow server running on http://localhost:${PORT} (in-memory mode)`);
  });
});
