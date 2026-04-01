/* ========================================
   SlackFlow — Client App
   Socket.IO + REST auth
   ======================================== */

(function () {
  'use strict';

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

  // ── In-memory data (populated from server) ──
  let currentUser = null;
  let authToken = sessionStorage.getItem('sf_token') || null;
  let users = [];
  let channels = [];
  let messages = {};
  let activeChannelId = 'c_general';
  let activeThreadMsgId = null;

  // ── Socket.IO ──
  let socket = null;

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

  let isRegisterMode = false;

  // ==============================
  //  AUTH
  // ==============================

  function showAuthError(msg) {
    authError.textContent = msg;
    authError.classList.add('visible');
  }

  function hideAuthError() {
    authError.classList.remove('visible');
  }

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

  async function handleAuth(e) {
    e.preventDefault();
    hideAuthError();

    const username = authUsername.value.trim().toLowerCase();
    const password = authPassword.value;
    const displayName = authName.value.trim();

    if (!username || !password) {
      showAuthError('Please fill in all fields.');
      return;
    }

    if (isRegisterMode && !displayName) {
      showAuthError('Please enter a display name.');
      return;
    }

    const endpoint = isRegisterMode ? '/api/register' : '/api/login';
    const body = isRegisterMode
      ? { username, password, name: displayName }
      : { username, password };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        showAuthError(data.error || 'Something went wrong.');
        return;
      }

      authToken = data.token;
      currentUser = data.user;
      sessionStorage.setItem('sf_token', authToken);
      enterApp();
    } catch {
      showAuthError('Could not reach the server.');
    }
  }

  function logout() {
    if (socket) socket.disconnect();
    socket = null;
    currentUser = null;
    authToken = null;
    sessionStorage.removeItem('sf_token');
    users = [];
    channels = [];
    messages = {};
    appWrapper.style.display = 'none';
    authScreen.style.display = '';
    authUsername.value = '';
    authPassword.value = '';
    authName.value = '';
    hideAuthError();
  }

  // ==============================
  //  APP ENTRY
  // ==============================

  async function enterApp() {
    try {
      const res = await fetch('/api/data', {
        headers: { 'Authorization': 'Bearer ' + authToken },
      });
      if (!res.ok) {
        logout();
        showAuthError('Session expired. Please sign in again.');
        return;
      }
      const d = await res.json();
      users = d.users;
      channels = d.channels;
      messages = d.messages;
    } catch {
      logout();
      showAuthError('Could not reach the server.');
      return;
    }

    authScreen.style.display = 'none';
    appWrapper.style.display = 'flex';

    connectSocket();
    renderAll();
    messageInput.focus();
  }

  // ==============================
  //  SOCKET.IO CONNECTION
  // ==============================

  function connectSocket() {
    if (socket) socket.disconnect();

    socket = io();

    socket.on('connect', () => {
      socket.emit('authenticate', authToken);
    });

    socket.on('authenticated', () => {
      socket.emit('join_channel', activeChannelId);
    });

    socket.on('auth_error', () => {
      logout();
      showAuthError('Session expired. Please sign in again.');
    });

    // ── Real-time events ──

    socket.on('new_message', ({ channelId, message }) => {
      if (!messages[channelId]) messages[channelId] = [];
      const exists = messages[channelId].find(m => m.id === message.id);
      if (!exists) messages[channelId].push(message);
      if (channelId === activeChannelId) renderMessages();
    });

    socket.on('thread_reply', ({ channelId, parentMsgId, reply }) => {
      const msgs = messages[channelId];
      if (!msgs) return;
      const parent = msgs.find(m => m.id === parentMsgId);
      if (!parent) return;
      if (!parent.threadReplies) parent.threadReplies = [];
      const exists = parent.threadReplies.find(r => r.id === reply.id);
      if (!exists) parent.threadReplies.push(reply);
      if (channelId === activeChannelId) {
        renderMessages();
        if (activeThreadMsgId === parentMsgId) renderThread(parentMsgId);
      }
    });

    socket.on('reaction_updated', ({ channelId, msgId, reactions }) => {
      const msgs = messages[channelId];
      if (!msgs) return;
      const msg = msgs.find(m => m.id === msgId);
      if (msg) msg.reactions = reactions;
      if (channelId === activeChannelId) renderMessages();
    });

    socket.on('message_deleted', ({ channelId, msgId }) => {
      if (messages[channelId]) {
        messages[channelId] = messages[channelId].filter(m => m.id !== msgId);
      }
      if (channelId === activeChannelId) renderMessages();
      if (activeThreadMsgId === msgId) {
        threadPanel.classList.remove('open');
        activeThreadMsgId = null;
      }
    });

    socket.on('channel_created', ({ channel }) => {
      if (!channels.find(c => c.id === channel.id)) channels.push(channel);
      if (!messages[channel.id]) messages[channel.id] = [];
      renderChannelList();
    });

    socket.on('dm_opened', ({ channelId }) => {
      const ch = channels.find(c => c.id === channelId);
      if (!messages[channelId]) messages[channelId] = [];
      switchChannel(channelId);
      if (ch) socket.emit('join_channel', channelId);
    });

    socket.on('user_joined', ({ user }) => {
      const existing = users.find(u => u.id === user.id);
      if (existing) Object.assign(existing, user);
      else users.push(user);
      renderDMList();
      if (memberPanel.classList.contains('open')) renderMembers();
    });

    socket.on('user_status', ({ userId, status }) => {
      const u = users.find(x => x.id === userId);
      if (u) u.status = status;
      renderDMList();
      if (memberPanel.classList.contains('open')) renderMembers();
    });

    socket.on('user_updated', ({ user }) => {
      const existing = users.find(u => u.id === user.id);
      if (existing) Object.assign(existing, user);
      if (user.id === currentUser.id) currentUser = user;
      renderAll();
    });

    socket.on('user_typing', ({ channelId, userName }) => {
      if (channelId === activeChannelId) showTyping(userName);
    });
  }

  // ==============================
  //  RENDER
  // ==============================

  function renderAll() {
    renderChannelList();
    renderDMList();
    renderMessages();
    renderRailAvatar();
    renderEmojis();
  }

  function renderChannelList() {
    channelListEl.innerHTML = channels.filter(c => !c.id.startsWith('dm_')).map(ch => `
      <li class="${ch.id === activeChannelId ? 'active' : ''}" data-channel="${ch.id}">
        <span class="channel-hash">#</span>
        <span>${escHtml(ch.name)}</span>
      </li>
    `).join('');
  }

  function renderDMList() {
    const others = users.filter(u => u.id !== currentUser.id);
    dmListEl.innerHTML = others.map(u => `
      <li data-user="${u.id}">
        <span class="dm-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}</span>
        <span>${escHtml(u.name)}</span>
        <span class="dm-status ${u.status === 'online' ? 'online' : 'offline'}"></span>
      </li>
    `).join('');

    if (others.length === 0) {
      dmListEl.innerHTML = '<li style="color:var(--text-muted);font-size:12px;cursor:default;padding-left:26px">No other users yet</li>';
    }
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function formatText(text) {
    return escHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>')
      .replace(/@(\w[\w\s]*\w)/g, '<span class="mention">@$1</span>');
  }

  function resolveUser(userId) {
    return users.find(u => u.id === userId) || { id: userId, name: 'Deleted User', status: 'offline' };
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
      html += `
        <div class="channel-intro">
          <div class="channel-intro-icon">${isDM ? '💬' : '#'}</div>
          <h2>${isDM ? '' : '#'}${escHtml(ch.name)}</h2>
          <p>${ch.topic ? escHtml(ch.topic) + '. ' : ''}This is the very beginning of ${isDM ? 'your conversation' : `the <strong>#${escHtml(ch.name)}</strong> channel`}.</p>
        </div>
      `;
    }

    let lastDate = '';
    let lastUserId = '';
    let lastTs = 0;

    msgs.forEach(msg => {
      const user = resolveUser(msg.userId);
      const date = formatDate(msg.ts);
      const isCompact = (msg.userId === lastUserId && msg.ts - lastTs < 300000 && date === lastDate);

      if (date !== lastDate) {
        html += `<div class="date-divider"><span>${date}</span></div>`;
        lastDate = date;
      }

      const reactionsHtml = Object.keys(msg.reactions || {}).length > 0 ?
        `<div class="reactions">${Object.entries(msg.reactions).map(([emoji, uids]) =>
          `<span class="reaction ${uids.includes(currentUser.id) ? 'reacted' : ''}" data-emoji="${emoji}" data-msg="${msg.id}">
            ${emoji} <span class="reaction-count">${uids.length}</span>
          </span>`
        ).join('')}</div>` : '';

      const threadCount = (msg.threadReplies || []).length;
      const threadHtml = threadCount > 0 ?
        `<div class="thread-link" data-msg="${msg.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          <span class="thread-reply-count">${threadCount} ${threadCount === 1 ? 'reply' : 'replies'}</span>
        </div>` : '';

      const isOwn = msg.userId === currentUser.id;

      html += `
        <div class="message ${isCompact ? 'compact' : ''}" data-msg="${msg.id}">
          <div class="message-avatar" style="background:${colorFor(user.name)}">${initials(user.name)}</div>
          <div class="message-body">
            <div class="message-meta">
              <span class="message-author">${escHtml(user.name)}</span>
              <span class="message-time">${formatTime(msg.ts)}</span>
            </div>
            <div class="message-text">${formatText(msg.text)}</div>
            ${reactionsHtml}
            ${threadHtml}
          </div>
          <div class="message-actions">
            <button class="btn-icon" title="React" data-action="react" data-msg="${msg.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
            </button>
            <button class="btn-icon" title="Reply in thread" data-action="thread" data-msg="${msg.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
            </button>
            ${isOwn ? `<button class="btn-icon" title="Delete" data-action="delete" data-msg="${msg.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>` : ''}
          </div>
        </div>
      `;

      lastUserId = msg.userId;
      lastTs = msg.ts;
    });

    if (msgs.length === 0 && ch) {
      html += `<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">No messages yet. Be the first to say something!</div>`;
    }

    messagesListEl.innerHTML = html;
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  // ── Thread ──
  function renderThread(msgId) {
    const msgs = messages[activeChannelId] || [];
    const parentMsg = msgs.find(m => m.id === msgId);
    if (!parentMsg) return;

    activeThreadMsgId = msgId;
    const ch = channels.find(c => c.id === activeChannelId);
    threadChannel.textContent = ch ? `#${ch.name}` : '';

    const parentUser = resolveUser(parentMsg.userId);
    let html = `
      <div class="message">
        <div class="message-avatar" style="background:${colorFor(parentUser.name)}">${initials(parentUser.name)}</div>
        <div class="message-body">
          <div class="message-meta">
            <span class="message-author">${escHtml(parentUser.name)}</span>
            <span class="message-time">${formatTime(parentMsg.ts)}</span>
          </div>
          <div class="message-text">${formatText(parentMsg.text)}</div>
        </div>
      </div>
      <div class="date-divider"><span>${(parentMsg.threadReplies || []).length} ${(parentMsg.threadReplies || []).length === 1 ? 'reply' : 'replies'}</span></div>
    `;

    (parentMsg.threadReplies || []).forEach(reply => {
      const u = resolveUser(reply.userId);
      html += `
        <div class="message">
          <div class="message-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}</div>
          <div class="message-body">
            <div class="message-meta">
              <span class="message-author">${escHtml(u.name)}</span>
              <span class="message-time">${formatTime(reply.ts)}</span>
            </div>
            <div class="message-text">${formatText(reply.text)}</div>
          </div>
        </div>
      `;
    });

    threadMessages.innerHTML = html;
    threadPanel.classList.add('open');
    memberPanel.classList.remove('open');
    requestAnimationFrame(() => { threadMessages.scrollTop = threadMessages.scrollHeight; });
  }

  // ── Members ──
  function renderMembers() {
    const online = users.filter(u => u.status === 'online');
    const offline = users.filter(u => u.status !== 'online');

    let html = `<div style="padding:6px 10px;font-size:12px;color:var(--text-muted);font-weight:700">Online — ${online.length}</div>`;
    online.forEach(u => { html += memberItemHTML(u); });
    if (offline.length) {
      html += `<div style="padding:6px 10px;font-size:12px;color:var(--text-muted);font-weight:700;margin-top:8px">Offline — ${offline.length}</div>`;
      offline.forEach(u => { html += memberItemHTML(u); });
    }
    memberList.innerHTML = html;
    memberCount.textContent = users.length;
  }

  function memberItemHTML(u) {
    const dotColor = u.status === 'online' ? 'var(--green)' : 'var(--text-muted)';
    return `
      <div class="member-item">
        <div class="member-avatar" style="background:${colorFor(u.name)}">
          ${initials(u.name)}
          <span class="status-dot" style="background:${dotColor}"></span>
        </div>
        <div class="member-info">
          <div class="member-name">${escHtml(u.name)}${u.id === currentUser.id ? ' (you)' : ''}</div>
          <div class="member-role">${escHtml(u.role || 'Member')}</div>
        </div>
      </div>
    `;
  }

  // ── Rail avatar ──
  function renderRailAvatar() {
    const rail = $('#railAvatar');
    rail.style.background = colorFor(currentUser.name);
    rail.style.display = 'flex';
    rail.style.alignItems = 'center';
    rail.style.justifyContent = 'center';
    rail.style.fontSize = '13px';
    rail.style.fontWeight = '700';
    rail.style.color = '#fff';
    rail.textContent = initials(currentUser.name);
  }

  // ── Emoji picker ──
  function renderEmojis(filter = '') {
    const filtered = filter ? EMOJIS.filter(e => e.includes(filter)) : EMOJIS;
    emojiGrid.innerHTML = filtered.map(e => `<span>${e}</span>`).join('');
  }

  // ── Typing indicator ──
  let typingTimeout;
  function showTyping(name) {
    typingText.textContent = `${name} is typing...`;
    typingIndicator.classList.add('visible');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => typingIndicator.classList.remove('visible'), 3000);
  }

  // ==============================
  //  ACTIONS (emit to server)
  // ==============================

  function sendMessage(text, isThread = false) {
    if (!text.trim() || !socket) return;

    if (isThread && activeThreadMsgId) {
      socket.emit('thread_reply', {
        channelId: activeChannelId,
        parentMsgId: activeThreadMsgId,
        text: text.trim(),
      });
    } else {
      socket.emit('send_message', {
        channelId: activeChannelId,
        text: text.trim(),
      });
    }
  }

  function deleteMessage(msgId) {
    if (!socket) return;
    socket.emit('delete_message', { channelId: activeChannelId, msgId });
  }

  function toggleReaction(msgId, emoji) {
    if (!socket) return;
    socket.emit('reaction', { channelId: activeChannelId, msgId, emoji });
  }

  function switchChannel(channelId) {
    if (socket && activeChannelId) socket.emit('leave_channel', activeChannelId);
    activeChannelId = channelId;
    if (socket) socket.emit('join_channel', channelId);
    threadPanel.classList.remove('open');
    activeThreadMsgId = null;
    renderChannelList();
    renderMessages();
    closeMobileSidebar();
  }

  // ── Search ──
  function performSearch(query) {
    if (!query.trim()) { searchResults.classList.remove('open'); return; }
    const q = query.toLowerCase();
    const results = [];

    Object.entries(messages).forEach(([chId, msgs]) => {
      const ch = channels.find(c => c.id === chId);
      if (!ch) return;
      msgs.forEach(msg => {
        if (msg.text.toLowerCase().includes(q))
          results.push({ channel: ch.name, channelId: chId, msg });
        (msg.threadReplies || []).forEach(reply => {
          if (reply.text.toLowerCase().includes(q))
            results.push({ channel: ch.name + ' (thread)', channelId: chId, msg: reply });
        });
      });
    });

    if (results.length === 0) {
      searchResultsInner.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">No results for "${escHtml(query)}"</div>`;
    } else {
      searchResultsInner.innerHTML = results.map(r => {
        const user = resolveUser(r.msg.userId);
        const safeQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const highlighted = escHtml(r.msg.text).replace(new RegExp(`(${safeQ})`, 'gi'), '<mark>$1</mark>');
        return `
          <div class="search-result-item" data-channel="${r.channelId}">
            <div class="search-result-channel">#${escHtml(r.channel)} · ${escHtml(user.name)} · ${formatTime(r.msg.ts)}</div>
            <div class="search-result-text">${highlighted}</div>
          </div>
        `;
      }).join('');
    }
    searchResults.classList.add('open');
  }

  // ── Mobile sidebar ──
  function openMobileSidebar() { sidebar.classList.add('mobile-open'); sidebarOverlay.classList.add('visible'); }
  function closeMobileSidebar() { sidebar.classList.remove('mobile-open'); sidebarOverlay.classList.remove('visible'); }

  // ── Modals ──
  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  // ── Emoji picker ──
  let emojiTargetMsgId = null;
  let emojiInsertMode = 'input';

  function openEmojiPicker(anchorEl, mode, msgId) {
    emojiInsertMode = mode;
    emojiTargetMsgId = msgId || null;
    renderEmojis();
    emojiSearchEl.value = '';
    const rect = anchorEl.getBoundingClientRect();
    emojiPicker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    emojiPicker.style.left = Math.min(rect.left, window.innerWidth - 340) + 'px';
    emojiPicker.style.top = 'auto';
    emojiPicker.classList.add('open');
  }

  function closeEmojiPicker() { emojiPicker.classList.remove('open'); emojiTargetMsgId = null; }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  // ==============================
  //  EVENT LISTENERS
  // ==============================

  // Auth
  authToggleLink.addEventListener('click', (e) => { e.preventDefault(); toggleAuthMode(); });
  authForm.addEventListener('submit', handleAuth);

  // Logout
  $('#logoutBtn').addEventListener('click', logout);

  // Channel click
  channelListEl.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li && li.dataset.channel) switchChannel(li.dataset.channel);
  });

  // DM click
  dmListEl.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li || !li.dataset.user) return;
    if (!socket) return;
    socket.emit('open_dm', { targetUserId: li.dataset.user });
  });

  // Send message
  $('#sendBtn').addEventListener('click', () => {
    sendMessage(messageInput.value);
    messageInput.value = '';
    autoResize(messageInput);
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(messageInput.value);
      messageInput.value = '';
      autoResize(messageInput);
    }
  });

  let typingBroadcastTimeout;
  messageInput.addEventListener('input', () => {
    autoResize(messageInput);
    clearTimeout(typingBroadcastTimeout);
    typingBroadcastTimeout = setTimeout(() => {
      if (socket && messageInput.value.trim()) {
        socket.emit('typing', { channelId: activeChannelId });
      }
    }, 300);
  });

  // Thread send
  $('#threadSendBtn').addEventListener('click', () => {
    sendMessage(threadInput.value, true);
    threadInput.value = '';
    autoResize(threadInput);
  });

  threadInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(threadInput.value, true);
      threadInput.value = '';
      autoResize(threadInput);
    }
  });
  threadInput.addEventListener('input', () => autoResize(threadInput));

  // Thread close
  $('#threadClose').addEventListener('click', () => {
    threadPanel.classList.remove('open');
    activeThreadMsgId = null;
  });

  // Message actions
  messagesListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      const msgId = btn.dataset.msg;
      if (action === 'thread') renderThread(msgId);
      if (action === 'react') openEmojiPicker(btn, 'reaction', msgId);
      if (action === 'delete') {
        if (confirm('Delete this message?')) deleteMessage(msgId);
      }
      return;
    }
    const threadLink = e.target.closest('.thread-link');
    if (threadLink) { renderThread(threadLink.dataset.msg); return; }
    const reaction = e.target.closest('.reaction');
    if (reaction) { toggleReaction(reaction.dataset.msg, reaction.dataset.emoji); }
  });

  // Emoji picker
  $('#emojiBtn').addEventListener('click', (e) => {
    if (emojiPicker.classList.contains('open')) closeEmojiPicker();
    else openEmojiPicker(e.currentTarget, 'input');
  });

  emojiGrid.addEventListener('click', (e) => {
    if (e.target.tagName === 'SPAN') {
      const emoji = e.target.textContent;
      if (emojiInsertMode === 'reaction' && emojiTargetMsgId) toggleReaction(emojiTargetMsgId, emoji);
      else { messageInput.value += emoji; messageInput.focus(); }
      closeEmojiPicker();
    }
  });

  emojiSearchEl.addEventListener('input', () => renderEmojis(emojiSearchEl.value));

  document.addEventListener('click', (e) => {
    if (emojiPicker.classList.contains('open') && !emojiPicker.contains(e.target) && !e.target.closest('#emojiBtn') && !e.target.closest('[data-action="react"]'))
      closeEmojiPicker();
  });

  // Members
  $('#memberListBtn').addEventListener('click', () => {
    memberPanel.classList.toggle('open');
    if (memberPanel.classList.contains('open')) { threadPanel.classList.remove('open'); renderMembers(); }
  });
  $('#memberPanelClose').addEventListener('click', () => { memberPanel.classList.remove('open'); });

  // Search
  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => performSearch(searchInput.value), 300);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchInput.value = ''; searchResults.classList.remove('open'); }
  });
  searchResultsInner.addEventListener('click', (e) => {
    const item = e.target.closest('.search-result-item');
    if (item) { switchChannel(item.dataset.channel); searchInput.value = ''; searchResults.classList.remove('open'); }
  });
  document.addEventListener('click', (e) => {
    if (searchResults.classList.contains('open') && !searchResults.contains(e.target) && !e.target.closest('.sidebar-search'))
      searchResults.classList.remove('open');
  });

  // Add channel
  $('#addChannelBtn').addEventListener('click', (e) => { e.stopPropagation(); openModal('addChannelModal'); });

  $('#createChannelBtn').addEventListener('click', () => {
    const name = $('#newChannelName').value.trim();
    const desc = $('#newChannelDesc').value.trim();
    if (!name || !socket) return;
    socket.emit('create_channel', { name, topic: desc });
    closeModal('addChannelModal');
    $('#newChannelName').value = '';
    $('#newChannelDesc').value = '';
  });

  // Section toggles
  $('#channelsToggle').addEventListener('click', (e) => {
    if (e.target.closest('.btn-tiny')) return;
    e.currentTarget.classList.toggle('collapsed');
    channelListEl.style.display = e.currentTarget.classList.contains('collapsed') ? 'none' : '';
  });
  $('#usersToggle').addEventListener('click', () => {
    $('#usersToggle').classList.toggle('collapsed');
    dmListEl.style.display = $('#usersToggle').classList.contains('collapsed') ? 'none' : '';
  });

  // Modal close
  $$('.modal-close, .btn-secondary[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
  });

  // Profile
  $('#railAvatar').addEventListener('click', () => {
    const avatarEl = $('#profileAvatarLg');
    avatarEl.style.background = colorFor(currentUser.name);
    avatarEl.textContent = initials(currentUser.name);
    $('#profileName').value = currentUser.name;
    $('#profileStatus').value = '';
    openModal('profileModal');
  });

  $('#saveProfileBtn').addEventListener('click', () => {
    const name = $('#profileName').value.trim();
    if (name && name !== currentUser.name && socket) {
      socket.emit('update_profile', { name });
    }
    closeModal('profileModal');
  });

  // Mobile
  $('#mobileMenuBtn').addEventListener('click', openMobileSidebar);
  sidebarOverlay.addEventListener('click', closeMobileSidebar);

  // Keyboard: Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      threadPanel.classList.remove('open');
      memberPanel.classList.remove('open');
      closeEmojiPicker();
      $$('.modal-overlay.open').forEach(m => m.classList.remove('open'));
      searchResults.classList.remove('open');
      closeMobileSidebar();
    }
  });

  // ==============================
  //  INIT — check for existing session
  // ==============================

  if (authToken) {
    enterApp();
  }

})();
