/* ========================================
   SlackFlow — Client
   Connects to remote backend via Socket.IO.
   Set BACKEND_URL below after deploying the server.
   ======================================== */

(function () {
  'use strict';

  // ┌─────────────────────────────────────────────┐
  // │  SET THIS to your deployed server URL        │
  // │  e.g. 'https://slackflow.onrender.com'       │
  // │  Leave empty '' to use localStorage fallback  │
  // └─────────────────────────────────────────────┘
  const BACKEND_URL = 'https://messaging-website-6qqt.onrender.com';

  const useServer = !!BACKEND_URL;

  // ── Theme ──
  const THEMES = ['dark', 'midnight', 'forest', 'sunset', 'rose', 'light'];

  function applyTheme(theme) {
    if (!THEMES.includes(theme)) theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? '' : theme);
    localStorage.setItem('sf_theme', theme);
    document.querySelectorAll('.theme-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.theme === theme);
    });
  }

  applyTheme(localStorage.getItem('sf_theme') || 'dark');

  // ── Helpers ──
  const COLORS = [
    '#6c5ce7','#00b894','#e17055','#0984e3','#d63031',
    '#e84393','#fdcb6e','#00cec9','#6ab04c','#eb4d4b',
    '#7ed6df','#f0932b','#c44569','#574b90','#78e08f',
  ];

  function colorFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return COLORS[Math.abs(h) % COLORS.length];
  }

  function initials(name) {
    return name.split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const EMOJIS = [
    '😀','😂','🥹','😍','🤩','😎','🥳','😤','🔥','💯',
    '❤️','👍','👎','👏','🙌','🤝','✅','❌','⭐','💡',
    '🚀','🎉','🎯','💬','📌','📎','🔗','🏆','🧠','👀',
    '💪','🫡','🤔','😅','🫠','🤖','✨','🌟','💎','🪄',
    '📝','💻','🐛','⚡','🔧','🎨','📊','📈','🛡️','🧪',
  ];

  // ── In-memory data ──
  let currentUser = null;
  let authToken = localStorage.getItem('sf_token') || null;
  let users = [];
  let channels = [];
  let messages = {};
  let activeChannelId = 'c_general';
  let activeThreadMsgId = null;
  let socket = null;

  // ── localStorage fallback (when no server) ──
  function lsLoad(key, fb) { try { return JSON.parse(localStorage.getItem(key)) || fb; } catch { return fb; } }
  function lsSave(key, d) { localStorage.setItem(key, JSON.stringify(d)); }

  let bc;
  try { bc = new BroadcastChannel('slackflow_sync'); } catch { bc = null; }
  function broadcast(type, payload) {
    if (bc && !useServer) bc.postMessage({ type, payload, senderId: currentUser ? currentUser.id : null });
  }

  function lsGetUsers() { return lsLoad('sf_users', []); }
  function lsSaveUsers(a) { lsSave('sf_users', a); }
  function lsGetChannels() {
    return lsLoad('sf_channels', [
      { id: 'c_general', name: 'general', topic: 'Company-wide announcements and work-based matters', createdBy: 'system' },
      { id: 'c_random', name: 'random', topic: 'Non-work banter and water cooler conversation', createdBy: 'system' },
    ]);
  }
  function lsSaveChannels(a) { lsSave('sf_channels', a); }
  function lsGetAllMessages() { return lsLoad('sf_messages', {}); }
  function lsSaveAllMessages(o) { lsSave('sf_messages', o); }
  function lsGetChannelMessages(chId) { return lsGetAllMessages()[chId] || []; }
  function lsAppendMessage(chId, msg) { const a = lsGetAllMessages(); if (!a[chId]) a[chId] = []; a[chId].push(msg); lsSaveAllMessages(a); }
  function lsUpdateMessages(chId, msgs) { const a = lsGetAllMessages(); a[chId] = msgs; lsSaveAllMessages(a); }

  // ── DOM refs ──
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const authScreen = $('#authScreen');
  const authForm = $('#authForm');
  const authUsername = $('#authUsername');
  const authPassword = $('#authPassword');
  const authName = $('#authName');
  const authNameField = $('#authNameField');
  const authError = $('#authError');
  const authSubmitBtn = $('#authSubmitBtn');
  const authToggleLink = $('#authToggleLink');
  const authToggleText = $('#authToggleText');
  const authSubtitle = $('#authSubtitle');
  const appWrapper = $('#appWrapper');
  const channelListEl = $('#channelList');
  const dmListEl = $('#dmList');
  const messagesListEl = $('#messagesList');
  const messagesContainer = $('#messagesContainer');
  const messageInput = $('#messageInput');
  const headerChannelName = $('#headerChannelName');
  const headerTopic = $('#headerTopic');
  const memberCount = $('#memberCount');
  const typingIndicator = $('#typingIndicator');
  const typingText = $('#typingText');
  const threadPanel = $('#threadPanel');
  const threadMessagesEl = $('#threadMessages');
  const threadInput = $('#threadInput');
  const threadChannel = $('#threadChannel');
  const memberPanel = $('#memberPanel');
  const memberListEl = $('#memberList');
  const emojiPicker = $('#emojiPicker');
  const emojiGrid = $('#emojiGrid');
  const emojiSearchEl = $('#emojiSearch');
  const searchInput = $('#searchInput');
  const searchResults = $('#searchResults');
  const searchResultsInner = $('#searchResultsInner');
  const sidebarEl = $('#sidebar');
  const sidebarOverlay = $('#sidebarOverlay');

  let isRegisterMode = false;
  let pendingFile = null; // file waiting to be sent with next message

  // ── File upload ──
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function isImage(type) { return type && type.startsWith('image/'); }
  function isVideo(type) { return type && type.startsWith('video/'); }

  function fileUrl(id) { return BACKEND_URL + '/api/files/' + id; }

  function renderFileAttachment(file) {
    if (!file) return '';
    if (isImage(file.type)) {
      return `<div class="file-attachment img-attachment">
        <a href="${fileUrl(file.id)}" target="_blank">
          <img src="${fileUrl(file.id)}" alt="${escHtml(file.name)}" class="inline-image" loading="lazy">
        </a>
      </div>`;
    }
    if (isVideo(file.type)) {
      return `<div class="file-attachment">
        <video src="${fileUrl(file.id)}" controls class="inline-video"></video>
      </div>`;
    }
    const ext = file.name.split('.').pop().toUpperCase().slice(0, 4);
    return `<div class="file-attachment">
      <div class="file-icon"><span class="file-ext">${escHtml(ext)}</span></div>
      <div class="file-info">
        <a class="file-name" href="${fileUrl(file.id)}" target="_blank" download="${escHtml(file.name)}">${escHtml(file.name)}</a>
        <div class="file-size">${formatFileSize(file.size)}</div>
      </div>
    </div>`;
  }

  function setPendingFile(file) {
    pendingFile = file;
    const preview = $('#filePreview');
    if (file) {
      preview.innerHTML = `<span class="file-pill">📎 ${escHtml(file.name)} <span class="file-pill-size">${formatFileSize(file.size)}</span><button class="file-pill-remove" id="filePillRemove">✕</button></span>`;
      preview.style.display = '';
      $('#filePillRemove').addEventListener('click', () => { pendingFile = null; preview.style.display = 'none'; preview.innerHTML = ''; $('#fileInput').value = ''; });
    } else {
      preview.style.display = 'none';
      preview.innerHTML = '';
    }
  }

  async function uploadFile(fileObj) {
    if (!useServer) return null;
    const form = new FormData();
    form.append('file', fileObj);
    try {
      const res = await fetch(BACKEND_URL + '/api/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken },
        body: form,
      });
      if (!res.ok) { alert('Upload failed: ' + (await res.json()).error); return null; }
      return await res.json();
    } catch { alert('Upload failed. Check your connection.'); return null; }
  }

  // ==============================
  //  AUTH
  // ==============================

  function showAuthError(msg) { authError.textContent = msg; authError.classList.add('visible'); }
  function hideAuthError() { authError.classList.remove('visible'); }

  const authInviteField = $('#authInviteField');
  const authInvite = $('#authInvite');

  function toggleAuthMode() {
    isRegisterMode = !isRegisterMode;
    hideAuthError();
    authNameField.style.display = isRegisterMode ? '' : 'none';
    authInviteField.style.display = isRegisterMode ? '' : 'none';
    authSubmitBtn.textContent = isRegisterMode ? 'Create Account' : 'Sign In';
    authToggleText.textContent = isRegisterMode ? 'Already have an account?' : "Don't have an account?";
    authToggleLink.textContent = isRegisterMode ? 'Sign in' : 'Create one';
    authSubtitle.textContent = isRegisterMode ? 'Create your account to start messaging.' : 'Enter your credentials to get started.';
  }

  // Auto-fill invite code, name, username from URL params and switch to register mode
  const urlParams = new URLSearchParams(window.location.search);
  const urlInvite = urlParams.get('invite');
  if (urlInvite) {
    isRegisterMode = true;
    authNameField.style.display = '';
    authInviteField.style.display = '';
    authInvite.value = urlInvite.toUpperCase();
    if (urlParams.get('name')) authName.value = urlParams.get('name');
    if (urlParams.get('username')) authUsername.value = urlParams.get('username');
    authSubmitBtn.textContent = 'Create Account';
    authToggleText.textContent = 'Already have an account?';
    authToggleLink.textContent = 'Sign in';
    authSubtitle.textContent = 'Create your account to start messaging.';
    // Show login/register screen instead of join request
    $('#joinRequestScreen').style.display = 'none';
    authScreen.style.display = '';
    window.history.replaceState({}, '', window.location.pathname);
  }

  async function handleAuth(e) {
    e.preventDefault();
    hideAuthError();

    const username = authUsername.value.trim().toLowerCase();
    const password = authPassword.value;
    const displayName = authName.value.trim();

    if (!username || !password) { showAuthError('Please fill in all fields.'); return; }
    if (username.length < 2) { showAuthError('Username must be at least 2 characters.'); return; }
    if (isRegisterMode && !displayName) { showAuthError('Please enter a display name.'); return; }
    if (isRegisterMode && password.length < 3) { showAuthError('Password must be at least 3 characters.'); return; }

    if (useServer) {
      const endpoint = isRegisterMode ? '/api/register' : '/api/login';
      const inviteCode = authInvite ? authInvite.value.trim() : '';
      const body = isRegisterMode ? { username, password, name: displayName, inviteCode } : { username, password };
      try {
        const res = await fetch(BACKEND_URL + endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await res.json();
        if (!res.ok) { showAuthError(d.error || 'Something went wrong.'); return; }
        authToken = d.token;
        currentUser = d.user;
        localStorage.setItem('sf_token', authToken);
        enterApp();
      } catch { showAuthError('Could not reach the server.'); }
    } else {
      const allUsers = lsGetUsers();
      if (isRegisterMode) {
        if (allUsers.find(u => u.username === username)) { showAuthError('That username is already taken.'); return; }
        const nu = { id: 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,7), username, password, name: displayName, status: 'online', role: 'Member', createdAt: Date.now() };
        allUsers.push(nu); lsSaveUsers(allUsers);
        lsSave('sf_session', nu.id);
        currentUser = nu;
        broadcast('user_joined', { userId: nu.id });
        enterApp();
      } else {
        const user = allUsers.find(u => u.username === username);
        if (!user || user.password !== password) { showAuthError('Invalid username or password.'); return; }
        user.status = 'online'; lsSaveUsers(allUsers);
        lsSave('sf_session', user.id);
        currentUser = user;
        broadcast('user_online', { userId: user.id });
        enterApp();
      }
    }
  }

  function logout() {
    if (useServer) {
      if (socket) socket.disconnect();
      socket = null;
      localStorage.removeItem('sf_token');
    } else {
      if (currentUser) {
        const u2 = lsGetUsers(), u = u2.find(x => x.id === currentUser.id);
        if (u) { u.status = 'offline'; lsSaveUsers(u2); }
        broadcast('user_offline', { userId: currentUser.id });
      }
      localStorage.removeItem('sf_session');
    }
    currentUser = null; authToken = null;
    users = []; channels = []; messages = {};
    appWrapper.style.display = 'none';
    $('#joinRequestScreen').style.display = '';
    $('#authScreen').style.display = 'none';
    authUsername.value = ''; authPassword.value = ''; authName.value = '';
    hideAuthError();
  }

  // ==============================
  //  APP ENTRY
  // ==============================

  async function enterApp() {
    if (useServer) {
      try {
        const res = await fetch(BACKEND_URL + '/api/data', {
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
        if (!res.ok) { logout(); showAuthError('Session expired. Please sign in again.'); return; }
        const d = await res.json();
        currentUser = d.currentUser || currentUser;
        users = d.users; channels = d.channels; messages = d.messages;
      } catch { logout(); showAuthError('Could not reach the server.'); return; }
      connectSocket();
    } else {
      users = lsGetUsers();
      channels = lsGetChannels();
      messages = lsGetAllMessages();
      const u = users.find(x => x.id === currentUser.id);
      if (u) { u.status = 'online'; u.lastSeen = Date.now(); lsSaveUsers(users); }
      startLocalHeartbeat();
      startLocalPolling();
    }

    authScreen.style.display = 'none';
    appWrapper.style.display = 'flex';
    renderAll();
    messageInput.focus();
  }

  // ── Local-only heartbeat & polling ──
  let hbInterval, pollInterval;
  function startLocalHeartbeat() {
    clearInterval(hbInterval);
    hbInterval = setInterval(() => {
      if (!currentUser) return;
      const u2 = lsGetUsers(), u = u2.find(x => x.id === currentUser.id);
      if (u) { u.status = 'online'; u.lastSeen = Date.now(); }
      const now = Date.now();
      u2.forEach(x => { if (x.id !== currentUser.id && x.status === 'online' && x.lastSeen && now - x.lastSeen > 15000) x.status = 'offline'; });
      lsSaveUsers(u2);
    }, 5000);
  }
  let lastSnap = '';
  function startLocalPolling() {
    lastSnap = JSON.stringify(lsGetAllMessages());
    clearInterval(pollInterval);
    pollInterval = setInterval(() => {
      if (!currentUser) return;
      const cur = JSON.stringify(lsGetAllMessages());
      if (cur !== lastSnap) { lastSnap = cur; messages = lsGetAllMessages(); renderMessages(); if (activeThreadMsgId) renderThread(activeThreadMsgId); }
      users = lsGetUsers(); renderDMList();
    }, 2000);
  }

  // ── BroadcastChannel listener (local mode) ──
  if (bc) {
    bc.onmessage = (e) => {
      if (useServer) return;
      const { type, payload, senderId } = e.data;
      if (senderId === (currentUser && currentUser.id)) return;
      if (type === 'new_message' && payload.channelId === activeChannelId) { messages = lsGetAllMessages(); renderMessages(); }
      if (type === 'thread_reply' && payload.channelId === activeChannelId) { messages = lsGetAllMessages(); renderMessages(); if (activeThreadMsgId === payload.parentMsgId) renderThread(payload.parentMsgId); }
      if (type === 'message_deleted' && payload.channelId === activeChannelId) { messages = lsGetAllMessages(); renderMessages(); }
      if (type === 'reaction' && payload.channelId === activeChannelId) { messages = lsGetAllMessages(); renderMessages(); }
      if (type === 'new_channel') { channels = lsGetChannels(); renderChannelList(); }
      if (['user_joined','user_online','user_offline'].includes(type)) { users = lsGetUsers(); renderDMList(); if (memberPanel.classList.contains('open')) renderMembers(); }
      if (type === 'typing' && payload.channelId === activeChannelId && payload.userName) showTyping(payload.userName);
    };
  }

  // ==============================
  //  SOCKET.IO (server mode)
  // ==============================

  function connectSocket() {
    if (!useServer) return;
    if (socket) socket.disconnect();
    socket = io(BACKEND_URL);

    socket.on('connect', () => { socket.emit('authenticate', authToken); });
    socket.on('authenticated', () => { socket.emit('join_channel', activeChannelId); });
    socket.on('auth_error', () => { logout(); showAuthError('Session expired.'); });

    socket.on('new_message', ({ channelId, message }) => {
      if (!messages[channelId]) messages[channelId] = [];
      if (!messages[channelId].find(m => m.id === message.id)) messages[channelId].push(message);
      if (channelId === activeChannelId) renderMessages();
    });
    socket.on('thread_reply', ({ channelId, parentMsgId, reply }) => {
      const msgs = messages[channelId]; if (!msgs) return;
      const p = msgs.find(m => m.id === parentMsgId); if (!p) return;
      if (!p.threadReplies) p.threadReplies = [];
      if (!p.threadReplies.find(r => r.id === reply.id)) p.threadReplies.push(reply);
      if (channelId === activeChannelId) { renderMessages(); if (activeThreadMsgId === parentMsgId) renderThread(parentMsgId); }
    });
    socket.on('reaction_updated', ({ channelId, msgId, reactions }) => {
      const msgs = messages[channelId]; if (!msgs) return;
      const msg = msgs.find(m => m.id === msgId); if (msg) msg.reactions = reactions;
      if (channelId === activeChannelId) renderMessages();
    });
    socket.on('message_deleted', ({ channelId, msgId }) => {
      if (messages[channelId]) messages[channelId] = messages[channelId].filter(m => m.id !== msgId);
      if (channelId === activeChannelId) renderMessages();
      if (activeThreadMsgId === msgId) { threadPanel.classList.remove('open'); activeThreadMsgId = null; }
    });
    socket.on('channel_created', ({ channel }) => {
      if (!channels.find(c => c.id === channel.id)) channels.push(channel);
      if (!messages[channel.id]) messages[channel.id] = [];
      renderChannelList();
    });
    socket.on('dm_opened', ({ channelId }) => {
      if (!messages[channelId]) messages[channelId] = [];
      switchChannel(channelId);
      socket.emit('join_channel', channelId);
    });
    socket.on('user_joined', ({ user }) => {
      const ex = users.find(u => u.id === user.id);
      if (ex) Object.assign(ex, user); else users.push(user);
      renderDMList(); if (memberPanel.classList.contains('open')) renderMembers();
    });
    socket.on('user_status', ({ userId, status }) => {
      const u = users.find(x => x.id === userId); if (u) u.status = status;
      renderDMList(); if (memberPanel.classList.contains('open')) renderMembers();
    });
    socket.on('user_updated', ({ user }) => {
      const ex = users.find(u => u.id === user.id);
      if (ex) Object.assign(ex, user);
      if (user.id === currentUser.id) currentUser = user;
      renderAll();
    });
    socket.on('user_typing', ({ channelId, userName }) => {
      if (channelId === activeChannelId) showTyping(userName);
    });
  }

  // ==============================
  //  RENDER (shared by both modes)
  // ==============================

  function renderAll() { renderChannelList(); renderDMList(); renderMessages(); renderRailAvatar(); renderEmojis(); }

  function renderChannelList() {
    channelListEl.innerHTML = channels.filter(c => !c.id.startsWith('dm_')).map(ch => `
      <li class="${ch.id === activeChannelId ? 'active' : ''}" data-channel="${ch.id}">
        <span class="channel-hash">#</span><span>${escHtml(ch.name)}</span>
      </li>`).join('');
  }

  function renderDMList() {
    const others = users.filter(u => u.id !== currentUser.id);
    if (!others.length) { dmListEl.innerHTML = '<li style="color:var(--text-muted);font-size:12px;cursor:default;padding-left:26px">No other users yet</li>'; return; }
    dmListEl.innerHTML = others.map(u => `
      <li data-user="${u.id}">
        <span class="dm-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}</span>
        <span>${escHtml(u.name)}</span>
        <span class="dm-status ${u.status === 'online' ? 'online' : 'offline'}"></span>
      </li>`).join('');
  }

  function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function formatDate(ts) {
    const d = new Date(ts), t = new Date();
    if (d.toDateString() === t.toDateString()) return 'Today';
    const y = new Date(t); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function formatText(text) {
    return escHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>')
      .replace(/@(\w[\w\s]*\w)/g, '<span class="mention">@$1</span>');
  }
  function resolveUser(uid, snapshotName) {
    return users.find(u => u.id === uid) || { id: uid, name: snapshotName || 'Deleted User', status: 'offline' };
  }

  function renderMessages() {
    const ch = channels.find(c => c.id === activeChannelId);
    const msgs = messages[activeChannelId] || [];
    const isDM = activeChannelId.startsWith('dm_');

    headerChannelName.textContent = ch ? ch.name : 'unknown';
    headerTopic.textContent = ch ? (ch.topic || '') : '';
    messageInput.placeholder = ch ? `Message ${isDM ? '' : '#'}${ch.name}` : 'Message';
    document.querySelector('.header-hash').textContent = isDM ? '💬' : '#';

    let html = '';
    if (ch) {
      html += `<div class="channel-intro"><div class="channel-intro-icon">${isDM ? '💬' : '#'}</div>
        <h2>${isDM ? '' : '#'}${escHtml(ch.name)}</h2>
        <p>${ch.topic ? escHtml(ch.topic) + '. ' : ''}This is the very beginning of ${isDM ? 'your conversation' : `the <strong>#${escHtml(ch.name)}</strong> channel`}.</p></div>`;
    }

    let lastDate = '', lastUserId = '', lastTs = 0;
    msgs.forEach(msg => {
      const user = resolveUser(msg.userId, msg.userName);
      const date = formatDate(msg.ts);
      const isCompact = (msg.userId === lastUserId && msg.ts - lastTs < 300000 && date === lastDate);
      if (date !== lastDate) { html += `<div class="date-divider"><span>${date}</span></div>`; lastDate = date; }

      const reactionsHtml = Object.keys(msg.reactions || {}).length > 0
        ? `<div class="reactions">${Object.entries(msg.reactions).map(([emoji, uids]) =>
            `<span class="reaction ${uids.includes(currentUser.id) ? 'reacted' : ''}" data-emoji="${emoji}" data-msg="${msg.id}">${emoji} <span class="reaction-count">${uids.length}</span></span>`
          ).join('')}</div>` : '';

      const tc = (msg.threadReplies || []).length;
      const threadHtml = tc > 0
        ? `<div class="thread-link" data-msg="${msg.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span class="thread-reply-count">${tc} ${tc === 1 ? 'reply' : 'replies'}</span></div>` : '';

      const isOwn = msg.userId === currentUser.id;
      html += `<div class="message ${isCompact ? 'compact' : ''}" data-msg="${msg.id}">
        <div class="message-avatar" style="background:${colorFor(user.name)}">${initials(user.name)}</div>
        <div class="message-body">
          <div class="message-meta"><span class="message-author">${escHtml(user.name)}</span><span class="message-time">${formatTime(msg.ts)}</span></div>
          ${msg.text ? `<div class="message-text">${formatText(msg.text)}</div>` : ''}${renderFileAttachment(msg.file)}${reactionsHtml}${threadHtml}
        </div>
        <div class="message-actions">
          <button class="btn-icon" title="React" data-action="react" data-msg="${msg.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></button>
          <button class="btn-icon" title="Reply in thread" data-action="thread" data-msg="${msg.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></button>
          ${isOwn ? `<button class="btn-icon" title="Delete" data-action="delete" data-msg="${msg.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>` : ''}
        </div></div>`;
      lastUserId = msg.userId; lastTs = msg.ts;
    });

    if (!msgs.length && ch) html += `<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">No messages yet. Be the first to say something!</div>`;
    messagesListEl.innerHTML = html;
    scrollToBottom();
  }

  function scrollToBottom() { requestAnimationFrame(() => { messagesContainer.scrollTop = messagesContainer.scrollHeight; }); }

  function renderThread(msgId) {
    const msgs = messages[activeChannelId] || [];
    const pm = msgs.find(m => m.id === msgId);
    if (!pm) return;
    activeThreadMsgId = msgId;
    const ch = channels.find(c => c.id === activeChannelId);
    threadChannel.textContent = ch ? `#${ch.name}` : '';
    const pu = resolveUser(pm.userId, pm.userName);
    let html = `<div class="message"><div class="message-avatar" style="background:${colorFor(pu.name)}">${initials(pu.name)}</div>
      <div class="message-body"><div class="message-meta"><span class="message-author">${escHtml(pu.name)}</span><span class="message-time">${formatTime(pm.ts)}</span></div>
      <div class="message-text">${formatText(pm.text)}</div></div></div>
      <div class="date-divider"><span>${(pm.threadReplies||[]).length} ${(pm.threadReplies||[]).length===1?'reply':'replies'}</span></div>`;
    (pm.threadReplies || []).forEach(r => {
      const u = resolveUser(r.userId, r.userName);
      html += `<div class="message"><div class="message-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}</div>
        <div class="message-body"><div class="message-meta"><span class="message-author">${escHtml(u.name)}</span><span class="message-time">${formatTime(r.ts)}</span></div>
        <div class="message-text">${formatText(r.text)}</div></div></div>`;
    });
    threadMessagesEl.innerHTML = html;
    threadPanel.classList.add('open'); memberPanel.classList.remove('open');
    requestAnimationFrame(() => { threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight; });
  }

  function renderMembers() {
    const on = users.filter(u => u.status === 'online'), off = users.filter(u => u.status !== 'online');
    let html = `<div style="padding:6px 10px;font-size:12px;color:var(--text-muted);font-weight:700">Online — ${on.length}</div>`;
    on.forEach(u => { html += memberHTML(u); });
    if (off.length) { html += `<div style="padding:6px 10px;font-size:12px;color:var(--text-muted);font-weight:700;margin-top:8px">Offline — ${off.length}</div>`; off.forEach(u => { html += memberHTML(u); }); }
    memberListEl.innerHTML = html; memberCount.textContent = users.length;
  }

  function memberHTML(u) {
    const dot = u.status === 'online' ? 'var(--green)' : 'var(--text-muted)';
    const sub = u.statusMsg ? escHtml(u.statusMsg) : escHtml(u.role || 'Member');
    return `<div class="member-item"><div class="member-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}<span class="status-dot" style="background:${dot}"></span></div>
      <div class="member-info"><div class="member-name">${escHtml(u.name)}${u.id===currentUser.id?' (you)':''}</div><div class="member-role">${sub}</div></div></div>`;
  }

  function renderRailAvatar() {
    const r = $('#railAvatar');
    r.style.background = colorFor(currentUser.name);
    r.style.display = 'flex'; r.style.alignItems = 'center'; r.style.justifyContent = 'center';
    r.style.fontSize = '13px'; r.style.fontWeight = '700'; r.style.color = '#fff';
    r.textContent = initials(currentUser.name);
  }

  function renderEmojis(filter = '') {
    const f = filter ? EMOJIS.filter(e => e.includes(filter)) : EMOJIS;
    emojiGrid.innerHTML = f.map(e => `<span>${e}</span>`).join('');
  }

  let typingTO;
  function showTyping(name) {
    typingText.textContent = `${name} is typing...`;
    typingIndicator.classList.add('visible');
    clearTimeout(typingTO);
    typingTO = setTimeout(() => typingIndicator.classList.remove('visible'), 3000);
  }

  // ==============================
  //  ACTIONS
  // ==============================

  async function sendMessage(text, isThread = false) {
    if (!text.trim() && !pendingFile) return;
    if (!currentUser) return;

    let file = null;
    if (pendingFile && useServer) {
      const uploadingPill = $('#filePreview');
      if (uploadingPill) uploadingPill.innerHTML = '<span class="file-pill">⏳ Uploading…</span>';
      file = await uploadFile(pendingFile);
      setPendingFile(null);
      $('#fileInput').value = '';
      if (!file && !text.trim()) return;
    }

    if (useServer && socket) {
      if (isThread && activeThreadMsgId) {
        socket.emit('thread_reply', { channelId: activeChannelId, parentMsgId: activeThreadMsgId, text: text.trim() });
      } else {
        socket.emit('send_message', { channelId: activeChannelId, text: text.trim(), file });
      }
    } else {
      const msg = { id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), userId: currentUser.id, text: text.trim(), ts: Date.now(), reactions: {}, threadReplies: [] };
      if (isThread && activeThreadMsgId) {
        const allMsgs = lsGetAllMessages();
        const chMsgs = allMsgs[activeChannelId] || [];
        const parent = chMsgs.find(m => m.id === activeThreadMsgId);
        if (parent) {
          parent.threadReplies.push({ id: msg.id, userId: msg.userId, text: msg.text, ts: msg.ts });
          allMsgs[activeChannelId] = chMsgs;
          lsSaveAllMessages(allMsgs);
          messages = allMsgs;
          broadcast('thread_reply', { channelId: activeChannelId, parentMsgId: activeThreadMsgId });
          renderThread(activeThreadMsgId); renderMessages();
        }
      } else {
        lsAppendMessage(activeChannelId, msg);
        messages = lsGetAllMessages();
        broadcast('new_message', { channelId: activeChannelId, msgId: msg.id });
        renderMessages();
      }
    }
  }

  function deleteMessage(msgId) {
    if (useServer && socket) {
      socket.emit('delete_message', { channelId: activeChannelId, msgId });
    } else {
      const allMsgs = lsGetAllMessages();
      allMsgs[activeChannelId] = (allMsgs[activeChannelId] || []).filter(m => m.id !== msgId);
      lsSaveAllMessages(allMsgs);
      messages = allMsgs;
      broadcast('message_deleted', { channelId: activeChannelId, msgId });
      renderMessages();
      if (activeThreadMsgId === msgId) { threadPanel.classList.remove('open'); activeThreadMsgId = null; }
    }
  }

  function toggleReaction(msgId, emoji) {
    if (useServer && socket) {
      socket.emit('reaction', { channelId: activeChannelId, msgId, emoji });
    } else {
      const allMsgs = lsGetAllMessages();
      const msg = (allMsgs[activeChannelId] || []).find(m => m.id === msgId);
      if (!msg) return;
      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
      const idx = msg.reactions[emoji].indexOf(currentUser.id);
      if (idx > -1) { msg.reactions[emoji].splice(idx, 1); if (!msg.reactions[emoji].length) delete msg.reactions[emoji]; }
      else msg.reactions[emoji].push(currentUser.id);
      lsSaveAllMessages(allMsgs);
      messages = allMsgs;
      broadcast('reaction', { channelId: activeChannelId, msgId });
      renderMessages();
    }
  }

  function switchChannel(chId) {
    if (useServer && socket) { socket.emit('leave_channel', activeChannelId); }
    activeChannelId = chId;
    if (useServer && socket) { socket.emit('join_channel', chId); }
    threadPanel.classList.remove('open'); activeThreadMsgId = null;
    renderChannelList(); renderMessages(); closeMobileSidebar();
  }

  function performSearch(query) {
    if (!query.trim()) { searchResults.classList.remove('open'); return; }
    const q = query.toLowerCase(), results = [];
    Object.entries(messages).forEach(([chId, msgs]) => {
      const ch = channels.find(c => c.id === chId); if (!ch) return;
      msgs.forEach(msg => {
        if (msg.text.toLowerCase().includes(q)) results.push({ channel: ch.name, channelId: chId, msg });
        (msg.threadReplies||[]).forEach(r => { if (r.text.toLowerCase().includes(q)) results.push({ channel: ch.name+' (thread)', channelId: chId, msg: r }); });
      });
    });
    if (!results.length) { searchResultsInner.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">No results for "${escHtml(query)}"</div>`; }
    else {
      const sq = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      searchResultsInner.innerHTML = results.map(r => {
        const u = resolveUser(r.msg.userId), hl = escHtml(r.msg.text).replace(new RegExp(`(${sq})`,'gi'), '<mark>$1</mark>');
        return `<div class="search-result-item" data-channel="${r.channelId}"><div class="search-result-channel">#${escHtml(r.channel)} · ${escHtml(u.name)} · ${formatTime(r.msg.ts)}</div><div class="search-result-text">${hl}</div></div>`;
      }).join('');
    }
    searchResults.classList.add('open');
  }

  // ── UI helpers ──
  function openMobileSidebar() { sidebarEl.classList.add('mobile-open'); sidebarOverlay.classList.add('visible'); }
  function closeMobileSidebar() { sidebarEl.classList.remove('mobile-open'); sidebarOverlay.classList.remove('visible'); }
  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  let emojiTargetMsgId = null, emojiInsertMode = 'input';
  function openEmojiPicker(anchor, mode, msgId) {
    emojiInsertMode = mode; emojiTargetMsgId = msgId || null;
    renderEmojis(); emojiSearchEl.value = '';
    const r = anchor.getBoundingClientRect();
    emojiPicker.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    emojiPicker.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
    emojiPicker.style.top = 'auto'; emojiPicker.classList.add('open');
  }
  function closeEmojiPicker() { emojiPicker.classList.remove('open'); emojiTargetMsgId = null; }
  function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }

  // ==============================
  //  EVENT LISTENERS
  // ==============================

  authToggleLink.addEventListener('click', (e) => { e.preventDefault(); toggleAuthMode(); });
  authForm.addEventListener('submit', handleAuth);
  $('#logoutBtn').addEventListener('click', logout);

  // Toggle between join request and login
  $('#backToLoginLink').addEventListener('click', (e) => {
    e.preventDefault();
    $('#joinRequestScreen').style.display = 'none';
    $('#authScreen').style.display = '';
  });
  $('#goToJoinLink').addEventListener('click', (e) => {
    e.preventDefault();
    $('#authScreen').style.display = 'none';
    $('#joinRequestScreen').style.display = '';
  });
  $('#joinRequestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#jrName').value.trim();
    const username = $('#jrUsername').value.trim();
    const message = $('#jrMessage').value.trim();
    const errEl = $('#joinRequestError');
    const successEl = $('#joinRequestSuccess');
    errEl.classList.remove('visible'); successEl.style.display = 'none';
    if (!name || !username) { errEl.textContent = 'Name and username are required.'; errEl.classList.add('visible'); return; }
    try {
      const res = await fetch(BACKEND_URL + '/api/join-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, message }),
      });
      const d = await res.json();
      if (!res.ok) { errEl.textContent = d.error || 'Something went wrong.'; errEl.classList.add('visible'); return; }
      successEl.style.display = '';
      $('#joinRequestForm').style.display = 'none';
    } catch { errEl.textContent = 'Could not reach the server.'; errEl.classList.add('visible'); }
  });

  channelListEl.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li && li.dataset.channel) switchChannel(li.dataset.channel); });

  dmListEl.addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li || !li.dataset.user) return;
    const userId = li.dataset.user;
    if (useServer && socket) {
      socket.emit('open_dm', { targetUserId: userId });
    } else {
      const user = resolveUser(userId);
      const ids = [currentUser.id, userId].sort(), dmId = 'dm_' + ids.join('_');
      const chs = lsGetChannels();
      if (!chs.find(c => c.id === dmId)) { chs.push({ id: dmId, name: user.name, topic: `Direct message with ${user.name}`, createdBy: currentUser.id }); lsSaveChannels(chs); channels = chs; }
      switchChannel(dmId);
    }
  });

  $('#sendBtn').addEventListener('click', () => { sendMessage(messageInput.value); messageInput.value = ''; autoResize(messageInput); });
  messageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(messageInput.value); messageInput.value = ''; autoResize(messageInput); } });

  $('#fileBtn').addEventListener('click', () => { $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('File too large. Maximum size is 10MB.'); return; }
    setPendingFile(file);
  });

  // ── Drag and drop ──
  const chatArea = $('#chatArea');

  chatArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatArea.classList.add('drag-over');
  });
  chatArea.addEventListener('dragleave', (e) => {
    if (!chatArea.contains(e.relatedTarget)) chatArea.classList.remove('drag-over');
  });
  chatArea.addEventListener('drop', (e) => {
    e.preventDefault();
    chatArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('File too large. Maximum size is 10MB.'); return; }
    setPendingFile(file);
    messageInput.focus();
  });
  let typBcTO;
  messageInput.addEventListener('input', () => {
    autoResize(messageInput);
    clearTimeout(typBcTO);
    typBcTO = setTimeout(() => {
      if (!currentUser || !messageInput.value.trim()) return;
      if (useServer && socket) socket.emit('typing', { channelId: activeChannelId });
      else broadcast('typing', { channelId: activeChannelId, userName: currentUser.name });
    }, 300);
  });

  $('#threadSendBtn').addEventListener('click', () => { sendMessage(threadInput.value, true); threadInput.value = ''; autoResize(threadInput); });
  threadInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(threadInput.value, true); threadInput.value = ''; autoResize(threadInput); } });
  threadInput.addEventListener('input', () => autoResize(threadInput));
  $('#threadClose').addEventListener('click', () => { threadPanel.classList.remove('open'); activeThreadMsgId = null; });

  messagesListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) { const a = btn.dataset.action, m = btn.dataset.msg; if (a === 'thread') renderThread(m); if (a === 'react') openEmojiPicker(btn, 'reaction', m); if (a === 'delete' && confirm('Delete this message?')) deleteMessage(m); return; }
    const tl = e.target.closest('.thread-link'); if (tl) { renderThread(tl.dataset.msg); return; }
    const rx = e.target.closest('.reaction'); if (rx) toggleReaction(rx.dataset.msg, rx.dataset.emoji);
  });

  $('#emojiBtn').addEventListener('click', (e) => { if (emojiPicker.classList.contains('open')) closeEmojiPicker(); else openEmojiPicker(e.currentTarget, 'input'); });
  emojiGrid.addEventListener('click', (e) => { if (e.target.tagName === 'SPAN') { const em = e.target.textContent; if (emojiInsertMode === 'reaction' && emojiTargetMsgId) toggleReaction(emojiTargetMsgId, em); else { messageInput.value += em; messageInput.focus(); } closeEmojiPicker(); } });
  emojiSearchEl.addEventListener('input', () => renderEmojis(emojiSearchEl.value));
  document.addEventListener('click', (e) => { if (emojiPicker.classList.contains('open') && !emojiPicker.contains(e.target) && !e.target.closest('#emojiBtn') && !e.target.closest('[data-action="react"]')) closeEmojiPicker(); });

  $('#memberListBtn').addEventListener('click', () => { memberPanel.classList.toggle('open'); if (memberPanel.classList.contains('open')) { threadPanel.classList.remove('open'); renderMembers(); } });
  $('#memberPanelClose').addEventListener('click', () => { memberPanel.classList.remove('open'); });

  let searchTO;
  searchInput.addEventListener('input', () => { clearTimeout(searchTO); searchTO = setTimeout(() => performSearch(searchInput.value), 300); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchInput.value = ''; searchResults.classList.remove('open'); } });
  searchResultsInner.addEventListener('click', (e) => { const it = e.target.closest('.search-result-item'); if (it) { switchChannel(it.dataset.channel); searchInput.value = ''; searchResults.classList.remove('open'); } });
  document.addEventListener('click', (e) => { if (searchResults.classList.contains('open') && !searchResults.contains(e.target) && !e.target.closest('.sidebar-search')) searchResults.classList.remove('open'); });

  $('#addChannelBtn').addEventListener('click', (e) => { e.stopPropagation(); openModal('addChannelModal'); });
  $('#createChannelBtn').addEventListener('click', () => {
    const name = $('#newChannelName').value.trim();
    const desc = $('#newChannelDesc').value.trim();
    if (!name) return;
    if (useServer && socket) { socket.emit('create_channel', { name, topic: desc }); }
    else {
      const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!slug) return;
      const chs = lsGetChannels();
      if (chs.find(c => c.name === slug)) { alert('Channel already exists!'); return; }
      const id = 'c_' + Date.now();
      chs.push({ id, name: slug, topic: desc || '', createdBy: currentUser.id });
      lsSaveChannels(chs); channels = chs;
      broadcast('new_channel', { channelId: id });
      renderChannelList(); switchChannel(id);
    }
    closeModal('addChannelModal'); $('#newChannelName').value = ''; $('#newChannelDesc').value = '';
  });

  $('#channelsToggle').addEventListener('click', (e) => { if (e.target.closest('.btn-tiny')) return; e.currentTarget.classList.toggle('collapsed'); channelListEl.style.display = e.currentTarget.classList.contains('collapsed') ? 'none' : ''; });
  $('#usersToggle').addEventListener('click', () => { $('#usersToggle').classList.toggle('collapsed'); dmListEl.style.display = $('#usersToggle').classList.contains('collapsed') ? 'none' : ''; });

  $$('.modal-close, .btn-secondary[data-modal]').forEach(b => { b.addEventListener('click', () => closeModal(b.dataset.modal)); });
  $$('.modal-overlay').forEach(o => { o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('open'); }); });

  $('#railAvatar').addEventListener('click', () => {
    const a = $('#profileAvatarLg'); a.style.background = colorFor(currentUser.name); a.textContent = initials(currentUser.name);
    $('#profileName').value = currentUser.name;
    $('#profileStatus').value = currentUser.statusMsg || '';
    applyTheme(localStorage.getItem('sf_theme') || 'dark');
    openModal('profileModal');
  });

  document.getElementById('themePicker').addEventListener('click', (e) => {
    const swatch = e.target.closest('.theme-swatch');
    if (swatch) applyTheme(swatch.dataset.theme);
  });
  $('#saveProfileBtn').addEventListener('click', () => {
    const name = $('#profileName').value.trim();
    const statusMsg = $('#profileStatus').value.trim();
    if (useServer && socket) {
      socket.emit('update_profile', { name: name || currentUser.name, statusMsg });
    } else {
      if (name) currentUser.name = name;
      currentUser.statusMsg = statusMsg;
      const u2 = lsGetUsers(), u = u2.find(x => x.id === currentUser.id);
      if (u) { u.name = currentUser.name; u.statusMsg = statusMsg; lsSaveUsers(u2); users = u2; }
      broadcast('user_joined', { userId: currentUser.id }); renderAll();
    }
    closeModal('profileModal');
  });

  $('#mobileMenuBtn').addEventListener('click', openMobileSidebar);
  sidebarOverlay.addEventListener('click', closeMobileSidebar);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { threadPanel.classList.remove('open'); memberPanel.classList.remove('open'); closeEmojiPicker(); $$('.modal-overlay.open').forEach(m => m.classList.remove('open')); searchResults.classList.remove('open'); closeMobileSidebar(); }
  });

  window.addEventListener('beforeunload', () => {
    if (!useServer && currentUser) {
      const u2 = lsGetUsers(), u = u2.find(x => x.id === currentUser.id);
      if (u) { u.status = 'offline'; lsSaveUsers(u2); }
      broadcast('user_offline', { userId: currentUser.id });
    }
  });

  // ==============================
  //  INIT
  // ==============================

  if (useServer && authToken) {
    enterApp();
  } else if (!useServer) {
    const uid = lsLoad('sf_session', null);
    if (uid) { const u = lsGetUsers().find(x => x.id === uid); if (u) { currentUser = u; enterApp(); } }
  }

})();
