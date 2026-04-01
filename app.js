/* ========================================
   SlackFlow — Standalone Client (GitHub Pages)
   localStorage persistence + BroadcastChannel cross-tab sync
   ======================================== */

(function () {
  'use strict';

  const STORAGE = {
    USERS: 'sf_users',
    CHANNELS: 'sf_channels',
    MESSAGES: 'sf_messages',
    SESSION: 'sf_session',
  };

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

  // ── Storage ──
  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  }
  function save(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

  function getUsers() { return load(STORAGE.USERS, []); }
  function saveUsers(arr) { save(STORAGE.USERS, arr); }

  function getChannels() {
    return load(STORAGE.CHANNELS, [
      { id: 'c_general', name: 'general', topic: 'Company-wide announcements and work-based matters', createdBy: 'system' },
      { id: 'c_random', name: 'random', topic: 'Non-work banter and water cooler conversation', createdBy: 'system' },
    ]);
  }
  function saveChannels(arr) { save(STORAGE.CHANNELS, arr); }

  function getAllMessages() { return load(STORAGE.MESSAGES, {}); }
  function saveAllMessages(obj) { save(STORAGE.MESSAGES, obj); }
  function getChannelMessages(chId) { return getAllMessages()[chId] || []; }

  function appendMessage(chId, msg) {
    const all = getAllMessages();
    if (!all[chId]) all[chId] = [];
    all[chId].push(msg);
    saveAllMessages(all);
  }
  function updateMessages(chId, msgs) {
    const all = getAllMessages();
    all[chId] = msgs;
    saveAllMessages(all);
  }

  // ── BroadcastChannel ──
  let bc;
  try { bc = new BroadcastChannel('slackflow_sync'); } catch { bc = null; }
  function broadcast(type, payload) {
    if (bc) bc.postMessage({ type, payload, senderId: currentUser ? currentUser.id : null });
  }

  // ── Auth state ──
  let currentUser = null;

  function getSession() {
    const uid = load(STORAGE.SESSION, null);
    if (!uid) return null;
    return getUsers().find(u => u.id === uid) || null;
  }
  function setSession(uid) { save(STORAGE.SESSION, uid); }
  function clearSession() { localStorage.removeItem(STORAGE.SESSION); }

  // ── DOM ──
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
  const threadMessages = $('#threadMessages');
  const threadInput = $('#threadInput');
  const threadChannel = $('#threadChannel');
  const memberPanel = $('#memberPanel');
  const memberList = $('#memberList');
  const emojiPicker = $('#emojiPicker');
  const emojiGrid = $('#emojiGrid');
  const emojiSearchEl = $('#emojiSearch');
  const searchInput = $('#searchInput');
  const searchResults = $('#searchResults');
  const searchResultsInner = $('#searchResultsInner');
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebarOverlay');

  let activeChannelId = 'c_general';
  let activeThreadMsgId = null;
  let isRegisterMode = false;

  // ── Auth UI ──
  function showAuthError(msg) { authError.textContent = msg; authError.classList.add('visible'); }
  function hideAuthError() { authError.classList.remove('visible'); }

  function toggleAuthMode() {
    isRegisterMode = !isRegisterMode;
    hideAuthError();
    if (isRegisterMode) {
      authNameField.style.display = '';
      authSubmitBtn.textContent = 'Create Account';
      authToggleText.textContent = 'Already have an account?';
      authToggleLink.textContent = 'Sign in';
      authSubtitle.textContent = 'Create your account to start messaging.';
    } else {
      authNameField.style.display = 'none';
      authSubmitBtn.textContent = 'Sign In';
      authToggleText.textContent = "Don't have an account?";
      authToggleLink.textContent = 'Create one';
      authSubtitle.textContent = 'Enter your credentials to get started.';
    }
  }

  function handleAuth(e) {
    e.preventDefault();
    hideAuthError();
    const username = authUsername.value.trim().toLowerCase();
    const password = authPassword.value;
    const displayName = authName.value.trim();

    if (!username || !password) { showAuthError('Please fill in all fields.'); return; }
    if (username.length < 2) { showAuthError('Username must be at least 2 characters.'); return; }

    const users = getUsers();

    if (isRegisterMode) {
      if (!displayName) { showAuthError('Please enter a display name.'); return; }
      if (password.length < 3) { showAuthError('Password must be at least 3 characters.'); return; }
      if (users.find(u => u.username === username)) { showAuthError('That username is already taken.'); return; }

      const newUser = {
        id: 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        username, password, name: displayName, status: 'online', role: 'Member', createdAt: Date.now(),
      };
      users.push(newUser);
      saveUsers(users);
      setSession(newUser.id);
      currentUser = newUser;
      broadcast('user_joined', { userId: newUser.id });
      enterApp();
    } else {
      const user = users.find(u => u.username === username);
      if (!user || user.password !== password) { showAuthError('Invalid username or password.'); return; }
      user.status = 'online';
      saveUsers(users);
      setSession(user.id);
      currentUser = user;
      broadcast('user_online', { userId: user.id });
      enterApp();
    }
  }

  function logout() {
    if (currentUser) {
      const users = getUsers();
      const u = users.find(x => x.id === currentUser.id);
      if (u) { u.status = 'offline'; saveUsers(users); }
      broadcast('user_offline', { userId: currentUser.id });
    }
    currentUser = null;
    clearSession();
    appWrapper.style.display = 'none';
    authScreen.style.display = '';
    authUsername.value = ''; authPassword.value = ''; authName.value = '';
    hideAuthError();
  }

  // ── App entry ──
  function enterApp() {
    authScreen.style.display = 'none';
    appWrapper.style.display = 'flex';
    const users = getUsers();
    const u = users.find(x => x.id === currentUser.id);
    if (u) { u.status = 'online'; u.lastSeen = Date.now(); saveUsers(users); }
    renderAll();
    messageInput.focus();
    startHeartbeat();
  }

  let heartbeatInterval;
  function startHeartbeat() {
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (!currentUser) return;
      const users = getUsers();
      const u = users.find(x => x.id === currentUser.id);
      if (u) { u.status = 'online'; u.lastSeen = Date.now(); saveUsers(users); }
      const now = Date.now();
      let changed = false;
      users.forEach(x => {
        if (x.id !== currentUser.id && x.status === 'online' && x.lastSeen && now - x.lastSeen > 15000) {
          x.status = 'offline'; changed = true;
        }
      });
      if (changed) saveUsers(users);
    }, 5000);
  }

  // ── Render ──
  function renderAll() { renderChannelList(); renderDMList(); renderMessages(); renderRailAvatar(); renderEmojis(); }

  function renderChannelList() {
    const channels = getChannels();
    channelListEl.innerHTML = channels.filter(c => !c.id.startsWith('dm_')).map(ch => `
      <li class="${ch.id === activeChannelId ? 'active' : ''}" data-channel="${ch.id}">
        <span class="channel-hash">#</span><span>${escHtml(ch.name)}</span>
      </li>`).join('');
  }

  function renderDMList() {
    const others = getUsers().filter(u => u.id !== currentUser.id);
    if (others.length === 0) {
      dmListEl.innerHTML = '<li style="color:var(--text-muted);font-size:12px;cursor:default;padding-left:26px">No other users yet</li>';
      return;
    }
    dmListEl.innerHTML = others.map(u => `
      <li data-user="${u.id}">
        <span class="dm-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}</span>
        <span>${escHtml(u.name)}</span>
        <span class="dm-status ${u.status === 'online' ? 'online' : 'offline'}"></span>
      </li>`).join('');
  }

  function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  function formatDate(ts) {
    const d = new Date(ts), today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const y = new Date(today); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function formatText(text) {
    return escHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>')
      .replace(/@(\w[\w\s]*\w)/g, '<span class="mention">@$1</span>');
  }

  function resolveUser(uid) {
    return getUsers().find(u => u.id === uid) || { id: uid, name: 'Deleted User', status: 'offline' };
  }

  function renderMessages() {
    const channels = getChannels();
    const ch = channels.find(c => c.id === activeChannelId);
    const msgs = getChannelMessages(activeChannelId);
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
      const user = resolveUser(msg.userId);
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
          <div class="message-text">${formatText(msg.text)}</div>${reactionsHtml}${threadHtml}
        </div>
        <div class="message-actions">
          <button class="btn-icon" title="React" data-action="react" data-msg="${msg.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></button>
          <button class="btn-icon" title="Reply in thread" data-action="thread" data-msg="${msg.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></button>
          ${isOwn ? `<button class="btn-icon" title="Delete" data-action="delete" data-msg="${msg.id}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>` : ''}
        </div></div>`;
      lastUserId = msg.userId; lastTs = msg.ts;
    });

    if (msgs.length === 0 && ch) html += `<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">No messages yet. Be the first to say something!</div>`;
    messagesListEl.innerHTML = html;
    scrollToBottom();
  }

  function scrollToBottom() { requestAnimationFrame(() => { messagesContainer.scrollTop = messagesContainer.scrollHeight; }); }

  function renderThread(msgId) {
    const msgs = getChannelMessages(activeChannelId);
    const parentMsg = msgs.find(m => m.id === msgId);
    if (!parentMsg) return;
    activeThreadMsgId = msgId;
    const ch = getChannels().find(c => c.id === activeChannelId);
    threadChannel.textContent = ch ? `#${ch.name}` : '';
    const pu = resolveUser(parentMsg.userId);
    let html = `<div class="message"><div class="message-avatar" style="background:${colorFor(pu.name)}">${initials(pu.name)}</div>
      <div class="message-body"><div class="message-meta"><span class="message-author">${escHtml(pu.name)}</span><span class="message-time">${formatTime(parentMsg.ts)}</span></div>
      <div class="message-text">${formatText(parentMsg.text)}</div></div></div>
      <div class="date-divider"><span>${(parentMsg.threadReplies||[]).length} ${(parentMsg.threadReplies||[]).length === 1 ? 'reply' : 'replies'}</span></div>`;
    (parentMsg.threadReplies || []).forEach(reply => {
      const u = resolveUser(reply.userId);
      html += `<div class="message"><div class="message-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}</div>
        <div class="message-body"><div class="message-meta"><span class="message-author">${escHtml(u.name)}</span><span class="message-time">${formatTime(reply.ts)}</span></div>
        <div class="message-text">${formatText(reply.text)}</div></div></div>`;
    });
    threadMessages.innerHTML = html;
    threadPanel.classList.add('open');
    memberPanel.classList.remove('open');
    requestAnimationFrame(() => { threadMessages.scrollTop = threadMessages.scrollHeight; });
  }

  function renderMembers() {
    const allUsers = getUsers();
    const online = allUsers.filter(u => u.status === 'online');
    const offline = allUsers.filter(u => u.status !== 'online');
    let html = `<div style="padding:6px 10px;font-size:12px;color:var(--text-muted);font-weight:700">Online — ${online.length}</div>`;
    online.forEach(u => { html += memberItemHTML(u); });
    if (offline.length) {
      html += `<div style="padding:6px 10px;font-size:12px;color:var(--text-muted);font-weight:700;margin-top:8px">Offline — ${offline.length}</div>`;
      offline.forEach(u => { html += memberItemHTML(u); });
    }
    memberList.innerHTML = html;
    memberCount.textContent = allUsers.length;
  }

  function memberItemHTML(u) {
    const dot = u.status === 'online' ? 'var(--green)' : 'var(--text-muted)';
    return `<div class="member-item"><div class="member-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}<span class="status-dot" style="background:${dot}"></span></div>
      <div class="member-info"><div class="member-name">${escHtml(u.name)}${u.id === currentUser.id ? ' (you)' : ''}</div><div class="member-role">${escHtml(u.role || 'Member')}</div></div></div>`;
  }

  function renderRailAvatar() {
    const r = $('#railAvatar');
    r.style.background = colorFor(currentUser.name);
    r.style.display = 'flex'; r.style.alignItems = 'center'; r.style.justifyContent = 'center';
    r.style.fontSize = '13px'; r.style.fontWeight = '700'; r.style.color = '#fff';
    r.textContent = initials(currentUser.name);
  }

  function renderEmojis(filter = '') {
    const filtered = filter ? EMOJIS.filter(e => e.includes(filter)) : EMOJIS;
    emojiGrid.innerHTML = filtered.map(e => `<span>${e}</span>`).join('');
  }

  // ── Actions ──
  function sendMessage(text, isThread = false) {
    if (!text.trim() || !currentUser) return;
    const msg = { id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), userId: currentUser.id, text: text.trim(), ts: Date.now(), reactions: {}, threadReplies: [] };
    if (isThread && activeThreadMsgId) {
      const msgs = getChannelMessages(activeChannelId);
      const parent = msgs.find(m => m.id === activeThreadMsgId);
      if (parent) {
        parent.threadReplies.push({ id: msg.id, userId: msg.userId, text: msg.text, ts: msg.ts });
        updateMessages(activeChannelId, msgs);
        broadcast('thread_reply', { channelId: activeChannelId, parentMsgId: activeThreadMsgId });
        renderThread(activeThreadMsgId); renderMessages();
      }
    } else {
      appendMessage(activeChannelId, msg);
      broadcast('new_message', { channelId: activeChannelId, msgId: msg.id });
      renderMessages();
    }
  }

  function deleteMessage(msgId) {
    let msgs = getChannelMessages(activeChannelId);
    msgs = msgs.filter(m => m.id !== msgId);
    updateMessages(activeChannelId, msgs);
    broadcast('message_deleted', { channelId: activeChannelId, msgId });
    renderMessages();
    if (activeThreadMsgId === msgId) { threadPanel.classList.remove('open'); activeThreadMsgId = null; }
  }

  function toggleReaction(msgId, emoji) {
    const msgs = getChannelMessages(activeChannelId);
    const msg = msgs.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(currentUser.id);
    if (idx > -1) { msg.reactions[emoji].splice(idx, 1); if (!msg.reactions[emoji].length) delete msg.reactions[emoji]; }
    else msg.reactions[emoji].push(currentUser.id);
    updateMessages(activeChannelId, msgs);
    broadcast('reaction', { channelId: activeChannelId, msgId });
    renderMessages();
  }

  function switchChannel(chId) {
    activeChannelId = chId;
    threadPanel.classList.remove('open'); activeThreadMsgId = null;
    renderChannelList(); renderMessages(); closeMobileSidebar();
  }

  function performSearch(query) {
    if (!query.trim()) { searchResults.classList.remove('open'); return; }
    const q = query.toLowerCase(), results = [], allMsgs = getAllMessages(), chs = getChannels();
    Object.entries(allMsgs).forEach(([chId, msgs]) => {
      const ch = chs.find(c => c.id === chId); if (!ch) return;
      msgs.forEach(msg => {
        if (msg.text.toLowerCase().includes(q)) results.push({ channel: ch.name, channelId: chId, msg });
        (msg.threadReplies||[]).forEach(r => { if (r.text.toLowerCase().includes(q)) results.push({ channel: ch.name+' (thread)', channelId: chId, msg: r }); });
      });
    });
    if (!results.length) { searchResultsInner.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">No results for "${escHtml(query)}"</div>`; }
    else {
      const safeQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      searchResultsInner.innerHTML = results.map(r => {
        const u = resolveUser(r.msg.userId);
        const hl = escHtml(r.msg.text).replace(new RegExp(`(${safeQ})`,'gi'), '<mark>$1</mark>');
        return `<div class="search-result-item" data-channel="${r.channelId}"><div class="search-result-channel">#${escHtml(r.channel)} · ${escHtml(u.name)} · ${formatTime(r.msg.ts)}</div><div class="search-result-text">${hl}</div></div>`;
      }).join('');
    }
    searchResults.classList.add('open');
  }

  // ── Typing ──
  let typingTimeout;
  function showTyping(name) {
    typingText.textContent = `${name} is typing...`;
    typingIndicator.classList.add('visible');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => typingIndicator.classList.remove('visible'), 3000);
  }

  // ── UI helpers ──
  function openMobileSidebar() { sidebar.classList.add('mobile-open'); sidebarOverlay.classList.add('visible'); }
  function closeMobileSidebar() { sidebar.classList.remove('mobile-open'); sidebarOverlay.classList.remove('visible'); }
  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  let emojiTargetMsgId = null, emojiInsertMode = 'input';
  function openEmojiPicker(anchor, mode, msgId) {
    emojiInsertMode = mode; emojiTargetMsgId = msgId || null;
    renderEmojis(); emojiSearchEl.value = '';
    const r = anchor.getBoundingClientRect();
    emojiPicker.style.bottom = (window.innerHeight - r.top + 8)+'px';
    emojiPicker.style.left = Math.min(r.left, window.innerWidth - 340)+'px';
    emojiPicker.style.top = 'auto';
    emojiPicker.classList.add('open');
  }
  function closeEmojiPicker() { emojiPicker.classList.remove('open'); emojiTargetMsgId = null; }
  function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160)+'px'; }

  // ── BroadcastChannel listener ──
  if (bc) {
    bc.onmessage = (e) => {
      const { type, payload, senderId } = e.data;
      if (senderId === (currentUser && currentUser.id)) return;
      switch (type) {
        case 'new_message': if (payload.channelId === activeChannelId) renderMessages(); break;
        case 'thread_reply': if (payload.channelId === activeChannelId) { renderMessages(); if (activeThreadMsgId === payload.parentMsgId) renderThread(payload.parentMsgId); } break;
        case 'message_deleted': if (payload.channelId === activeChannelId) renderMessages(); break;
        case 'reaction': if (payload.channelId === activeChannelId) renderMessages(); break;
        case 'new_channel': renderChannelList(); break;
        case 'user_joined': case 'user_online': case 'user_offline':
          renderDMList(); if (memberPanel.classList.contains('open')) renderMembers(); break;
        case 'typing': if (payload.channelId === activeChannelId && payload.userName) showTyping(payload.userName); break;
      }
    };
  }

  let lastSnap = JSON.stringify(getAllMessages());
  setInterval(() => {
    if (!currentUser) return;
    const cur = JSON.stringify(getAllMessages());
    if (cur !== lastSnap) { lastSnap = cur; renderMessages(); if (activeThreadMsgId) renderThread(activeThreadMsgId); }
    renderDMList();
  }, 2000);

  // ── Event listeners ──
  authToggleLink.addEventListener('click', (e) => { e.preventDefault(); toggleAuthMode(); });
  authForm.addEventListener('submit', handleAuth);
  $('#logoutBtn').addEventListener('click', logout);

  channelListEl.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li && li.dataset.channel) switchChannel(li.dataset.channel); });

  dmListEl.addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li || !li.dataset.user) return;
    const userId = li.dataset.user, user = resolveUser(userId);
    const ids = [currentUser.id, userId].sort(), dmId = 'dm_' + ids.join('_');
    const chs = getChannels();
    if (!chs.find(c => c.id === dmId)) { chs.push({ id: dmId, name: user.name, topic: `Direct message with ${user.name}`, createdBy: currentUser.id }); saveChannels(chs); }
    switchChannel(dmId);
  });

  $('#sendBtn').addEventListener('click', () => { sendMessage(messageInput.value); messageInput.value = ''; autoResize(messageInput); });
  messageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(messageInput.value); messageInput.value = ''; autoResize(messageInput); } });
  let typingBC;
  messageInput.addEventListener('input', () => { autoResize(messageInput); clearTimeout(typingBC); typingBC = setTimeout(() => { if (currentUser && messageInput.value.trim()) broadcast('typing', { channelId: activeChannelId, userName: currentUser.name }); }, 300); });

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
    const name = $('#newChannelName').value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!name) return;
    const desc = $('#newChannelDesc').value.trim(), id = 'c_' + Date.now(), chs = getChannels();
    if (chs.find(c => c.name === name)) { alert('Channel already exists!'); return; }
    chs.push({ id, name, topic: desc || '', createdBy: currentUser.id });
    saveChannels(chs); broadcast('new_channel', { channelId: id });
    renderChannelList(); switchChannel(id); closeModal('addChannelModal');
    $('#newChannelName').value = ''; $('#newChannelDesc').value = '';
  });

  $('#channelsToggle').addEventListener('click', (e) => { if (e.target.closest('.btn-tiny')) return; e.currentTarget.classList.toggle('collapsed'); channelListEl.style.display = e.currentTarget.classList.contains('collapsed') ? 'none' : ''; });
  $('#usersToggle').addEventListener('click', () => { $('#usersToggle').classList.toggle('collapsed'); dmListEl.style.display = $('#usersToggle').classList.contains('collapsed') ? 'none' : ''; });

  $$('.modal-close, .btn-secondary[data-modal]').forEach(b => { b.addEventListener('click', () => closeModal(b.dataset.modal)); });
  $$('.modal-overlay').forEach(o => { o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('open'); }); });

  $('#railAvatar').addEventListener('click', () => {
    const a = $('#profileAvatarLg'); a.style.background = colorFor(currentUser.name); a.textContent = initials(currentUser.name);
    $('#profileName').value = currentUser.name; $('#profileStatus').value = ''; openModal('profileModal');
  });
  $('#saveProfileBtn').addEventListener('click', () => {
    const name = $('#profileName').value.trim();
    if (name && name !== currentUser.name) {
      currentUser.name = name;
      const users = getUsers(), u = users.find(x => x.id === currentUser.id);
      if (u) { u.name = name; saveUsers(users); }
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
    if (currentUser) { const users = getUsers(), u = users.find(x => x.id === currentUser.id); if (u) { u.status = 'offline'; saveUsers(users); } broadcast('user_offline', { userId: currentUser.id }); }
  });

  // ── Init ──
  const existing = getSession();
  if (existing) { currentUser = existing; enterApp(); }
})();
