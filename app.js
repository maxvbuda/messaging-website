/* ========================================
   SlackFlow — Client
   Connects to remote backend via Socket.IO.
   Default server URL is set in DEFAULT_SERVER_URL (workspaces block).
   ======================================== */

(function () {
  'use strict';

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

  /** Resolve a stored avatar URL to a displayable src (prepend backend for /api/ paths). */
  function resolveAvatarUrl(url) {
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    if (url.startsWith('/')) return backUrl() + url;
    return url;
  }

  /**
   * Returns an HTML string for an avatar element.
   * Renders a circular/rounded image if the user has an avatarUrl, otherwise
   * falls back to the coloured initials div.
   * @param {object} user - user object with name, avatarUrl
   * @param {string} cls  - CSS class to apply to the container div
   * @param {string} [extraStyle] - optional inline style string for the container
   */
  function avatarEl(user, cls, extraStyle) {
    const src = resolveAvatarUrl(user && user.avatarUrl);
    if (src) {
      return `<div class="${cls}"${extraStyle ? ` style="${extraStyle}"` : ''}><img src="${escHtml(src)}" alt="${escHtml((user && user.name) || '')}"></div>`;
    }
    const name = (user && user.name) || '?';
    return `<div class="${cls}" style="background:${colorFor(name)}${extraStyle ? ';' + extraStyle : ''}">${initials(name)}</div>`;
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
  let users = [];
  let channels = [];
  let messages = {};
  let activeChannelId = 'c_general';
  let activeThreadMsgId = null;
  let socket = null;

  const DEFAULT_WEBRTC_STUN = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.relay.metered.ca:80' },
  ];
  let webrtcIceConfig = { iceServers: DEFAULT_WEBRTC_STUN.map(s => ({ urls: s.urls })) };

  async function openRelayEphemeralBrowser(userId) {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const secret = 'openrelayprojectsecret';
    const host = 'staticauth.openrelay.metered.ca';
    const ttl = 86400;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:${String(userId || 'u').replace(/:/g, '_').slice(0, 120)}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(username));
    const u8 = new Uint8Array(sigBuf);
    let bin = '';
    u8.forEach(b => { bin += String.fromCharCode(b); });
    const credential = btoa(bin);
    return {
      urls: [
        `turn:${host}:80`,
        `turn:${host}:80?transport=tcp`,
        `turn:${host}:443`,
        `turn:${host}:443?transport=tcp`,
        `turns:${host}:443?transport=tcp`,
      ],
      username,
      credential,
    };
  }

  async function refreshWebRtcIceConfig() {
    if (!currentUser) return;
    if (inServerMode()) {
      if (!authToken) return;
      try {
        const res = await fetch(backUrl() + '/api/ice', { headers: { Authorization: 'Bearer ' + authToken } });
        if (!res.ok) return;
        const d = await res.json();
        if (d.iceServers && Array.isArray(d.iceServers) && d.iceServers.length) {
          webrtcIceConfig = { iceServers: d.iceServers };
        }
      } catch { /* keep default */ }
      return;
    }
    try {
      const iceServers = DEFAULT_WEBRTC_STUN.map(s => ({ urls: s.urls }));
      const relay = await openRelayEphemeralBrowser(currentUser.id);
      if (relay) iceServers.push(relay);
      webrtcIceConfig = { iceServers };
    } catch {
      webrtcIceConfig = { iceServers: DEFAULT_WEBRTC_STUN.map(s => ({ urls: s.urls })) };
    }
  }

  /** Stable WebRTC settings across Chrome / Edge / Safari (ICE trickle end + pooling + bundle). */
  function rtcPeerConnectionConfig() {
    const iceServers = (webrtcIceConfig && Array.isArray(webrtcIceConfig.iceServers) && webrtcIceConfig.iceServers.length)
      ? webrtcIceConfig.iceServers.map(s => ({ ...s }))
      : DEFAULT_WEBRTC_STUN.map(s => ({ urls: s.urls }));
    return {
      iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0,
    };
  }

  let videoPeerId = null;
  let videoSignalChannelId = null;
  let videoPc = null;
  let videoLocalStream = null;
  let videoIcePending = [];
  let videoPendingOffer = null;
  let videoMicMuted = false;
  /** True while startVideoCallWithPeer is mid-flight (prevents double-tap / concurrent dial races). */
  let videoCallDialing = false;

  // ── Notification sound (Web Audio; unlocked after first user gesture) ──
  let sfxCtx = null;
  let sfxUnlockBound = false;
  let incomingCallRingTimer = null;

  function bindNotificationAudioUnlock() {
    if (sfxUnlockBound) return;
    sfxUnlockBound = true;
    const unlock = () => {
      void (async () => {
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return;
          if (!sfxCtx) sfxCtx = new Ctx();
          if (sfxCtx.state === 'suspended') await sfxCtx.resume().catch(() => {});
        } catch { /* ignore */ }
      })();
    };
    document.addEventListener('pointerdown', unlock, { capture: true });
    document.addEventListener('touchstart', unlock, { capture: true, passive: true });
    document.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') stopTitleFlash();
    });
  }

  const SITE_TITLE = document.title;
  let titleFlashTimer = null;

  function channelDisplayName(channelId) {
    const ch = channels.find(c => c.id === channelId);
    if (!ch) return 'SlackFlow';
    return channelId.startsWith('dm_') ? ch.name : '#' + ch.name;
  }

  function stopTitleFlash() {
    if (titleFlashTimer != null) {
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
    }
    document.title = SITE_TITLE;
  }

  function startTitleFlash(label) {
    stopTitleFlash();
    let flip = false;
    titleFlashTimer = setInterval(() => {
      flip = !flip;
      document.title = flip ? `${label} — ${SITE_TITLE}` : SITE_TITLE;
    }, 800);
  }

  /** When the tab is in the background or another channel is open, surface a system notification and flash the title. */
  function notifyIncomingIfAway({ channelId, fromName, body, tag }) {
    if (!currentUser) return;
    const viewingHere = channelId === activeChannelId && document.visibilityState === 'visible';
    if (viewingHere) return;

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const title = `${fromName || 'Someone'} · ${channelDisplayName(channelId)}`;
        const n = new Notification(title, {
          body: (body || 'New message').slice(0, 160),
          tag: tag || `ch-${channelId}`,
          renotify: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
          switchChannel(channelId);
        };
      } catch { /* ignore */ }
    }

    if (document.visibilityState === 'hidden' || channelId !== activeChannelId) {
      startTitleFlash('New message');
    }
  }

  /** Call synchronously from click/submit (before any await) so the browser ties audio to a user gesture. */
  function primeAudioOnUserGesture() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sfxCtx) sfxCtx = new Ctx();
      void sfxCtx.resume();
      if (sfxCtx.state !== 'running') return;
      const t0 = sfxCtx.currentTime;
      const g = sfxCtx.createGain();
      g.gain.value = 0.00002;
      g.connect(sfxCtx.destination);
      const osc = sfxCtx.createOscillator();
      osc.frequency.value = 440;
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + 0.002);
    } catch { /* ignore */ }
    try {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    } catch { /* ignore */ }
  }

  function playBeepOnContext(ctx) {
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.18, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.09);
    osc.connect(g);
    osc.start(t0);
    osc.stop(t0 + 0.18);
  }

  function buzzIfNoSound() {
    try {
      if (navigator.vibrate) navigator.vibrate([40, 35, 50]);
    } catch { /* ignore */ }
  }

  function playNotificationSound() {
    void (async () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!sfxCtx) sfxCtx = new Ctx();
        const ctx = sfxCtx;
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
        }
        if (ctx.state !== 'running') {
          buzzIfNoSound();
          return;
        }
        playBeepOnContext(ctx);
      } catch {
        buzzIfNoSound();
      }
    })();
  }

  function stopIncomingCallRing() {
    if (incomingCallRingTimer != null) {
      clearInterval(incomingCallRingTimer);
      incomingCallRingTimer = null;
    }
  }

  /**
   * North-American wired-phone style ring (440 Hz + 480 Hz Bell spec),
   * with light harmonics and a double-ring cadence (~1s on / ~0.35s gap / ~1s on, then pause).
   */
  function playRingBurstOnContext(ctx) {
    const t0 = ctx.currentTime;
    const peak = 0.11;
    const attack = 0.032;
    const release = 0.09;
    const ringOn = 0.88;
    const interRingGap = 0.28;

    function ringSegment(start, dur) {
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const g = master.gain;
      g.setValueAtTime(0, start);
      g.linearRampToValueAtTime(peak, start + attack);
      g.setValueAtTime(peak, start + dur - release);
      g.exponentialRampToValueAtTime(0.0008, start + dur);

      const bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(master);

      const freqs = [
        [440, 1],
        [480, 1],
        [880, 0.14],
        [960, 0.14],
      ];
      freqs.forEach(([hz, w]) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = hz;
        const gg = ctx.createGain();
        gg.gain.value = w;
        o.connect(gg);
        gg.connect(bus);
        o.start(start);
        o.stop(start + dur);
      });
    }

    ringSegment(t0, ringOn);
    ringSegment(t0 + ringOn + interRingGap, ringOn);
  }

  function playIncomingCallRing() {
    stopIncomingCallRing();
    void (async () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
          buzzIfNoSound();
          return;
        }
        if (!sfxCtx) sfxCtx = new Ctx();
        const ctx = sfxCtx;
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        if (ctx.state !== 'running') {
          buzzIfNoSound();
          return;
        }
        const ringOnce = () => {
          if (!videoPendingOffer) {
            stopIncomingCallRing();
            return;
          }
          playRingBurstOnContext(ctx);
        };
        ringOnce();
        incomingCallRingTimer = setInterval(ringOnce, 4800);
      } catch {
        buzzIfNoSound();
      }
    })();
  }

  /** One welcome ping when Maya opens the app (username or first name, case-insensitive). */
  function maybeWelcomeMayaOnJoin() {
    if (!currentUser) return;
    const uname = (currentUser.username || '').trim().toLowerCase();
    const first = (currentUser.name || '').trim().toLowerCase().split(/\s+/)[0] || '';
    if (uname !== 'maya' && first !== 'maya') return;
    setTimeout(() => playNotificationSound(), 450);
  }

  // ── localStorage fallback (when no server) ──
  function lsLoad(key, fb) { try { return JSON.parse(localStorage.getItem(key)) || fb; } catch { return fb; } }
  function lsSave(key, d) { localStorage.setItem(key, JSON.stringify(d)); }

  let bc;
  try { bc = new BroadcastChannel('slackflow_sync'); } catch { bc = null; }
  function broadcast(type, payload) {
    if (bc && !inServerMode()) bc.postMessage({ type, payload, senderId: currentUser ? currentUser.id : null });
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

  // ── Multi-workspace (per-server URL + token) ──
  const WORKSPACES_LS = 'sf_workspaces_v1';
  const DEFAULT_SERVER_URL = 'https://messaging-website-6qqt.onrender.com';

  function normalizeServerUrl(str) {
    return (str || '').trim().replace(/\/$/, '');
  }

  function loadWorkspacesState() {
    try {
      const raw = localStorage.getItem(WORKSPACES_LS);
      if (raw) {
        const state = JSON.parse(raw);
        if (state && Array.isArray(state.list) && state.list.length) {
          state.list.forEach(w => {
            w.url = typeof w.url === 'string' ? normalizeServerUrl(w.url) : '';
            if (!('token' in w)) w.token = null;
          });
          if (state.list.length === 1 && state.list[0].label === 'SlackFlow 2') {
            state.list[0].label = 'SlackFlow HQ';
            localStorage.setItem(WORKSPACES_LS, JSON.stringify(state));
          } else {
            let touched = false;
            state.list.forEach(w => {
              if (w.label === 'SlackFlow 2') { w.label = 'SlackFlow'; touched = true; }
            });
            if (touched) localStorage.setItem(WORKSPACES_LS, JSON.stringify(state));
          }
          return state;
        }
      }
    } catch { /* ignore */ }
    const legacyTok = localStorage.getItem('sf_token');
    const id = 'ws_default';
    const baseUrl = normalizeServerUrl(DEFAULT_SERVER_URL);
    const state = {
      list: [{ id, label: 'SlackFlow HQ', url: baseUrl, token: baseUrl ? (legacyTok || null) : null }],
      activeId: id,
    };
    localStorage.setItem(WORKSPACES_LS, JSON.stringify(state));
    return state;
  }

  let wsState = loadWorkspacesState();

  function activeWorkspace() {
    let w = wsState.list.find(x => x.id === wsState.activeId);
    if (!w && wsState.list[0]) {
      wsState.activeId = wsState.list[0].id;
      w = wsState.list[0];
    }
    return w || null;
  }

  function backUrl() {
    const w = activeWorkspace();
    return w && w.url ? w.url : '';
  }

  function inServerMode() {
    return !!backUrl();
  }

  let authToken = null;

  function saveWsState() {
    localStorage.setItem(WORKSPACES_LS, JSON.stringify(wsState));
    const w = activeWorkspace();
    if (w && w.token) localStorage.setItem('sf_token', w.token);
    else localStorage.removeItem('sf_token');
    authToken = w && w.token ? w.token : null;
  }

  saveWsState();

  function workspaceIconLetters(label) {
    const s = (label || 'WS').trim();
    if (!s) return '?';
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function removeWorkspaceFromDevice(wsId) {
    if (wsState.list.length < 2) return;
    const w = wsState.list.find(x => x.id === wsId);
    if (!w) return;
    const label = w.label || 'This workspace';
    if (!confirm(`Remove "${label}" from this browser? Its saved sign-in on this device will be cleared.`)) return;
    const wasActive = wsState.activeId === wsId;
    wsState.list = wsState.list.filter(x => x.id !== wsId);
    if (wasActive) {
      wsState.activeId = wsState.list[0].id;
      saveWsState();
      endVideoCall(true);
      if (socket) { socket.disconnect(); socket = null; }
      currentUser = null;
      users = []; channels = []; messages = {};
      activeChannelId = 'c_general';
      activeThreadMsgId = null;
      threadPanel.classList.remove('open');
      appWrapper.style.display = 'none';
      const nw = activeWorkspace();
      renderWorkspaceRail();
      renderSidebarWorkspaceTitle();
      if (nw && nw.token) {
        enterApp();
      } else {
        const p = $('#pendingRegScreen');
        if (p) p.style.display = 'none';
        authScreen.style.display = '';
        setAuthSignInOnly();
        hideAuthError();
        authUsername.value = '';
        authPassword.value = '';
        authName.value = '';
        renderRailAvatar();
      }
    } else {
      saveWsState();
      renderWorkspaceRail();
    }
  }

  function renderWorkspaceRail() {
    const wrap = $('#workspaceRailIcons');
    const aside = $('#workspaceRailAside');
    if (!wrap || !aside) return;
    if (!inServerMode()) {
      aside.style.display = 'none';
      wrap.innerHTML = '';
      return;
    }
    aside.style.display = '';
    const activeId = wsState.activeId;
    const canRemove = wsState.list.length > 1;
    const removeHint = canRemove ? ' — Right-click to remove from this device' : '';
    const icons = wsState.list.map(w => {
      const active = w.id === activeId ? 'active' : '';
      const letters = workspaceIconLetters(w.label);
      const t = escHtml(w.label) + escHtml(removeHint);
      return `<div class="workspace-icon ${active}" data-ws-id="${escHtml(w.id)}" title="${t}">${escHtml(letters)}</div>`;
    }).join('');
    wrap.innerHTML = icons + '<div class="workspace-icon workspace-add" title="Add workspace">+</div>';
    wrap.querySelectorAll('[data-ws-id]').forEach(el => {
      const id = el.getAttribute('data-ws-id');
      el.addEventListener('click', () => { switchWorkspace(id); });
      el.addEventListener('contextmenu', (ev) => {
        if (!canRemove) return;
        ev.preventDefault();
        removeWorkspaceFromDevice(id);
      });
    });
    const addBtn = wrap.querySelector('.workspace-add');
    if (addBtn) addBtn.addEventListener('click', openAddWorkspaceModal);
  }

  function renderSidebarWorkspaceTitle() {
    const el = $('#sidebarWorkspaceTitle');
    if (!el) return;
    const w = activeWorkspace();
    el.textContent = w ? w.label : 'SlackFlow';
  }

  function switchWorkspace(wsId) {
    const w = wsState.list.find(x => x.id === wsId);
    if (!w || w.id === wsState.activeId) return;
    endVideoCall(true);
    if (socket) { socket.disconnect(); socket = null; }
    wsState.activeId = w.id;
    saveWsState();
    currentUser = null;
    users = []; channels = []; messages = {};
    activeChannelId = 'c_general';
    activeThreadMsgId = null;
    threadPanel.classList.remove('open');
    appWrapper.style.display = 'none';
    renderWorkspaceRail();
    renderSidebarWorkspaceTitle();
    if (w.token) {
      enterApp();
    } else {
      const p = $('#pendingRegScreen');
      if (p) p.style.display = 'none';
      authScreen.style.display = '';
      setAuthSignInOnly();
      hideAuthError();
      authUsername.value = '';
      authPassword.value = '';
      authName.value = '';
      renderRailAvatar();
    }
  }

  function sameServerDefaultUrl() {
    const u = backUrl();
    if (u) return u;
    return normalizeServerUrl(DEFAULT_SERVER_URL);
  }

  function openAddWorkspaceModal() {
    const lab = $('#newWorkspaceLabel');
    const u = $('#newWorkspaceUrl');
    const err = $('#addWorkspaceErr');
    const defUrl = normalizeServerUrl(sameServerDefaultUrl());
    if (lab) {
      const alreadyHasThisServer = wsState.list.some(w => normalizeServerUrl(w.url) === defUrl && defUrl);
      lab.value = alreadyHasThisServer ? 'SlackFlow' : '';
    }
    if (u) u.value = sameServerDefaultUrl();
    if (err) { err.textContent = ''; err.classList.remove('visible'); }
    openModal('addWorkspaceModal');
  }

  function confirmAddWorkspace() {
    const labIn = ($('#newWorkspaceLabel') && $('#newWorkspaceLabel').value.trim()) || '';
    let urlIn = ($('#newWorkspaceUrl') && $('#newWorkspaceUrl').value.trim()) || '';
    const err = $('#addWorkspaceErr');
    if (!urlIn) urlIn = sameServerDefaultUrl();
    if (!urlIn) {
      if (err) { err.textContent = 'Enter a server URL (no default server is configured).'; err.classList.add('visible'); }
      return;
    }
    if (!/^https?:\/\//i.test(urlIn)) urlIn = 'https://' + urlIn;
    let parsed;
    try { parsed = new URL(urlIn); } catch {
      if (err) { err.textContent = 'That URL does not look valid.'; err.classList.add('visible'); }
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      if (err) { err.textContent = 'Only http and https URLs are allowed.'; err.classList.add('visible'); }
      return;
    }
    let base = normalizeServerUrl(parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')));
    if (!base) base = parsed.origin;
    const alreadySameServer = wsState.list.some(w => normalizeServerUrl(w.url) === base);
    const label = labIn || (alreadySameServer ? 'SlackFlow' : (parsed.hostname.replace(/^www\./, '') || 'Workspace'));
    const id = 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    wsState.list.push({ id, label, url: base, token: null });
    wsState.activeId = id;
    saveWsState();
    endVideoCall(true);
    if (socket) { socket.disconnect(); socket = null; }
    currentUser = null;
    users = []; channels = []; messages = {};
    activeChannelId = 'c_general';
    activeThreadMsgId = null;
    threadPanel.classList.remove('open');
    appWrapper.style.display = 'none';
    const p = $('#pendingRegScreen');
    if (p) p.style.display = 'none';
    authScreen.style.display = '';
    setAuthSignInOnly();
    hideAuthError();
    authUsername.value = '';
    authPassword.value = '';
    authName.value = '';
    renderWorkspaceRail();
    renderSidebarWorkspaceTitle();
    renderRailAvatar();
    closeModal('addWorkspaceModal');
  }

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
  const authSubtitle = $('#authSubtitle');
  const authFooterNormal = $('#authFooterNormal');
  const authFooterInvite = $('#authFooterInvite');
  const authInviteSignInLink = $('#authInviteSignInLink');
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

  function fileUrl(id) { return backUrl() + '/api/files/' + id; }

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
    if (!file) {
      preview.style.display = 'none';
      preview.innerHTML = '';
      return;
    }
    function attachRemoveHandler() {
      const btn = $('#filePillRemove');
      if (btn) btn.addEventListener('click', () => { pendingFile = null; preview.style.display = 'none'; preview.innerHTML = ''; $('#fileInput').value = ''; });
    }
    if (isImage(file.type)) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        preview.innerHTML = `<div class="img-preview-strip"><div class="img-preview-thumb"><img src="${ev.target.result}" alt="${escHtml(file.name)}"><button class="img-preview-remove" id="filePillRemove" title="Remove attachment">✕</button></div><span class="img-preview-name">${escHtml(file.name)} <span class="file-pill-size">${formatFileSize(file.size)}</span></span></div>`;
        preview.style.display = '';
        attachRemoveHandler();
      };
      reader.readAsDataURL(file);
    } else {
      preview.innerHTML = `<span class="file-pill">📎 ${escHtml(file.name)} <span class="file-pill-size">${formatFileSize(file.size)}</span><button class="file-pill-remove" id="filePillRemove">✕</button></span>`;
      preview.style.display = '';
      attachRemoveHandler();
    }
  }

  async function uploadFile(fileObj) {
    if (!inServerMode()) return null;
    const form = new FormData();
    form.append('file', fileObj);
    try {
      const res = await fetch(backUrl() + '/api/upload', {
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

  function setAuthSignInOnly() {
    isRegisterMode = false;
    hideAuthError();
    authNameField.style.display = 'none';
    authInviteField.style.display = 'none';
    if (authInvite) authInvite.value = '';
    authName.value = '';
    authSubmitBtn.textContent = 'Sign In';
    authSubtitle.textContent = 'Enter your credentials to get started.';
    if (authFooterNormal) authFooterNormal.style.display = '';
    if (authFooterInvite) authFooterInvite.style.display = 'none';
  }

  function setAuthInviteRegisterUI() {
    isRegisterMode = true;
    hideAuthError();
    authNameField.style.display = '';
    authInviteField.style.display = '';
    authSubmitBtn.textContent = 'Create Account';
    authSubtitle.textContent = 'You have an invite link. Finish creating your account below.';
    if (authFooterNormal) authFooterNormal.style.display = 'none';
    if (authFooterInvite) authFooterInvite.style.display = '';
  }

  // Auto-fill invite code, name, username from URL params and switch to register mode
  const urlParams = new URLSearchParams(window.location.search);
  const urlInvite = urlParams.get('invite');
  if (urlInvite) {
    setAuthInviteRegisterUI();
    authInvite.value = urlInvite.toUpperCase();
    if (urlParams.get('name')) authName.value = urlParams.get('name');
    if (urlParams.get('username')) authUsername.value = urlParams.get('username');
    $('#pendingRegScreen').style.display = 'none';
    authScreen.style.display = '';
    window.history.replaceState({}, '', window.location.pathname);
  } else {
    setAuthSignInOnly();
    const p = $('#pendingRegScreen');
    if (p) p.style.display = 'none';
    authScreen.style.display = '';
  }

  async function handleAuth(e) {
    e.preventDefault();
    primeAudioOnUserGesture();
    hideAuthError();

    const username = authUsername.value.trim().toLowerCase();
    const password = authPassword.value;
    const displayName = authName.value.trim();

    if (!username || !password) { showAuthError('Please fill in all fields.'); return; }
    if (username.length < 2) { showAuthError('Username must be at least 2 characters.'); return; }
    if (isRegisterMode && !displayName) { showAuthError('Please enter a display name.'); return; }
    if (isRegisterMode && password.length < 3) { showAuthError('Password must be at least 3 characters.'); return; }

    if (inServerMode()) {
      const endpoint = isRegisterMode ? '/api/register' : '/api/login';
      const inviteCode = authInvite ? authInvite.value.trim() : '';
      const body = isRegisterMode ? { username, password, name: displayName, inviteCode } : { username, password };
      try {
        const res = await fetch(backUrl() + endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await res.json();
        if (!res.ok) { showAuthError(d.error || 'Something went wrong.'); return; }
        authToken = d.token;
        currentUser = d.user;
        const aw = activeWorkspace();
        if (aw) { aw.token = d.token; saveWsState(); }
        localStorage.removeItem('sf_pending_reg_id');
        localStorage.removeItem('sf_pending_reg_token');
        localStorage.removeItem('sf_pending_reg_username');
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
    endVideoCall(true);
    if (inServerMode()) {
      if (socket) socket.disconnect();
      socket = null;
      const w = activeWorkspace();
      if (w) w.token = null;
      saveWsState();
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
    $('#pendingRegScreen').style.display = 'none';
    $('#authScreen').style.display = '';
    setAuthSignInOnly();
    authUsername.value = ''; authPassword.value = ''; authName.value = '';
    hideAuthError();
  }

  // ==============================
  //  APP ENTRY
  // ==============================

  async function enterApp() {
    const pendingEl = $('#pendingRegScreen');
    if (pendingEl) pendingEl.style.display = 'none';

    if (inServerMode()) {
      let d = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const res = await fetch(backUrl() + '/api/data', {
            headers: { 'Authorization': 'Bearer ' + authToken },
          });
          if (res.status === 401) {
            logout();
            showAuthError('Session expired. Please sign in again.');
            return;
          }
          if (!res.ok) {
            if (attempt < 5) { await new Promise(r => setTimeout(r, 2000)); continue; }
            authScreen.style.display = '';
            appWrapper.style.display = 'none';
            showAuthError('Could not load your workspace. You are still signed in — try again in a moment or reload the page.');
            return;
          }
          d = await res.json();
          break;
        } catch {
          if (attempt < 5) { await new Promise(r => setTimeout(r, 2000)); continue; }
          authScreen.style.display = '';
          appWrapper.style.display = 'none';
          showAuthError('Could not reach the server. You are still signed in — try again when you are online or reload.');
          return;
        }
      }
      currentUser = d.currentUser || currentUser;
      users = d.users; channels = d.channels; messages = d.messages;
      await refreshWebRtcIceConfig();
      connectSocket();
    } else {
      users = lsGetUsers();
      channels = lsGetChannels();
      messages = lsGetAllMessages();
      const u = users.find(x => x.id === currentUser.id);
      if (u) { u.status = 'online'; u.lastSeen = Date.now(); lsSaveUsers(users); }
      startLocalHeartbeat();
      startLocalPolling();
      await refreshWebRtcIceConfig();
    }

    authScreen.style.display = 'none';
    appWrapper.style.display = 'flex';
    renderAll();
    maybeWelcomeMayaOnJoin();
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
      if (inServerMode()) return;
      const { type, payload, senderId } = e.data;
      if (senderId === (currentUser && currentUser.id)) return;
      if (type === 'new_message') {
        messages = lsGetAllMessages();
        const cid = payload.channelId;
        const ch = messages[cid] || [];
        const msg = payload.msgId ? ch.find(m => m.id === payload.msgId) : ch[ch.length - 1];
        if (msg && msg.userId && currentUser && msg.userId !== currentUser.id) {
          playNotificationSound();
          const preview = msg.text || (msg.file ? 'Sent a file' : '');
          notifyIncomingIfAway({
            channelId: cid,
            fromName: resolveUser(msg.userId, msg.userName).name,
            body: preview,
            tag: msg.id,
          });
        }
        if (cid === activeChannelId) renderMessages();
      }
      if (type === 'thread_reply') {
        messages = lsGetAllMessages();
        const cid = payload.channelId;
        const parent = (messages[cid] || []).find(m => m.id === payload.parentMsgId);
        const reps = parent && parent.threadReplies;
        const last = reps && reps[reps.length - 1];
        if (last && last.userId && currentUser && last.userId !== currentUser.id) {
          playNotificationSound();
          notifyIncomingIfAway({
            channelId: cid,
            fromName: resolveUser(last.userId, last.userName).name,
            body: 'Thread: ' + (last.text || '').slice(0, 120),
            tag: last.id,
          });
        }
        if (cid === activeChannelId) {
          renderMessages();
          if (activeThreadMsgId === payload.parentMsgId) renderThread(payload.parentMsgId);
        }
      }
      if (type === 'message_deleted' && payload.channelId === activeChannelId) { messages = lsGetAllMessages(); renderMessages(); }
      if (type === 'reaction' && payload.channelId === activeChannelId) { messages = lsGetAllMessages(); renderMessages(); }
      if (type === 'new_channel') { channels = lsGetChannels(); renderChannelList(); }
      if (['user_joined','user_online','user_offline'].includes(type)) { users = lsGetUsers(); renderDMList(); if (memberPanel.classList.contains('open')) renderMembers(); }
      if (type === 'typing' && payload.channelId === activeChannelId && payload.userName) showTyping(payload.userName);
      if (type === 'webrtc_signal') {
        if (!currentUser || !payload || payload.toUserId !== currentUser.id) return;
        void handleWebrtcPeer({
          fromUserId: payload.fromUserId,
          channelId: payload.channelId,
          type: payload.type,
          sdp: payload.sdp,
          candidate: payload.candidate,
          iceDone: payload.iceDone,
        });
      }
    };
  }

  // ==============================
  //  SOCKET.IO (server mode)
  // ==============================

  function dmPeerUserId(channelId) {
    if (!channelId || !channelId.startsWith('dm_') || !currentUser) return null;
    // Prefer the participants array stored on the channel document (most reliable).
    const ch = channels.find(c => c.id === channelId);
    if (ch && Array.isArray(ch.participants) && ch.participants.length === 2) {
      return ch.participants.find(id => id !== currentUser.id) || null;
    }
    // Fallback: parse from channel ID. User IDs are "u_<hex>" so we match two such tokens.
    const inner = channelId.slice(3);
    const m = inner.match(/^(u_[0-9a-f]+)_(u_[0-9a-f]+)$/i);
    if (!m) return null;
    return m[1] === currentUser.id ? m[2] : m[1];
  }

  function icePayload(candidate) {
    if (!candidate) return null;
    if (typeof candidate.toJSON === 'function') return candidate.toJSON();
    return { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex };
  }

  function relayVideo(toUserId, payload) {
    const channelId = payload.channelId || activeChannelId;
    if (!toUserId || !channelId) return;
    if (inServerMode()) {
      if (!socket || !socket.connected) return;
      const relay = {
        toUserId,
        channelId,
        type: payload.type,
        sdp: payload.sdp,
        candidate: payload.candidate,
      };
      if (payload.iceDone === true) relay.iceDone = true;
      socket.emit('webrtc_relay', relay);
    } else {
      if (!bc) return;
      const sig = {
        toUserId,
        channelId,
        type: payload.type,
        sdp: payload.sdp,
        candidate: payload.candidate,
        fromUserId: currentUser.id,
      };
      if (payload.iceDone === true) sig.iceDone = true;
      broadcast('webrtc_signal', sig);
    }
  }

  async function flushIceQueue(pc) {
    const pending = videoIcePending.splice(0, videoIcePending.length);
    for (const c of pending) {
      try {
        if (c && c.__iceEnd) {
          try { await pc.addIceCandidate(); } catch { await pc.addIceCandidate(null); }
        } else {
          await pc.addIceCandidate(c);
        }
      } catch { /* ignore */ }
    }
  }

  function updateVideoRemoteLabel() {
    const el = $('#videoRemoteLabel');
    if (!el) return;
    el.textContent = videoPeerId ? resolveUser(videoPeerId).name : 'Participant';
  }

  async function acquireCallMedia() {
    const attempts = [
      // Full video + audio (preferred)
      { video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
      { video: { facingMode: { ideal: 'user' } }, audio: true },
      { video: true, audio: true },
      // Audio only — no camera attached or camera denied
      { video: false, audio: true },
      // Video only — no mic attached or mic denied
      { video: true, audio: false },
    ];
    for (const c of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(c);
        if (c.audio === false) stream.__sfMediaWarning = 'Microphone unavailable. You joined with camera only.';
        if (c.video === false) stream.__sfMediaWarning = 'Camera unavailable. You joined with microphone only.';
        return stream;
      } catch { /* try next */ }
    }
    const stream = new MediaStream();
    stream.__sfMediaWarning = 'Camera and microphone unavailable. You can still receive the call.';
    return stream;
  }

  function localMediaWarning(stream) {
    return stream && stream.__sfMediaWarning ? stream.__sfMediaWarning : '';
  }

  /** Caller only: before createOffer — add local tracks, recvonly transceivers for missing kinds. */
  function attachCallerLocalTracks(pc, stream) {
    const tracks = stream ? stream.getTracks() : [];
    tracks.forEach(t => pc.addTrack(t, stream));
    if (!tracks.some(t => t.kind === 'audio')) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (!tracks.some(t => t.kind === 'video')) pc.addTransceiver('video', { direction: 'recvonly' });
  }

  /**
   * Callee only: after setRemoteDescription(offer). Transceivers already match the offer's m-lines.
   * Never addTransceiver here — extra m-lines break SDP vs the caller.
   */
  function attachCalleeLocalTracks(pc, stream) {
    const tracks = stream ? stream.getTracks() : [];
    tracks.forEach(t => {
      try { pc.addTrack(t, stream); } catch { /* ignore */ }
    });
  }

  function wirePeerConnectionRemoteVideo(pc, hintEl) {
    pc.ontrack = (e) => {
      const r = $('#videoRemote');
      if (!r) return;
      if (e.streams && e.streams[0] && e.streams[0].getTracks().length > 0) {
        r.srcObject = e.streams[0];
      } else if (e.track) {
        let ms = r.srcObject instanceof MediaStream ? r.srcObject : null;
        if (!ms) ms = new MediaStream();
        if (!ms.getTracks().some(t => t.id === e.track.id)) ms.addTrack(e.track);
        r.srcObject = ms;
      }
      void r.play().catch(() => {});
      if (hintEl) hintEl.textContent = '';
    };
  }

  function playVideoElement(el) {
    if (!el) return;
    void el.play().catch(() => {});
  }

  function endVideoCall(emitHangup) {
    stopIncomingCallRing();
    videoPendingOffer = null;
    videoCallDialing = false;
    if (emitHangup && videoPeerId && videoSignalChannelId) {
      relayVideo(videoPeerId, { channelId: videoSignalChannelId, type: 'hangup' });
    }
    if (videoPc) {
      try {
        videoPc.ontrack = null;
        videoPc.onicecandidate = null;
        videoPc.onconnectionstatechange = null;
        videoPc.close();
      } catch { /* ignore */ }
      videoPc = null;
    }
    if (videoLocalStream) {
      videoLocalStream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
      videoLocalStream = null;
    }
    videoIcePending = [];
    videoPeerId = null;
    videoSignalChannelId = null;
    videoMicMuted = false;
    const vl = $('#videoLocal');
    const vr = $('#videoRemote');
    if (vl) { try { vl.srcObject = null; } catch { /* ignore */ } }
    if (vr) { try { vr.srcObject = null; } catch { /* ignore */ } }
    $('#videoCallOverlay')?.classList.remove('open');
    $('#videoIncomingModal')?.classList.remove('open');
    $('#videoPickPeerModal')?.classList.remove('open');
    const hint = $('#videoCallHint');
    if (hint) hint.textContent = '';
    const muteBtn = $('#videoToggleMute');
    if (muteBtn) muteBtn.textContent = 'Mute mic';
    const rLab = $('#videoRemoteLabel');
    if (rLab) rLab.textContent = 'Participant';
  }

  function dismissIncomingOffer(declineRemote) {
    stopIncomingCallRing();
    const p = videoPendingOffer;
    videoPendingOffer = null;
    $('#videoIncomingModal')?.classList.remove('open');
    if (declineRemote && p) {
      const ch = p.channelId || p.dmChannelId;
      if (ch) relayVideo(p.fromUserId, { channelId: ch, type: 'decline' });
    }
  }

  async function acceptIncomingVideo() {
    stopIncomingCallRing();
    const po = videoPendingOffer;
    if (!po) return;
    const { fromUserId, sdp } = po;
    const sigCh = po.channelId || po.dmChannelId;
    videoPendingOffer = null;
    $('#videoIncomingModal')?.classList.remove('open');
    if (!sigCh) return;
    await refreshWebRtcIceConfig();
    videoPeerId = fromUserId;
    videoSignalChannelId = sigCh;
    if (activeChannelId !== sigCh) switchChannel(sigCh);
    let stream;
    try {
      stream = await acquireCallMedia();
    } catch {
      stream = new MediaStream();
      stream.__sfMediaWarning = 'Camera and microphone unavailable. You can still receive the call.';
    }
    if (videoPeerId !== fromUserId) return;
    videoLocalStream = stream;
    const localEl = $('#videoLocal');
    const remoteEl = $('#videoRemote');
    const overlay = $('#videoCallOverlay');
    const hint = $('#videoCallHint');
    if (localEl) {
      localEl.srcObject = stream;
      playVideoElement(localEl);
    }
    if (remoteEl) remoteEl.srcObject = null;
    if (hint) hint.textContent = localMediaWarning(stream);
    if (overlay) overlay.classList.add('open');
    videoMicMuted = false;
    const muteBtn = $('#videoToggleMute');
    if (muteBtn) muteBtn.textContent = 'Mute mic';
    updateVideoRemoteLabel();

    const pc = new RTCPeerConnection(rtcPeerConnectionConfig());
    videoPc = pc;
    wirePeerConnectionRemoteVideo(pc, hint);
    pc.onicecandidate = (e) => {
      if (e.candidate) relayVideo(fromUserId, { channelId: sigCh, type: 'ice', candidate: icePayload(e.candidate) });
      else relayVideo(fromUserId, { channelId: sigCh, type: 'ice', iceDone: true });
    };
    pc.onconnectionstatechange = () => {
      if (!videoPc || videoPc !== pc) return;
      const h = $('#videoCallHint');
      const st = pc.connectionState;
      if (st === 'connected') {
        if (h) h.textContent = '';
      } else if (st === 'disconnected') {
        if (h) h.textContent = 'Reconnecting…';
      } else if (st === 'failed') {
        if (h) h.textContent = 'Connection failed.';
        setTimeout(() => { if (videoPc === pc) endVideoCall(true); }, 2500);
      }
    };
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      await flushIceQueue(pc);
      attachCalleeLocalTracks(pc, stream);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      relayVideo(fromUserId, { channelId: sigCh, type: 'answer', sdp: answer.sdp });
    } catch (e) {
      console.error('acceptIncomingVideo SDP error:', e);
      const h = $('#videoCallHint');
      if (h) h.textContent = 'Call setup failed.';
      setTimeout(() => endVideoCall(true), 2500);
    }
  }

  function openVideoPeerPicker() {
    const list = $('#videoPickPeerList');
    if (!list) return;
    const others = users.filter(u => u.id !== currentUser.id);
    if (!others.length) {
      list.innerHTML = '<p style="margin:0;color:var(--text-muted);font-size:13px;text-align:center">No one else is in this workspace.</p>';
    } else {
      list.innerHTML = others.map(u => `
        <button type="button" class="video-pick-peer-btn" data-video-peer="${u.id.replace(/"/g, '')}">
          ${avatarEl(u, 'dm-avatar')}
          <span class="video-pick-peer-name">${escHtml(u.name)}</span>
          <span class="dm-status ${u.status === 'online' ? 'online' : 'offline'}"></span>
        </button>`).join('');
      list.querySelectorAll('[data-video-peer]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-video-peer');
          closeModal('videoPickPeerModal');
          void startVideoCallWithPeer(id);
        });
      });
    }
    openModal('videoPickPeerModal');
  }

  function openVideoCallEntry() {
    if (!currentUser) return;
    if (inServerMode() && (!socket || !socket.connected)) return;
    if (activeChannelId.startsWith('dm_')) {
      const peer = dmPeerUserId(activeChannelId);
      if (peer) void startVideoCallWithPeer(peer);
      return;
    }
    openVideoPeerPicker();
  }

  async function startVideoCallWithPeer(peerId) {
    if (!peerId || peerId === currentUser.id) return;
    if (inServerMode() && (!socket || !socket.connected)) return;
    if (videoPc || videoCallDialing) return;
    if (videoPendingOffer) {
      const incomingEl = $('#videoIncomingModal');
      if (!incomingEl || !incomingEl.classList.contains('open')) {
        videoPendingOffer = null;
        stopIncomingCallRing();
      } else {
        return;
      }
    }
    videoCallDialing = true;
    videoPeerId = peerId;
    videoSignalChannelId = activeChannelId;
    videoIcePending = [];
    await refreshWebRtcIceConfig();
    let stream;
    try {
      stream = await acquireCallMedia();
    } catch {
      stream = new MediaStream();
      stream.__sfMediaWarning = 'Camera and microphone unavailable. You can still receive the call.';
    }
    if (videoPeerId !== peerId) return;
    videoLocalStream = stream;
    const localEl = $('#videoLocal');
    const remoteEl = $('#videoRemote');
    const overlay = $('#videoCallOverlay');
    const hint = $('#videoCallHint');
    if (localEl) {
      localEl.srcObject = stream;
      playVideoElement(localEl);
    }
    if (remoteEl) remoteEl.srcObject = null;
    if (hint) hint.textContent = localMediaWarning(stream) || 'Calling…';
    if (overlay) overlay.classList.add('open');
    videoMicMuted = false;
    const muteBtn = $('#videoToggleMute');
    if (muteBtn) muteBtn.textContent = 'Mute mic';
    updateVideoRemoteLabel();

    const sigCh = videoSignalChannelId;
    const pc = new RTCPeerConnection(rtcPeerConnectionConfig());
    videoPc = pc;
    wirePeerConnectionRemoteVideo(pc, hint);
    pc.onicecandidate = (e) => {
      if (e.candidate) relayVideo(peerId, { channelId: sigCh, type: 'ice', candidate: icePayload(e.candidate) });
      else relayVideo(peerId, { channelId: sigCh, type: 'ice', iceDone: true });
    };
    pc.onconnectionstatechange = () => {
      if (!videoPc || videoPc !== pc) return;
      const h = $('#videoCallHint');
      const st = pc.connectionState;
      if (st === 'connected') {
        if (h) h.textContent = '';
      } else if (st === 'disconnected') {
        if (h) h.textContent = 'Reconnecting…';
      } else if (st === 'failed') {
        if (h) h.textContent = 'Connection failed.';
        setTimeout(() => { if (videoPc === pc) endVideoCall(true); }, 2500);
      }
    };
    attachCallerLocalTracks(pc, stream);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      relayVideo(peerId, { channelId: sigCh, type: 'offer', sdp: offer.sdp });
    } catch (e) {
      console.error('startVideoCallWithPeer SDP error:', e);
      endVideoCall(false);
    } finally {
      videoCallDialing = false;
    }
  }

  function toggleVideoMic() {
    if (!videoLocalStream) return;
    videoMicMuted = !videoMicMuted;
    videoLocalStream.getAudioTracks().forEach(t => { t.enabled = !videoMicMuted; });
    const b = $('#videoToggleMute');
    if (b) b.textContent = videoMicMuted ? 'Unmute mic' : 'Mute mic';
  }

  async function handleWebrtcPeer(payload) {
    const channelId = payload && (payload.channelId || payload.dmChannelId);
    const { fromUserId, type, sdp, candidate, iceDone } = payload || {};
    if (!currentUser || !fromUserId || fromUserId === currentUser.id || !channelId) return;

    if (type === 'hangup') {
      if (videoPeerId === fromUserId && videoSignalChannelId === channelId) endVideoCall(false);
      if (videoPendingOffer && videoPendingOffer.fromUserId === fromUserId) {
        const poCh = videoPendingOffer.channelId || videoPendingOffer.dmChannelId;
        if (poCh === channelId) dismissIncomingOffer(false);
      }
      return;
    }

    if (type === 'decline') {
      if (videoPc && videoPeerId === fromUserId && videoSignalChannelId === channelId) {
        // Show the message INSIDE the overlay before closing it
        const h = $('#videoCallHint');
        if (h) h.textContent = 'Call declined.';
        setTimeout(() => endVideoCall(false), 2500);
      }
      return;
    }

    if (type === 'ice') {
      const peerMatch = videoPeerId === fromUserId && videoSignalChannelId === channelId;
      const pendingMatch = !peerMatch && videoPendingOffer &&
        videoPendingOffer.fromUserId === fromUserId &&
        (videoPendingOffer.channelId || videoPendingOffer.dmChannelId) === channelId;
      if (!peerMatch && !pendingMatch) return;

      // Queue ICE even when videoPc is not yet created (e.g. callee is mid-accept,
      // waiting for camera permission). flushIceQueue applies them after setRemoteDescription.
      if (!videoPc) {
        if (iceDone === true) { videoIcePending.push({ __iceEnd: true }); return; }
        if (!candidate) return;
        try { videoIcePending.push(new RTCIceCandidate(candidate)); } catch { /* ignore */ }
        return;
      }
      if (iceDone === true) {
        try {
          if (!videoPc.remoteDescription) videoIcePending.push({ __iceEnd: true });
          else {
            try { await videoPc.addIceCandidate(); } catch { await videoPc.addIceCandidate(null); }
          }
        } catch { /* ignore */ }
        return;
      }
      if (!candidate) return;
      const c = new RTCIceCandidate(candidate);
      try {
        if (!videoPc.remoteDescription) videoIcePending.push(c);
        else await videoPc.addIceCandidate(c);
      } catch { /* ignore */ }
      return;
    }

    if (type === 'offer' && sdp) {
      if (videoPc) {
        // Duplicate or late offer after we already accepted (same peer/channel) — do not
        // auto-decline or the caller sees "declined" even though the callee picked up.
        if (videoPeerId === fromUserId && videoSignalChannelId === channelId) return;
        relayVideo(fromUserId, { channelId, type: 'decline' });
        return;
      }
      videoPendingOffer = { fromUserId, sdp, channelId };
      videoIcePending = []; // Clear queue for the new incoming offer
      const name = resolveUser(fromUserId).name;
      const t = $('#videoIncomingTitle');
      if (t) t.textContent = `${name} wants a video call`;
      $('#videoIncomingModal')?.classList.add('open');
      playIncomingCallRing();
      return;
    }

    if (type === 'answer' && sdp) {
      if (!videoPc || videoPeerId !== fromUserId || videoSignalChannelId !== channelId) {
        return;
      }
      try {
        await videoPc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        await flushIceQueue(videoPc);
        const h = $('#videoCallHint');
        if (h) h.textContent = 'Connecting…';
      } catch (e) {
        console.error('answer setRemoteDescription error:', e);
        const h = $('#videoCallHint');
        if (h) h.textContent = 'Call setup failed.';
        setTimeout(() => endVideoCall(false), 2500);
      }
    }
  }

  function connectSocket() {
    if (!inServerMode()) return;
    if (socket && socket.connected) endVideoCall(true);
    if (socket) socket.disconnect();
    socket = io(backUrl());

    socket.on('connect', () => { socket.emit('authenticate', authToken); });
    socket.on('authenticated', () => {
      socket.emit('join_channel', activeChannelId);
      renderMessages();
    });
    socket.on('auth_error', () => { logout(); showAuthError('Session expired.'); });

    socket.on('new_message', ({ channelId, message }) => {
      if (!messages[channelId]) messages[channelId] = [];
      if (messages[channelId].find(m => m.id === message.id)) return;
      messages[channelId].push(message);
      if (currentUser && message.userId && message.userId !== currentUser.id) {
        playNotificationSound();
        const preview = message.text || (message.file ? 'Sent a file' : '');
        notifyIncomingIfAway({
          channelId,
          fromName: message.userName || resolveUser(message.userId).name,
          body: preview,
          tag: message.id,
        });
      }
      if (channelId === activeChannelId) renderMessages();
    });
    socket.on('thread_reply', ({ channelId, parentMsgId, reply }) => {
      const msgs = messages[channelId]; if (!msgs) return;
      const p = msgs.find(m => m.id === parentMsgId); if (!p) return;
      if (!p.threadReplies) p.threadReplies = [];
      if (p.threadReplies.find(r => r.id === reply.id)) return;
      p.threadReplies.push(reply);
      if (currentUser && reply.userId && reply.userId !== currentUser.id) {
        playNotificationSound();
        notifyIncomingIfAway({
          channelId,
          fromName: reply.userName || resolveUser(reply.userId).name,
          body: 'Thread: ' + (reply.text || '').slice(0, 120),
          tag: reply.id,
        });
      }
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
      if (user.id === currentUser.id) {
        currentUser = { ...currentUser, ...user };
        refreshProfileModalAvatar();
      }
      renderAll();
    });
    socket.on('user_typing', ({ channelId, userName }) => {
      if (channelId === activeChannelId) showTyping(userName);
    });
    socket.on('webrtc_peer', (payload) => { void handleWebrtcPeer(payload); });
  }

  // ==============================
  //  RENDER (shared by both modes)
  // ==============================

  function renderAll() {
    renderWorkspaceRail();
    renderSidebarWorkspaceTitle();
    renderChannelList();
    renderDMList();
    renderMessages();
    renderRailAvatar();
    renderEmojis();
  }

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
        ${avatarEl(u, 'dm-avatar')}
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
        ${avatarEl(user, 'message-avatar')}
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
    const vBtn = $('#videoCallBtn');
    if (vBtn) {
      const canVideo = !!(currentUser && ch && (inServerMode() ? (socket && socket.connected) : true));
      vBtn.style.display = canVideo ? 'flex' : 'none';
    }
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
    let html = `<div class="message">${avatarEl(pu, 'message-avatar')}
      <div class="message-body"><div class="message-meta"><span class="message-author">${escHtml(pu.name)}</span><span class="message-time">${formatTime(pm.ts)}</span></div>
      <div class="message-text">${formatText(pm.text)}</div></div></div>
      <div class="date-divider"><span>${(pm.threadReplies||[]).length} ${(pm.threadReplies||[]).length===1?'reply':'replies'}</span></div>`;
    (pm.threadReplies || []).forEach(r => {
      const u = resolveUser(r.userId, r.userName);
      html += `<div class="message">${avatarEl(u, 'message-avatar')}
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
    const avatarDiv = avatarEl(u, 'member-avatar');
    const avatarWithDot = avatarDiv.replace('</div>', `<span class="status-dot" style="background:${dot}"></span></div>`);
    return `<div class="member-item">${avatarWithDot}
      <div class="member-info"><div class="member-name">${escHtml(u.name)}${u.id===currentUser.id?' (you)':''}</div><div class="member-role">${sub}</div></div></div>`;
  }

  function renderRailAvatar() {
    const r = $('#railAvatar');
    if (!r) return;
    if (!currentUser) {
      r.style.visibility = 'hidden';
      return;
    }
    r.style.visibility = 'visible';
    const src = resolveAvatarUrl(currentUser.avatarUrl);
    if (src) {
      r.style.background = '';
      r.innerHTML = `<img src="${escHtml(src)}" alt="${escHtml(currentUser.name)}" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit">`;
    } else {
      r.innerHTML = '';
      r.style.background = colorFor(currentUser.name);
      r.style.display = 'flex'; r.style.alignItems = 'center'; r.style.justifyContent = 'center';
      r.style.fontSize = '13px'; r.style.fontWeight = '700'; r.style.color = '#fff';
      r.textContent = initials(currentUser.name);
    }
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

  async function sendMessage(text, isThread = false) {
    if (!text.trim() && !pendingFile) return;
    if (!currentUser) return;

    let file = null;
    if (pendingFile && inServerMode()) {
      const uploadingPill = $('#filePreview');
      if (uploadingPill) uploadingPill.innerHTML = '<span class="file-pill">⏳ Uploading…</span>';
      file = await uploadFile(pendingFile);
      setPendingFile(null);
      $('#fileInput').value = '';
      if (!file && !text.trim()) return;
    }

    if (inServerMode() && socket) {
      if (isThread && activeThreadMsgId) {
        socket.emit('thread_reply', { channelId: activeChannelId, parentMsgId: activeThreadMsgId, text: text.trim() });
      } else {
        socket.emit('send_message', { channelId: activeChannelId, text: text.trim(), file });
      }
    } else {
      const filteredText = filterExplicit(text.trim());
      const msg = { id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), userId: currentUser.id, text: filteredText, ts: Date.now(), reactions: {}, threadReplies: [] };
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
    if (inServerMode() && socket) {
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
    if (inServerMode() && socket) {
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
    if (videoPendingOffer) {
      const poCh = videoPendingOffer.channelId || videoPendingOffer.dmChannelId;
      if (poCh !== chId) dismissIncomingOffer(true);
    }
    if (videoSignalChannelId && videoSignalChannelId !== chId) {
      endVideoCall(true);
    }
    if (inServerMode() && socket) { socket.emit('leave_channel', activeChannelId); }
    activeChannelId = chId;
    if (inServerMode() && socket) { socket.emit('join_channel', chId); }
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

  if (authInviteSignInLink) authInviteSignInLink.addEventListener('click', (e) => { e.preventDefault(); setAuthSignInOnly(); });
  authForm.addEventListener('submit', handleAuth);
  $('#logoutBtn').addEventListener('click', logout);

  $('#videoCallBtn')?.addEventListener('click', () => { openVideoCallEntry(); });
  $('#videoCallHangup')?.addEventListener('click', () => endVideoCall(true));
  $('#videoIncomingAccept')?.addEventListener('click', () => { void acceptIncomingVideo(); });
  $('#videoIncomingDecline')?.addEventListener('click', () => dismissIncomingOffer(true));
  $('#videoToggleMute')?.addEventListener('click', () => toggleVideoMic());

  // ---- Pending account request (no chat): submit credentials, poll, auto sign-in when approved ----
  (function initPendingRegistration() {
    const LS_ID = 'sf_pending_reg_id';
    const LS_TOK = 'sf_pending_reg_token';
    const LS_USER = 'sf_pending_reg_username';

    const screen = $('#pendingRegScreen');
    const formWrap = $('#pendingRegFormWrap');
    const waitWrap = $('#pendingRegWaitWrap');
    const form = $('#pendingRegForm');
    const errEl = $('#pendingRegError');
    const waitErr = $('#pendingRegWaitErr');
    const nameEl = $('#pendingRegName');
    const userEl = $('#pendingRegUsername');
    const passEl = $('#pendingRegPassword');

    let regId = localStorage.getItem(LS_ID) || '';
    let pendingToken = localStorage.getItem(LS_TOK) || '';
    let pollTimer = null;

    function showFormErr(msg) {
      errEl.textContent = msg;
      errEl.classList.add('visible');
    }
    function hideFormErr() { errEl.classList.remove('visible'); errEl.textContent = ''; }
    function showWaitErr(msg) {
      waitErr.textContent = msg;
      waitErr.classList.add('visible');
    }
    function hideWaitErr() { waitErr.classList.remove('visible'); waitErr.textContent = ''; }

    function showWaitingUI() {
      formWrap.style.display = 'none';
      waitWrap.style.display = 'block';
      hideWaitErr();
    }
    function showFormUI() {
      waitWrap.style.display = 'none';
      formWrap.style.display = 'block';
      hideFormErr();
    }

    function clearPendingLs() {
      regId = '';
      pendingToken = '';
      localStorage.removeItem(LS_ID);
      localStorage.removeItem(LS_TOK);
      localStorage.removeItem(LS_USER);
    }

    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function pollStatus() {
      if (!regId || !pendingToken || !backUrl()) return;
      try {
        const res = await fetch(backUrl() + '/api/register-pending/' + encodeURIComponent(regId) + '/status?pendingToken=' + encodeURIComponent(pendingToken));
        if (!res.ok) return;
        const d = await res.json();
        if (d.status === 'approved' && d.token && d.user) {
          stopPoll();
          clearPendingLs();
          authToken = d.token;
          currentUser = d.user;
          const aw = activeWorkspace();
          if (aw) { aw.token = d.token; saveWsState(); }
          screen.style.display = 'none';
          enterApp();
          return;
        }
        if (d.status === 'denied') {
          stopPoll();
          clearPendingLs();
          showFormUI();
          nameEl.value = ''; userEl.value = ''; passEl.value = '';
          showFormErr('Your request was not approved. You can submit again with a different username if you like.');
          return;
        }
        if (d.status === 'ready_sign_in') {
          stopPoll();
          const savedUser = localStorage.getItem(LS_USER) || '';
          clearPendingLs();
          screen.style.display = 'none';
          setAuthSignInOnly();
          authScreen.style.display = '';
          authUsername.value = savedUser;
          showAuthError('You were already approved. Sign in with the username and password you chose.');
        }
      } catch { /* ignore */ }
    }

    function startPoll() {
      stopPoll();
      pollTimer = setInterval(pollStatus, 3500);
      pollStatus();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideFormErr();
      if (!backUrl()) { showFormErr('Server is not configured.'); return; }

      const name = nameEl.value.trim();
      const username = userEl.value.trim().toLowerCase();
      const password = passEl.value;
      if (!name || !username || !password) { showFormErr('Please fill in all fields.'); return; }
      if (username.length < 2) { showFormErr('Username must be at least 2 characters.'); return; }
      if (password.length < 3) { showFormErr('Password must be at least 3 characters.'); return; }

      primeAudioOnUserGesture();

      try {
        const res = await fetch(backUrl() + '/api/register-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, username, password }),
        });
        const d = await res.json();
        if (!res.ok) { showFormErr(d.error || 'Something went wrong.'); return; }
        regId = d.id;
        pendingToken = d.pendingToken;
        localStorage.setItem(LS_ID, regId);
        localStorage.setItem(LS_TOK, pendingToken);
        localStorage.setItem(LS_USER, username);
        showWaitingUI();
        startPoll();
      } catch { showFormErr('Could not reach the server.'); }
    });

    function openSignIn() {
      primeAudioOnUserGesture();
      stopPoll();
      setAuthSignInOnly();
      screen.style.display = 'none';
      authScreen.style.display = '';
    }

    $('#pendingRegToSignIn').addEventListener('click', (e) => { e.preventDefault(); openSignIn(); });
    $('#pendingRegWaitToSignIn').addEventListener('click', (e) => { e.preventDefault(); stopPoll(); clearPendingLs(); showFormUI(); openSignIn(); });
    $('#pendingRegCancelWait').addEventListener('click', (e) => {
      e.preventDefault();
      stopPoll();
      clearPendingLs();
      showFormUI();
      nameEl.value = ''; userEl.value = ''; passEl.value = '';
    });

    $('#goToPendingRegLink').addEventListener('click', (e) => {
      e.preventDefault();
      authScreen.style.display = 'none';
      screen.style.display = '';
      showFormUI();
    });

    if (regId && pendingToken && backUrl() && !urlParams.get('invite')) {
      screen.style.display = '';
      authScreen.style.display = 'none';
      showWaitingUI();
      startPoll();
    }
  }());

  channelListEl.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li && li.dataset.channel) switchChannel(li.dataset.channel); });

  dmListEl.addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li || !li.dataset.user) return;
    const userId = li.dataset.user;
    if (inServerMode() && socket) {
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
      if (inServerMode() && socket) socket.emit('typing', { channelId: activeChannelId });
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

  $('#confirmAddWorkspaceBtn').addEventListener('click', confirmAddWorkspace);
  $('#addChannelBtn').addEventListener('click', (e) => { e.stopPropagation(); openModal('addChannelModal'); });
  $('#createChannelBtn').addEventListener('click', () => {
    const name = $('#newChannelName').value.trim();
    const desc = $('#newChannelDesc').value.trim();
    if (!name) return;
    if (inServerMode() && socket) { socket.emit('create_channel', { name, topic: desc }); }
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
  $$('.modal-overlay').forEach(o => {
    o.addEventListener('click', (e) => {
      if (e.target !== o) return;
      if (o.id === 'videoIncomingModal') dismissIncomingOffer(false);
      else o.classList.remove('open');
    });
  });

  function refreshProfileModalAvatar() {
    if (!currentUser) return;
    const a = $('#profileAvatarLg');
    if (!a) return;
    const src = resolveAvatarUrl(currentUser.avatarUrl);
    if (src) {
      a.style.background = '';
      a.innerHTML = `<img src="${escHtml(src)}" alt="${escHtml(currentUser.name)}">`;
    } else {
      a.innerHTML = '';
      a.style.background = colorFor(currentUser.name);
      a.textContent = initials(currentUser.name);
    }
    const useInitialsBtn = $('#useInitialsBtn');
    if (useInitialsBtn) useInitialsBtn.style.display = src ? '' : 'none';
  }

  $('#railAvatar').addEventListener('click', () => {
    refreshProfileModalAvatar();
    $('#profileName').value = currentUser.name;
    $('#profileStatus').value = currentUser.statusMsg || '';
    // Hide editor on open
    const ed = $('#avatarEditor');
    if (ed) { ed.style.display = 'none'; }
    const editBtn = $('#editAvatarBtn');
    if (editBtn) editBtn.textContent = 'Edit photo';
    applyTheme(localStorage.getItem('sf_theme') || 'dark');
    openModal('profileModal');
  });

  document.getElementById('themePicker').addEventListener('click', (e) => {
    const swatch = e.target.closest('.theme-swatch');
    if (swatch) applyTheme(swatch.dataset.theme);
  });

  $('#saveProfileBtn').addEventListener('click', async () => {
    const name = ($('#profileName').value || '').trim();
    const statusMsg = ($('#profileStatus').value || '').trim();
    if (inServerMode() && authToken) {
      const effectiveName = name || currentUser.name;
      if (name && name !== currentUser.name) {
        try {
          await fetch(backUrl() + '/api/profile/name', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
            body: JSON.stringify({ name: effectiveName }),
          });
        } catch { /* socket fallback below */ }
      }
      if (socket) socket.emit('update_profile', { name: effectiveName, statusMsg });
    } else {
      if (name) currentUser.name = name;
      currentUser.statusMsg = statusMsg;
      const u2 = lsGetUsers(), u = u2.find(x => x.id === currentUser.id);
      if (u) { u.name = currentUser.name; u.statusMsg = statusMsg; lsSaveUsers(u2); users = u2; }
      broadcast('user_joined', { userId: currentUser.id }); renderAll();
    }
    closeModal('profileModal');
  });

  const useInitialsBtn = $('#useInitialsBtn');
  if (useInitialsBtn) {
    useInitialsBtn.addEventListener('click', async () => {
      if (inServerMode() && authToken) {
        try {
          await fetch(backUrl() + '/api/profile/avatar', {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + authToken },
          });
          // Server will broadcast user_updated; update locally too
          currentUser.avatarUrl = null;
          const u2 = users.find(x => x.id === currentUser.id);
          if (u2) u2.avatarUrl = null;
          refreshProfileModalAvatar();
          renderRailAvatar();
          renderAll();
        } catch (e) { console.error('Failed to reset avatar:', e); }
      } else {
        currentUser.avatarUrl = null;
        const all = lsGetUsers();
        const u = all.find(x => x.id === currentUser.id);
        if (u) { u.avatarUrl = null; lsSaveUsers(all); users = all; }
        refreshProfileModalAvatar();
        renderRailAvatar();
        renderAll();
      }
    });
  }

  // ── Avatar editor ──
  // ═══════════════════════════════════════════════════════════
  //  AVATAR BUILDER v2 — Polished Memoji-quality SVG avatars
  // ═══════════════════════════════════════════════════════════
  (function initAvatarEditor() {

    // ── 12 radial gradient backgrounds ──
    const AB_BG = [
      {name:'Violet',  c1:'#a78bfa',c2:'#5b21b6'},
      {name:'Azure',   c1:'#60a5fa',c2:'#1e40af'},
      {name:'Mint',    c1:'#34d399',c2:'#064e3b'},
      {name:'Coral',   c1:'#f87171',c2:'#991b1b'},
      {name:'Rose',    c1:'#f472b6',c2:'#831843'},
      {name:'Teal',    c1:'#2dd4bf',c2:'#134e4a'},
      {name:'Gold',    c1:'#fcd34d',c2:'#92400e'},
      {name:'Slate',   c1:'#94a3b8',c2:'#1e293b'},
      {name:'Peach',   c1:'#fb923c',c2:'#7c2d12'},
      {name:'Lilac',   c1:'#c084fc',c2:'#581c87'},
      {name:'Night',   c1:'#475569',c2:'#020617'},
      {name:'Sunrise', c1:'#fde68a',c2:'#dc2626'},
    ];

    // ── 8 skin tones with highlight / shadow for 3D gradient ──
    const AB_SKIN = [
      {name:'Very Fair',  base:'#FDE8D8',shd:'#ECC5A8',hi:'#FFF3ED'},
      {name:'Fair',       base:'#F5C5A3',shd:'#D49878',hi:'#FDDBB4'},
      {name:'Medium',     base:'#E0A882',shd:'#BA8060',hi:'#EEC298'},
      {name:'Olive',      base:'#C68642',shd:'#9A6020',hi:'#D9A060'},
      {name:'Tan',        base:'#B5724A',shd:'#8D5230',hi:'#C88A60'},
      {name:'Brown',      base:'#8D5524',shd:'#6A3C10',hi:'#A06E38'},
      {name:'Dark Brown', base:'#5C3210',shd:'#3E1F06',hi:'#734022'},
      {name:'Deep',       base:'#3B1F0A',shd:'#1A0A02',hi:'#4D2A10'},
    ];

    // ── 6 face shapes ──
    const AB_FACE_SHAPES = [
      {name:'Round',   face:`<ellipse cx="100" cy="115" rx="58" ry="62"/>`,  earY:112,earRy:14},
      {name:'Oval',    face:`<ellipse cx="100" cy="118" rx="50" ry="70"/>`,  earY:116,earRy:14},
      {name:'Square',  face:`<path d="M50,76 Q50,62 100,62 Q150,62 150,76 L150,158 Q150,172 100,172 Q50,172 50,158Z"/>`, earY:112,earRy:14},
      {name:'Heart',   face:`<path d="M100,168 Q58,148 50,116 Q44,88 66,76 Q82,66 94,80 Q97,84 100,90 Q103,84 106,80 Q118,66 134,76 Q156,88 150,116 Q142,148 100,168Z"/>`, earY:104,earRy:12},
      {name:'Diamond', face:`<path d="M100,62 L152,110 L100,168 L48,110Z"/>`, earY:110,earRy:11},
      {name:'Oblong',  face:`<ellipse cx="100" cy="122" rx="45" ry="76"/>`,  earY:118,earRy:14},
    ];

    // ── 10 hair colors ──
    const AB_HAIR_COLORS = [
      {name:'Black',      hex:'#1C0800',dark:'#0A0400'},
      {name:'Dark Brown', hex:'#3B2314',dark:'#201008'},
      {name:'Brown',      hex:'#7B4A2B',dark:'#4E2C14'},
      {name:'Blonde',     hex:'#D4AA70',dark:'#A07828'},
      {name:'Red',        hex:'#CC4422',dark:'#8A2010'},
      {name:'Auburn',     hex:'#7B2C1E',dark:'#4E1510'},
      {name:'Gray',       hex:'#909090',dark:'#606060'},
      {name:'White',      hex:'#E8E8E8',dark:'#AAAAAA'},
      {name:'Blue',       hex:'#2563EB',dark:'#1E3A8A'},
      {name:'Pink',       hex:'#EC4899',dark:'#9D174D'},
    ];

    // ── 12 hair styles ($h=color hex, $d=dark hex) ──
    const AB_HAIR_STYLES = [
      {name:'Bald', back:'', front:''},
      {name:'Buzz Cut',
       back:`<ellipse cx="100" cy="74" rx="56" ry="32" fill="$h" opacity="0.85"/>`,
       front:`<path d="M44,88 C46,67 55,59 100,59 C145,59 154,67 156,88 C150,71 140,65 100,65 C60,65 50,71 44,88Z" fill="$h"/>
<rect x="44" y="76" rx="5" width="10" height="20" fill="$h"/>
<rect x="146" y="76" rx="5" width="10" height="20" fill="$h"/>`},
      {name:'Short Crop',
       back:`<ellipse cx="100" cy="70" rx="58" ry="37" fill="$h"/>`,
       front:`<path d="M42,88 C42,63 54,54 100,54 C146,54 158,63 158,88 C152,69 140,62 100,62 C60,62 48,69 42,88Z" fill="$h"/>
<rect x="42" y="76" rx="5" width="11" height="26" fill="$h"/>
<rect x="147" y="76" rx="5" width="11" height="26" fill="$h"/>`},
      {name:'Textured Top',
       back:`<ellipse cx="100" cy="70" rx="58" ry="37" fill="$h"/>`,
       front:`<path d="M42,88 C42,63 54,54 100,54 C146,54 158,63 158,88 C152,69 140,62 100,62 C60,62 48,69 42,88Z" fill="$h"/>
<rect x="42" y="76" rx="5" width="11" height="26" fill="$h"/>
<rect x="147" y="76" rx="5" width="11" height="26" fill="$h"/>
<path d="M76,60 Q80,43 88,58 Q93,40 100,56 Q107,40 112,58 Q120,43 124,60" stroke="$h" stroke-width="8" fill="none" stroke-linecap="round"/>`},
      {name:'Side Sweep',
       back:`<ellipse cx="100" cy="70" rx="58" ry="37" fill="$h"/>`,
       front:`<path d="M42,88 C48,65 63,57 100,57 C137,57 154,67 158,88 C150,69 138,63 100,63 C62,63 50,71 42,88Z" fill="$h"/>
<rect x="42" y="76" rx="5" width="11" height="26" fill="$h"/>
<rect x="147" y="76" rx="5" width="11" height="26" fill="$h"/>
<path d="M56,63 C72,52 118,55 148,63" stroke="$h" stroke-width="9" fill="none" stroke-linecap="round"/>`},
      {name:'Undercut',
       back:`<ellipse cx="100" cy="70" rx="58" ry="37" fill="$d" opacity="0.9"/>`,
       front:`<rect x="42" y="66" rx="4" width="12" height="42" fill="$d"/>
<rect x="146" y="66" rx="4" width="12" height="42" fill="$d"/>
<ellipse cx="100" cy="62" rx="44" ry="24" fill="$h"/>
<path d="M56,68 C58,48 142,48 144,68 L144,72 C140,52 60,52 56,72Z" fill="$h"/>`},
      {name:'Afro',
       back:`<ellipse cx="100" cy="64" rx="72" ry="56" fill="$h"/>
<circle cx="54" cy="72" r="26" fill="$h"/><circle cx="146" cy="72" r="26" fill="$h"/>
<circle cx="76" cy="37" r="21" fill="$h"/><circle cx="124" cy="37" r="21" fill="$h"/>
<circle cx="100" cy="29" r="24" fill="$h"/>`,
       front:`<rect x="42" y="72" rx="5" width="12" height="28" fill="$h"/>
<rect x="146" y="72" rx="5" width="12" height="28" fill="$h"/>`},
      {name:'Curly',
       back:`<ellipse cx="100" cy="67" rx="60" ry="43" fill="$h"/>
<circle cx="47" cy="78" r="18" fill="$h"/><circle cx="153" cy="78" r="18" fill="$h"/>
<circle cx="63" cy="50" r="15" fill="$h"/><circle cx="137" cy="50" r="15" fill="$h"/>
<circle cx="100" cy="40" r="17" fill="$h"/>`,
       front:`<rect x="42" y="76" rx="5" width="11" height="24" fill="$h"/>
<rect x="147" y="76" rx="5" width="11" height="24" fill="$h"/>
<circle cx="57" cy="84" r="10" fill="$h"/><circle cx="143" cy="84" r="10" fill="$h"/>`},
      {name:'Long Straight',
       back:`<path d="M42,82 C42,62 54,52 100,52 C146,52 158,62 158,82 L160,180 Q128,188 100,188 Q72,188 40,180Z" fill="$h"/>`,
       front:`<path d="M42,82 C42,62 54,52 100,52 C146,52 158,62 158,82 C152,64 140,58 100,58 C60,58 48,64 42,82Z" fill="$h"/>
<rect x="42" y="74" rx="5" width="11" height="24" fill="$h"/>
<rect x="147" y="74" rx="5" width="11" height="24" fill="$h"/>`},
      {name:'Long Wavy',
       back:`<path d="M42,82 C42,60 54,52 100,52 C146,52 158,60 158,82 L164,154 Q156,176 148,184 Q145,170 153,154 L148,90 C145,72 138,64 100,64 C62,64 55,72 52,90 L47,154 Q55,170 52,184 Q44,176 36,154Z" fill="$h"/>`,
       front:`<path d="M42,82 C42,60 54,52 100,52 C146,52 158,60 158,82 C150,62 140,58 100,58 C60,58 50,64 42,82Z" fill="$h"/>
<rect x="42" y="74" rx="5" width="11" height="24" fill="$h"/>
<rect x="147" y="74" rx="5" width="11" height="24" fill="$h"/>`},
      {name:'Bun',
       back:`<ellipse cx="100" cy="70" rx="58" ry="40" fill="$h"/>
<circle cx="100" cy="36" r="21" fill="$h"/>
<ellipse cx="100" cy="52" rx="15" ry="7" fill="$d" opacity="0.7"/>`,
       front:`<path d="M42,84 C42,64 54,56 100,56 C146,56 158,64 158,84 C150,67 140,62 100,62 C60,62 50,68 42,84Z" fill="$h"/>
<rect x="42" y="74" rx="5" width="11" height="24" fill="$h"/>
<rect x="147" y="74" rx="5" width="11" height="24" fill="$h"/>`},
      {name:'Braids',
       back:`<path d="M42,82 C42,62 54,52 100,52 C146,52 158,62 158,82 L160,174 Q128,184 100,184 Q72,184 40,174Z" fill="$h"/>`,
       front:`<path d="M42,82 C42,62 54,52 100,52 C146,52 158,62 158,82 C152,64 140,58 100,58 C60,58 48,66 42,82Z" fill="$h"/>
<rect x="42" y="74" rx="5" width="11" height="24" fill="$h"/>
<rect x="147" y="74" rx="5" width="11" height="24" fill="$h"/>
<line x1="56" y1="112" x2="52" y2="174" stroke="$d" stroke-width="8" stroke-linecap="round"/>
<line x1="144" y1="112" x2="148" y2="174" stroke="$d" stroke-width="8" stroke-linecap="round"/>
<path d="M56,120 L61,126 L56,132 L61,138 L56,144 L61,150 L56,156 L61,162 L56,168" stroke="$d" stroke-width="4" fill="none" stroke-linecap="round"/>
<path d="M144,120 L139,126 L144,132 L139,138 L144,144 L139,150 L144,156 L139,162 L144,168" stroke="$d" stroke-width="4" fill="none" stroke-linecap="round"/>`},
      {name:'Swept Fringe',
       back:`<ellipse cx="103" cy="66" rx="61" ry="46" fill="$h"/>`,
       front:`<path d="M44,93 C43,64 58,52 100,52 C144,52 157,64 157,88 C151,67 139,59 106,57 C70,55 51,67 45,87Z" fill="$h"/>
<path d="M45,87 C41,87 39,97 39,106 C39,112 44,115 48,111 C52,106 51,97 49,89Z" fill="$h"/>
<path d="M155,87 C159,87 161,97 161,106 C161,112 156,115 152,111 C148,106 149,97 151,89Z" fill="$h"/>
<path d="M115,66 C106,58 88,60 72,70 C60,78 58,87 65,92 C74,96 94,91 112,87 C126,82 132,72 115,66Z" fill="$h"/>
<path d="M112,68 C100,65 81,69 68,78" stroke="$d" stroke-width="1.3" fill="none" stroke-linecap="round" opacity="0.45"/>
<path d="M116,73 C104,70 86,74 73,83" stroke="$d" stroke-width="1.3" fill="none" stroke-linecap="round" opacity="0.45"/>
<path d="M112,78 C101,75 84,79 72,87" stroke="$d" stroke-width="1.2" fill="none" stroke-linecap="round" opacity="0.35"/>
<path d="M109,82 C97,79 81,83 70,89" stroke="$d" stroke-width="1.1" fill="none" stroke-linecap="round" opacity="0.25"/>
<path d="M118,70 C108,67 92,71 80,79" stroke="rgba(255,255,255,0.15)" stroke-width="1.8" fill="none" stroke-linecap="round"/>
<path d="M116,63 C104,57 86,57 72,65" stroke="rgba(255,255,255,0.22)" stroke-width="4" fill="none" stroke-linecap="round"/>`},
    ];

    // ── 8 eye colors ──
    const AB_EYE_COLORS = [
      {name:'Brown',  iris:'#6B3A2A',pupil:'#2A1008'},
      {name:'Hazel',  iris:'#9B7A40',pupil:'#3A2808'},
      {name:'Green',  iris:'#3D7A50',pupil:'#1A3A20'},
      {name:'Blue',   iris:'#3D7EC9',pupil:'#1A3060'},
      {name:'Gray',   iris:'#7F909A',pupil:'#384048'},
      {name:'Amber',  iris:'#C87820',pupil:'#604000'},
      {name:'Violet', iris:'#7B5EA7',pupil:'#3A2060'},
      {name:'Black',  iris:'#2A1010',pupil:'#080404'},
    ];

    // 8 eye shape names (drawn by genEyes)
    const AB_EYE_SHAPE_NAMES = ['Almond','Round','Hooded','Upturned','Downturned','Monolid','Wide','Narrow'];

    // ── 6 eyebrow shapes ($b = brow color) ──
    const AB_BROW_SHAPES = [
      {name:'Arched',
       svg:`<path d="M68,88 Q80,80 92,84" stroke="$b" stroke-width="3.5" fill="none" stroke-linecap="round"/>
<path d="M108,84 Q120,80 132,88" stroke="$b" stroke-width="3.5" fill="none" stroke-linecap="round"/>`},
      {name:'Straight',
       svg:`<line x1="68" y1="85" x2="92" y2="85" stroke="$b" stroke-width="3.5" stroke-linecap="round"/>
<line x1="108" y1="85" x2="132" y2="85" stroke="$b" stroke-width="3.5" stroke-linecap="round"/>`},
      {name:'Thick',
       svg:`<path d="M67,88 Q80,79 93,84" stroke="$b" stroke-width="5.5" fill="none" stroke-linecap="round"/>
<path d="M107,84 Q120,79 133,88" stroke="$b" stroke-width="5.5" fill="none" stroke-linecap="round"/>`},
      {name:'Thin',
       svg:`<path d="M69,86 Q80,82 92,84" stroke="$b" stroke-width="1.8" fill="none" stroke-linecap="round"/>
<path d="M108,84 Q120,82 131,86" stroke="$b" stroke-width="1.8" fill="none" stroke-linecap="round"/>`},
      {name:'Bushy',
       svg:`<path d="M65,89 Q80,78 94,83" stroke="$b" stroke-width="6.5" fill="none" stroke-linecap="round"/>
<path d="M106,83 Q120,78 135,89" stroke="$b" stroke-width="6.5" fill="none" stroke-linecap="round"/>
<path d="M66,86 Q80,80 92,83" stroke="$b" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.4"/>`},
      {name:'None', svg:''},
    ];

    // ── 5 nose styles ──
    const AB_NOSES = [
      {name:'Button',
       svg:`<ellipse cx="96" cy="120" rx="2.5" ry="2" fill="#00000020"/>
<ellipse cx="104" cy="120" rx="2.5" ry="2" fill="#00000020"/>
<path d="M96,120 Q100,125 104,120" stroke="#00000030" stroke-width="1.5" fill="none" stroke-linecap="round"/>`},
      {name:'Wide',
       svg:`<ellipse cx="92" cy="120" rx="3.5" ry="2.5" fill="#00000020"/>
<ellipse cx="108" cy="120" rx="3.5" ry="2.5" fill="#00000020"/>
<path d="M92,120 Q100,126 108,120" stroke="#00000030" stroke-width="1.5" fill="none" stroke-linecap="round"/>`},
      {name:'Narrow',
       svg:`<ellipse cx="97.5" cy="120" rx="2" ry="1.5" fill="#00000020"/>
<ellipse cx="102.5" cy="120" rx="2" ry="1.5" fill="#00000020"/>
<path d="M97.5,120 Q100,124 102.5,120" stroke="#00000030" stroke-width="1.5" fill="none" stroke-linecap="round"/>`},
      {name:'Upturned',
       svg:`<ellipse cx="94" cy="118" rx="3" ry="2.5" fill="#00000020"/>
<ellipse cx="106" cy="118" rx="3" ry="2.5" fill="#00000020"/>
<path d="M94,120 Q100,116 106,120" stroke="#00000030" stroke-width="1.5" fill="none" stroke-linecap="round"/>`},
      {name:'Hooked',
       svg:`<path d="M98,114 Q104,119 100,127 Q102,122 108,123" stroke="#00000030" stroke-width="1.8" fill="none" stroke-linecap="round"/>`},
    ];

    // ── 8 mouth expressions ($l = lip color) ──
    const AB_MOUTHS = [
      {name:'Big Smile',
       svg:`<path d="M81,140 Q100,160 119,140 L117,140 Q100,156 83,140Z" fill="$l"/>
<rect x="83" y="140" width="34" height="10" rx="1" fill="white" opacity="0.88"/>
<path d="M81,140 Q100,160 119,140" stroke="#00000030" stroke-width="1" fill="none"/>`},
      {name:'Closed Smile',
       svg:`<path d="M84,141 Q100,155 116,141" stroke="#00000040" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<path d="M84,141 Q100,149 116,141 L116,144 Q100,153 84,144Z" fill="$l"/>`},
      {name:'Smirk',
       svg:`<path d="M86,142 Q98,151 114,144" stroke="#00000040" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<path d="M86,142 Q98,148 114,144 L114,147 Q98,152 86,145Z" fill="$l"/>`},
      {name:'Neutral',
       svg:`<line x1="86" y1="143" x2="114" y2="143" stroke="#00000040" stroke-width="2" stroke-linecap="round"/>
<path d="M86,141 L114,141 L114,145 L86,145Z" fill="$l"/>`},
      {name:'Surprised',
       svg:`<ellipse cx="100" cy="146" rx="9" ry="11" fill="$l"/>
<ellipse cx="100" cy="147" rx="7" ry="8.5" fill="#1a0a00" opacity="0.85"/>`},
      {name:'Tongue Out',
       svg:`<path d="M84,140 Q100,156 116,140 L114,140 Q100,153 86,140Z" fill="$l"/>
<rect x="86" y="140" width="28" height="7" fill="white" opacity="0.88"/>
<ellipse cx="100" cy="153" rx="8" ry="7" fill="#F46A7A"/>
<path d="M94,154 Q100,159 106,154" stroke="#E04060" stroke-width="1" fill="none" stroke-linecap="round"/>`},
      {name:'Laughing',
       svg:`<path d="M79,138 Q100,163 121,138 L119,138 Q100,160 81,138Z" fill="$l"/>
<rect x="81" y="138" width="38" height="13" rx="1" fill="white" opacity="0.88"/>
<path d="M79,138 Q100,163 121,138" stroke="#00000030" stroke-width="1" fill="none"/>`},
      {name:'Sad',
       svg:`<path d="M84,148 Q100,138 116,148" stroke="#00000040" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<path d="M84,148 Q100,141 116,148 L116,145 Q100,137 84,145Z" fill="$l"/>`},
    ];

    // ── 6 lip colors ──
    const AB_LIP_COLORS = [
      {name:'Natural',hex:'#C8826A'},
      {name:'Pink',   hex:'#E87AA0'},
      {name:'Red',    hex:'#C0142A'},
      {name:'Berry',  hex:'#8B1A6E'},
      {name:'Nude',   hex:'#D4AA90'},
      {name:'Coral',  hex:'#E86050'},
    ];

    // ── 4 cheek options ──
    const AB_CHEEKS = [
      {name:'None', svg:''},
      {name:'Freckles',
       svg:`<circle cx="71" cy="114" r="1.5" fill="#8B6050" opacity="0.55"/>
<circle cx="77" cy="111" r="1.1" fill="#8B6050" opacity="0.5"/>
<circle cx="75" cy="117" r="1.3" fill="#8B6050" opacity="0.52"/>
<circle cx="129" cy="114" r="1.5" fill="#8B6050" opacity="0.55"/>
<circle cx="123" cy="111" r="1.1" fill="#8B6050" opacity="0.5"/>
<circle cx="125" cy="117" r="1.3" fill="#8B6050" opacity="0.52"/>`},
      {name:'Rosy',
       svg:`<circle cx="69" cy="118" r="17" fill="#FF6B8A" opacity="0.16"/>
<circle cx="131" cy="118" r="17" fill="#FF6B8A" opacity="0.16"/>`},
      {name:'Blush',
       svg:`<ellipse cx="67" cy="118" rx="15" ry="9" fill="#E87090" opacity="0.2"/>
<ellipse cx="133" cy="118" rx="15" ry="9" fill="#E87090" opacity="0.2"/>`},
    ];

    // ── 3 ear sizes ──
    const AB_EAR_SIZES = [
      {name:'Small',  rx:7,  ry:10},
      {name:'Medium', rx:9,  ry:13},
      {name:'Large',  rx:12, ry:17},
    ];

    // ── 6 glasses styles ──
    const AB_GLASSES = [
      {name:'None', svg:''},
      {name:'Round',
       svg:`<circle cx="80" cy="100" r="12" stroke="#4A4A4A" stroke-width="2.5" fill="rgba(180,220,255,0.12)"/>
<circle cx="120" cy="100" r="12" stroke="#4A4A4A" stroke-width="2.5" fill="rgba(180,220,255,0.12)"/>
<line x1="92" y1="100" x2="108" y2="100" stroke="#4A4A4A" stroke-width="2"/>
<line x1="68" y1="101" x2="58" y2="104" stroke="#4A4A4A" stroke-width="2"/>
<line x1="132" y1="101" x2="142" y2="104" stroke="#4A4A4A" stroke-width="2"/>`},
      {name:'Rect.',
       svg:`<rect x="67" y="92" width="26" height="17" rx="3" stroke="#4A4A4A" stroke-width="2.5" fill="rgba(180,220,255,0.12)"/>
<rect x="107" y="92" width="26" height="17" rx="3" stroke="#4A4A4A" stroke-width="2.5" fill="rgba(180,220,255,0.12)"/>
<line x1="93" y1="100" x2="107" y2="100" stroke="#4A4A4A" stroke-width="2"/>
<line x1="67" y1="100" x2="57" y2="103" stroke="#4A4A4A" stroke-width="2"/>
<line x1="133" y1="100" x2="143" y2="103" stroke="#4A4A4A" stroke-width="2"/>`},
      {name:'Cat-Eye',
       svg:`<path d="M67,97 L76,91 L91,94 L91,104 L67,106Z" stroke="#4A4A4A" stroke-width="2" fill="rgba(180,220,255,0.12)"/>
<path d="M109,94 L124,91 L133,97 L133,106 L109,104Z" stroke="#4A4A4A" stroke-width="2" fill="rgba(180,220,255,0.12)"/>
<line x1="91" y1="100" x2="109" y2="100" stroke="#4A4A4A" stroke-width="2"/>
<line x1="67" y1="101" x2="57" y2="103" stroke="#4A4A4A" stroke-width="2"/>
<line x1="133" y1="101" x2="143" y2="103" stroke="#4A4A4A" stroke-width="2"/>`},
      {name:'Aviator',
       svg:`<path d="M67,94 Q80,88 93,94 L93,107 Q80,113 67,107Z" stroke="#B8860B" stroke-width="2.5" fill="rgba(200,220,255,0.16)"/>
<path d="M107,94 Q120,88 133,94 L133,107 Q120,113 107,107Z" stroke="#B8860B" stroke-width="2.5" fill="rgba(200,220,255,0.16)"/>
<line x1="93" y1="100" x2="107" y2="100" stroke="#B8860B" stroke-width="2"/>
<line x1="67" y1="100" x2="57" y2="103" stroke="#B8860B" stroke-width="2"/>
<line x1="133" y1="100" x2="143" y2="103" stroke="#B8860B" stroke-width="2"/>`},
      {name:'Thick',
       svg:`<rect x="65" y="90" width="30" height="20" rx="4" stroke="#1A1A1A" stroke-width="5" fill="rgba(180,220,255,0.1)"/>
<rect x="105" y="90" width="30" height="20" rx="4" stroke="#1A1A1A" stroke-width="5" fill="rgba(180,220,255,0.1)"/>
<line x1="95" y1="100" x2="105" y2="100" stroke="#1A1A1A" stroke-width="4"/>
<line x1="65" y1="100" x2="55" y2="103" stroke="#1A1A1A" stroke-width="4"/>
<line x1="135" y1="100" x2="145" y2="103" stroke="#1A1A1A" stroke-width="4"/>`},
    ];

    // ── 4 earring styles ──
    const AB_EARRINGS = [
      {name:'None', svg:''},
      {name:'Studs',
       svg:`<circle cx="40" cy="115" r="3.5" fill="#FFD700"/>
<circle cx="40" cy="115" r="2" fill="#FFA500" opacity="0.6"/>
<circle cx="160" cy="115" r="3.5" fill="#FFD700"/>
<circle cx="160" cy="115" r="2" fill="#FFA500" opacity="0.6"/>`},
      {name:'Hoops',
       svg:`<circle cx="40" cy="120" r="7" stroke="#FFD700" stroke-width="2.5" fill="none"/>
<circle cx="160" cy="120" r="7" stroke="#FFD700" stroke-width="2.5" fill="none"/>`},
      {name:'Drops',
       svg:`<line x1="40" y1="114" x2="40" y2="124" stroke="#FFD700" stroke-width="2.5"/>
<ellipse cx="40" cy="127" rx="3.5" ry="4.5" fill="#FFD700"/>
<line x1="160" y1="114" x2="160" y2="124" stroke="#FFD700" stroke-width="2.5"/>
<ellipse cx="160" cy="127" rx="3.5" ry="4.5" fill="#FFD700"/>`},
    ];

    // ── 5 facial hair styles ($h, $d) ──
    const AB_FACIAL_HAIR = [
      {name:'None', svg:''},
      {name:'Stubble',
       svg:`<path d="M83,136 Q100,146 117,136" stroke="$h" stroke-width="1.5" stroke-dasharray="2,2.5" fill="none" opacity="0.65"/>
<path d="M78,144 Q100,155 122,144" stroke="$h" stroke-width="1.5" stroke-dasharray="2,3" fill="none" opacity="0.45"/>`},
      {name:'Mustache',
       svg:`<path d="M86,135 Q93,140 100,138 Q107,140 114,135 Q107,142 100,140 Q93,142 86,135Z" fill="$h"/>`},
      {name:'Short Beard',
       svg:`<path d="M80,136 Q100,162 120,136 Q116,152 100,158 Q84,152 80,136Z" fill="$h" opacity="0.88"/>
<path d="M86,134 Q93,139 100,137 Q107,139 114,134 Q107,141 100,139 Q93,141 86,134Z" fill="$h"/>`},
      {name:'Full Beard',
       svg:`<path d="M73,128 Q100,170 127,128 Q122,160 100,168 Q78,160 73,128Z" fill="$h" opacity="0.88"/>
<path d="M86,128 Q93,134 100,132 Q107,134 114,128 Q107,136 100,134 Q93,136 86,128Z" fill="$h"/>`},
    ];

    // ── 4 hats/headwear ($h, $d) ──
    const AB_HATS = [
      {name:'None', svg:''},
      {name:'Cap',
       svg:`<ellipse cx="100" cy="66" rx="60" ry="28" fill="$h"/>
<path d="M40,66 Q40,46 100,46 Q160,46 160,66" fill="$h"/>
<path d="M40,68 Q70,74 100,74 Q130,74 160,68" fill="$d" opacity="0.4"/>
<path d="M155,70 Q178,76 175,82 Q166,77 155,74Z" fill="$h"/>`},
      {name:'Beanie',
       svg:`<path d="M40,78 Q40,45 100,45 Q160,45 160,78 L158,84 Q128,80 100,80 Q72,80 42,84Z" fill="$h"/>
<path d="M42,84 Q70,88 100,88 Q130,88 158,84 L156,91 Q126,95 100,95 Q74,95 44,91Z" fill="$d" opacity="0.55"/>
<circle cx="100" cy="39" r="9" fill="$h"/>`},
      {name:'Crown',
       svg:`<path d="M58,80 L58,55 L72,70 L100,48 L128,70 L142,55 L142,80Z" fill="#FFD700" stroke="#DAA520" stroke-width="1.5" stroke-linejoin="round"/>
<ellipse cx="100" cy="80" rx="42" ry="7" fill="#E5B800"/>
<circle cx="100" cy="50" r="5" fill="#FF4444"/>
<circle cx="72" cy="69" r="4" fill="#4488FF"/>
<circle cx="128" cy="69" r="4" fill="#44CC44"/>
<circle cx="58" cy="80" r="3.5" fill="#FF4444"/>
<circle cx="142" cy="80" r="3.5" fill="#FF4444"/>`},
    ];

    // ── Builder state ──
    const st = {
      bg:0, skin:1, faceShape:0, earSize:1, cheek:0,
      hair:2, hairC:0, facialHair:0,
      eyeShape:0, eyeC:3, lashes:false, brow:0,
      nose:0, mouth:0, lipC:0,
      glasses:0, earrings:0, hat:0,
    };

    let _uid = 0;

    // ── Eye pair generator ──
    function genEyes(shapeIdx, ic, pc, lashes) {
      function drawEye(cx, cy) {
        const lashSvg = lashes
          ? `<path d="M${cx-8},${cy-3} Q${cx-7},${cy-9} ${cx-5},${cy-9} M${cx-2},${cy-7} Q${cx-1},${cy-12} ${cx+1},${cy-11} M${cx+4},${cy-6} Q${cx+5},${cy-11} ${cx+7},${cy-9}" stroke="#1C0800" stroke-width="1.2" fill="none" stroke-linecap="round"/>`
          : '';
        switch (shapeIdx) {
          case 0: return `<path d="M${cx-11},${cy} Q${cx},${cy-9} ${cx+11},${cy} Q${cx},${cy+8} ${cx-11},${cy}Z" fill="white"/>
<circle cx="${cx}" cy="${cy}" r="6" fill="${ic}"/><circle cx="${cx}" cy="${cy}" r="3.2" fill="${pc}"/>
<circle cx="${cx+2}" cy="${cy-2}" r="1.8" fill="rgba(255,255,255,0.75)"/>
${lashSvg}
<path d="M${cx-11},${cy} Q${cx},${cy-9} ${cx+11},${cy}" stroke="#1C0800" stroke-width="1.2" fill="none" stroke-linecap="round"/>`;
          case 1: return `<ellipse cx="${cx}" cy="${cy}" rx="9" ry="9" fill="white"/>
<circle cx="${cx}" cy="${cy}" r="6.2" fill="${ic}"/><circle cx="${cx}" cy="${cy}" r="3.3" fill="${pc}"/>
<circle cx="${cx+2}" cy="${cy-2}" r="1.8" fill="rgba(255,255,255,0.75)"/>
${lashSvg}
<path d="M${cx-9},${cy} a9,9 0 0,1 18,0" stroke="#1C0800" stroke-width="1.2" fill="none"/>`;
          case 2: return `<path d="M${cx-9},${cy+1} Q${cx},${cy-7} ${cx+9},${cy+1} Q${cx},${cy+9} ${cx-9},${cy+1}Z" fill="white"/>
<circle cx="${cx}" cy="${cy+2}" r="5" fill="${ic}"/><circle cx="${cx}" cy="${cy+2}" r="2.7" fill="${pc}"/>
<circle cx="${cx+1.5}" cy="${cy}" r="1.4" fill="rgba(255,255,255,0.75)"/>
<path d="M${cx-9},${cy+1} Q${cx},${cy-3} ${cx+9},${cy+1}" fill="${ic}" opacity="0.28"/>
${lashSvg}
<path d="M${cx-9},${cy+1} Q${cx},${cy-7} ${cx+9},${cy+1}" stroke="#1C0800" stroke-width="1.2" fill="none"/>`;
          case 3: return `<path d="M${cx-11},${cy+1} Q${cx},${cy-9} ${cx+11},${cy-2} Q${cx+3},${cy+8} ${cx-11},${cy+1}Z" fill="white"/>
<circle cx="${cx}" cy="${cy}" r="5.8" fill="${ic}"/><circle cx="${cx}" cy="${cy}" r="3.1" fill="${pc}"/>
<circle cx="${cx+2}" cy="${cy-2}" r="1.6" fill="rgba(255,255,255,0.75)"/>
${lashSvg}
<path d="M${cx-11},${cy+1} Q${cx},${cy-9} ${cx+11},${cy-2}" stroke="#1C0800" stroke-width="1.2" fill="none"/>`;
          case 4: return `<path d="M${cx-11},${cy-2} Q${cx},${cy-9} ${cx+11},${cy+1} Q${cx+3},${cy+8} ${cx-11},${cy-2}Z" fill="white"/>
<circle cx="${cx}" cy="${cy}" r="5.8" fill="${ic}"/><circle cx="${cx}" cy="${cy}" r="3.1" fill="${pc}"/>
<circle cx="${cx+2}" cy="${cy-2}" r="1.6" fill="rgba(255,255,255,0.75)"/>
${lashSvg}
<path d="M${cx-11},${cy-2} Q${cx},${cy-9} ${cx+11},${cy+1}" stroke="#1C0800" stroke-width="1.2" fill="none"/>`;
          case 5: return `<path d="M${cx-9},${cy+2} Q${cx},${cy-5} ${cx+9},${cy+2} Q${cx},${cy+9} ${cx-9},${cy+2}Z" fill="white"/>
<circle cx="${cx}" cy="${cy+2}" r="5" fill="${ic}"/><circle cx="${cx}" cy="${cy+2}" r="2.7" fill="${pc}"/>
<circle cx="${cx+1.5}" cy="${cy}" r="1.3" fill="rgba(255,255,255,0.75)"/>
${lashSvg}
<path d="M${cx-9},${cy+2} Q${cx},${cy-5} ${cx+9},${cy+2}" stroke="#1C0800" stroke-width="1.2" fill="none"/>`;
          case 6: return `<ellipse cx="${cx}" cy="${cy}" rx="11" ry="10" fill="white"/>
<circle cx="${cx}" cy="${cy}" r="7.2" fill="${ic}"/><circle cx="${cx}" cy="${cy}" r="3.8" fill="${pc}"/>
<circle cx="${cx+2.5}" cy="${cy-2.5}" r="2.2" fill="rgba(255,255,255,0.75)"/>
${lashSvg}
<path d="M${cx-11},${cy} a11,10 0 0,1 22,0" stroke="#1C0800" stroke-width="1.2" fill="none"/>`;
          case 7: return `<path d="M${cx-9},${cy+1} Q${cx},${cy-4} ${cx+9},${cy+1} Q${cx},${cy+6} ${cx-9},${cy+1}Z" fill="white"/>
<circle cx="${cx}" cy="${cy+1}" r="4" fill="${ic}"/><circle cx="${cx}" cy="${cy+1}" r="2.2" fill="${pc}"/>
<circle cx="${cx+1.2}" cy="${cy-0.5}" r="1.1" fill="rgba(255,255,255,0.75)"/>
${lashSvg}
<path d="M${cx-9},${cy+1} Q${cx},${cy-4} ${cx+9},${cy+1}" stroke="#1C0800" stroke-width="1.2" fill="none"/>`;
          default: return '';
        }
      }
      return drawEye(80, 100) + drawEye(120, 100);
    }

    // ── Build the SVG ──
    function buildSvg(s) {
      const bgD   = AB_BG[s.bg];
      const skinD = AB_SKIN[s.skin];
      const fs    = AB_FACE_SHAPES[s.faceShape];
      const hs    = AB_HAIR_STYLES[s.hair];
      const hcD   = AB_HAIR_COLORS[s.hairC];
      const ecD   = AB_EYE_COLORS[s.eyeC];
      const earD  = AB_EAR_SIZES[s.earSize];

      const uid  = 'a' + (++_uid);
      const hc   = hcD.hex, hd = hcD.dark;
      const ic   = ecD.iris, pc = ecD.pupil;
      const bc   = hc; // brows match hair

      const hairBack      = hs.back.replace(/\$h/g, hc).replace(/\$d/g, hd);
      const hairFront     = hs.front.replace(/\$h/g, hc).replace(/\$d/g, hd);
      const browSvg       = AB_BROW_SHAPES[s.brow].svg.replace(/\$b/g, bc);
      const noseSvg       = AB_NOSES[s.nose].svg;
      const mouthSvg      = AB_MOUTHS[s.mouth].svg.replace(/\$l/g, AB_LIP_COLORS[s.lipC].hex);
      const cheekSvg      = AB_CHEEKS[s.cheek].svg;
      const glassesSvg    = AB_GLASSES[s.glasses].svg;
      const earringsSvg   = AB_EARRINGS[s.earrings].svg;
      const facialHairSvg = AB_FACIAL_HAIR[s.facialHair].svg.replace(/\$h/g, hc).replace(/\$d/g, hd);
      const hatSvg        = AB_HATS[s.hat].svg.replace(/\$h/g, hc).replace(/\$d/g, hd);
      const eyeSvg        = genEyes(s.eyeShape, ic, pc, s.lashes);

      const earY = fs.earY, erx = earD.rx, ery = earD.ry;
      const erxi = Math.round(erx * 0.55), eryi = Math.round(ery * 0.6);

      return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
<defs>
  <radialGradient id="bg${uid}" cx="40%" cy="35%" r="75%">
    <stop offset="0%" stop-color="${bgD.c1}"/><stop offset="100%" stop-color="${bgD.c2}"/>
  </radialGradient>
  <radialGradient id="fc${uid}" cx="38%" cy="28%" r="72%">
    <stop offset="0%" stop-color="${skinD.hi}"/>
    <stop offset="55%" stop-color="${skinD.base}"/>
    <stop offset="100%" stop-color="${skinD.shd}"/>
  </radialGradient>
  <radialGradient id="bd${uid}" cx="50%" cy="20%" r="70%">
    <stop offset="0%" stop-color="${skinD.base}"/><stop offset="100%" stop-color="${skinD.shd}"/>
  </radialGradient>
</defs>
<circle cx="100" cy="100" r="100" fill="url(#bg${uid})"/>
<ellipse cx="100" cy="204" rx="55" ry="38" fill="url(#bd${uid})"/>
<rect x="88" y="170" width="24" height="28" rx="6" fill="${skinD.base}"/>
<ellipse cx="42" cy="${earY}" rx="${erx}" ry="${ery}" fill="${skinD.base}"/>
<ellipse cx="42" cy="${earY}" rx="${erxi}" ry="${eryi}" fill="${skinD.shd}" opacity="0.35"/>
<ellipse cx="158" cy="${earY}" rx="${erx}" ry="${ery}" fill="${skinD.base}"/>
<ellipse cx="158" cy="${earY}" rx="${erxi}" ry="${eryi}" fill="${skinD.shd}" opacity="0.35"/>
${hairBack}
<g fill="url(#fc${uid})">${fs.face}</g>
${facialHairSvg}
${browSvg}
${eyeSvg}
${noseSvg}
${mouthSvg}
${cheekSvg}
${hairFront}
${glassesSvg}
${earringsSvg}
${hatSvg}
</svg>`;
    }

    function refreshPreview() {
      const p = $('#avbPreview');
      if (p) p.innerHTML = buildSvg(st);
      const hr = $('#avbHairColorRow');
      if (hr) hr.style.display = st.hair === 0 ? 'none' : '';
    }

    function activateChip(el, idx) {
      el.querySelectorAll('.avb-chip').forEach((c, i) => c.classList.toggle('active', i === idx));
    }
    function activateSwatch(el, idx) {
      el.querySelectorAll('.avb-swatch').forEach((s, i) => s.classList.toggle('active', i === idx));
    }

    function makeChips(id, items, key) {
      const el = $('#' + id); if (!el) return;
      el.innerHTML = items.map((it, i) =>
        `<button type="button" class="avb-chip${st[key]===i?' active':''}" data-idx="${i}">${it.name||it}</button>`
      ).join('');
      el.addEventListener('click', e => {
        const b = e.target.closest('.avb-chip'); if (!b) return;
        st[key] = +b.dataset.idx; activateChip(el, st[key]); refreshPreview();
      });
    }

    function makeSwatches(id, items, key, bgFn) {
      const el = $('#' + id); if (!el) return;
      el.innerHTML = items.map((it, i) =>
        `<button type="button" class="avb-swatch${st[key]===i?' active':''}" data-idx="${i}" style="background:${bgFn(it)}" title="${it.name||it}"></button>`
      ).join('');
      el.addEventListener('click', e => {
        const b = e.target.closest('.avb-swatch'); if (!b) return;
        st[key] = +b.dataset.idx; activateSwatch(el, st[key]); refreshPreview();
      });
    }

    function refreshAllSelectors() {
      const c = (id, k) => { const e=$('#'+id); if(e) activateChip(e, st[k]); };
      const s = (id, k) => { const e=$('#'+id); if(e) activateSwatch(e, st[k]); };
      s('avbBgSwatches','bg'); s('avbSkinSwatches','skin');
      c('avbFaceChips','faceShape'); c('avbEarChips','earSize'); c('avbCheekChips','cheek');
      c('avbHairStyleChips','hair'); s('avbHairColorSwatches','hairC'); c('avbFacialHairChips','facialHair');
      c('avbEyeShapeChips','eyeShape'); s('avbEyeColorSwatches','eyeC');
      c('avbBrowChips','brow'); c('avbNoseChips','nose');
      c('avbMouthChips','mouth'); s('avbLipSwatches','lipC');
      c('avbGlassesChips','glasses'); c('avbEarringsChips','earrings'); c('avbHatChips','hat');
      const le = $('#avbLashChips');
      if (le) le.querySelectorAll('.avb-chip').forEach(c2 =>
        c2.classList.toggle('active', (c2.dataset.v==='1') === st.lashes));
      const hr = $('#avbHairColorRow');
      if (hr) hr.style.display = st.hair === 0 ? 'none' : '';
    }

    function initBuilder() {
      makeSwatches('avbBgSwatches',         AB_BG,          'bg',       c => `linear-gradient(135deg,${c.c1},${c.c2})`);
      makeSwatches('avbSkinSwatches',       AB_SKIN,        'skin',     c => c.base);
      makeChips   ('avbFaceChips',          AB_FACE_SHAPES, 'faceShape');
      makeChips   ('avbEarChips',           AB_EAR_SIZES,   'earSize');
      makeChips   ('avbCheekChips',         AB_CHEEKS,      'cheek');
      makeChips   ('avbHairStyleChips',     AB_HAIR_STYLES, 'hair');
      makeSwatches('avbHairColorSwatches',  AB_HAIR_COLORS, 'hairC',    c => c.hex);
      makeChips   ('avbFacialHairChips',    AB_FACIAL_HAIR, 'facialHair');
      makeChips   ('avbEyeShapeChips',      AB_EYE_SHAPE_NAMES.map(n=>({name:n})), 'eyeShape');
      makeSwatches('avbEyeColorSwatches',   AB_EYE_COLORS,  'eyeC',     c => c.iris);
      makeChips   ('avbBrowChips',          AB_BROW_SHAPES, 'brow');
      makeChips   ('avbNoseChips',          AB_NOSES,       'nose');
      makeChips   ('avbMouthChips',         AB_MOUTHS,      'mouth');
      makeSwatches('avbLipSwatches',        AB_LIP_COLORS,  'lipC',     c => c.hex);
      makeChips   ('avbGlassesChips',       AB_GLASSES,     'glasses');
      makeChips   ('avbEarringsChips',      AB_EARRINGS,    'earrings');
      makeChips   ('avbHatChips',           AB_HATS,        'hat');

      // Lash toggle
      const lashEl = $('#avbLashChips');
      if (lashEl) {
        lashEl.innerHTML = `<button type="button" class="avb-chip${!st.lashes?' active':''}" data-v="0">Off</button>
<button type="button" class="avb-chip${st.lashes?' active':''}" data-v="1">On</button>`;
        lashEl.addEventListener('click', e => {
          const b = e.target.closest('.avb-chip'); if (!b) return;
          st.lashes = b.dataset.v === '1';
          lashEl.querySelectorAll('.avb-chip').forEach(c => c.classList.toggle('active', (c.dataset.v==='1')===st.lashes));
          refreshPreview();
        });
      }

      // Category tab switching
      $$('.avb-cat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          $$('.avb-cat-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const cat = btn.dataset.cat;
          $$('.avb-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === cat));
        });
      });

      // Randomize
      const randBtn = $('#avbRandomizeBtn');
      if (randBtn) {
        randBtn.addEventListener('click', () => {
          const r = n => Math.floor(Math.random() * n);
          st.bg         = r(AB_BG.length);
          st.skin       = r(AB_SKIN.length);
          st.faceShape  = r(AB_FACE_SHAPES.length);
          st.earSize    = r(AB_EAR_SIZES.length);
          st.cheek      = r(AB_CHEEKS.length);
          st.hair       = r(AB_HAIR_STYLES.length);
          st.hairC      = r(AB_HAIR_COLORS.length);
          st.facialHair = r(AB_FACIAL_HAIR.length);
          st.eyeShape   = r(AB_EYE_SHAPE_NAMES.length);
          st.eyeC       = r(AB_EYE_COLORS.length);
          st.lashes     = Math.random() > 0.5;
          st.brow       = r(AB_BROW_SHAPES.length);
          st.nose       = r(AB_NOSES.length);
          st.mouth      = r(AB_MOUTHS.length);
          st.lipC       = r(AB_LIP_COLORS.length);
          st.glasses    = r(AB_GLASSES.length);
          st.earrings   = r(AB_EARRINGS.length);
          st.hat        = Math.random() > 0.72 ? r(AB_HATS.length) : 0;
          refreshAllSelectors();
          refreshPreview();
        });
      }

      refreshPreview();
    }

    let builderInitialized = false;
    function ensureBuilder() {
      if (!builderInitialized) { builderInitialized = true; initBuilder(); }
      else refreshPreview();
    }

    async function svgToDataUrl(svgString) {
      return new Promise((resolve, reject) => {
        const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = 256; c.height = 256;
          c.getContext('2d').drawImage(img, 0, 0, 256, 256);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed')); };
        img.src = url;
      });
    }

    async function applyAvatarUrl(url) {
      currentUser.avatarUrl = url;
      const u2 = users.find(x => x.id === currentUser.id);
      if (u2) u2.avatarUrl = url;
      if (!inServerMode()) {
        const all = lsGetUsers();
        const u = all.find(x => x.id === currentUser.id);
        if (u) { u.avatarUrl = url; lsSaveUsers(all); }
      }
      refreshProfileModalAvatar();
      renderRailAvatar();
      renderAll();
    }

    // Tab switching
    function switchTab(tab) {
      const isUpload = tab === 'upload';
      $('#avtPaneUpload').style.display = isUpload ? '' : 'none';
      $('#avtPaneBuild').style.display = isUpload ? 'none' : '';
      $$('.avatar-tab').forEach(b => b.classList.toggle('active', b.id === (isUpload ? 'avtTabUpload' : 'avtTabBuild')));
      if (!isUpload) { ensureBuilder(); }
    }

    const editBtn = $('#editAvatarBtn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const ed = $('#avatarEditor');
        if (!ed) return;
        const open = ed.style.display !== 'none';
        ed.style.display = open ? 'none' : '';
        editBtn.textContent = open ? 'Edit photo' : 'Cancel';
        if (!open) switchTab('upload');
      });
    }

    // Tab click handlers
    $$('.avatar-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.avt));
    });

    // ── Upload Photo ──
    let uploadedDataUrl = null;

    const dropEl = $('#avtUploadDrop');
    const fileInput = $('#avatarFileInput');

    if (dropEl) {
      dropEl.addEventListener('click', () => fileInput && fileInput.click());
    }

    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { alert('File is too large. Max 2 MB.'); fileInput.value = ''; return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
          uploadedDataUrl = ev.target.result;
          if (dropEl) {
            dropEl.classList.add('has-preview');
            dropEl.innerHTML = `<img src="${escHtml(uploadedDataUrl)}" alt="preview">`;
          }
          const sb = $('#saveUploadBtn');
          if (sb) sb.style.display = '';
        };
        reader.readAsDataURL(file);
      });
    }

    const saveUploadBtn = $('#saveUploadBtn');
    if (saveUploadBtn) {
      saveUploadBtn.addEventListener('click', async () => {
        if (!uploadedDataUrl) return;
        saveUploadBtn.disabled = true;
        saveUploadBtn.textContent = 'Saving…';
        try {
          if (inServerMode() && authToken) {
            // Upload the actual file bytes for better storage
            const fileInp = fileInput;
            const file = fileInp && fileInp.files && fileInp.files[0];
            if (file) {
              const form = new FormData();
              form.append('file', file);
              const res = await fetch(backUrl() + '/api/profile/avatar', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + authToken },
                body: form,
              });
              const d = await res.json();
              if (!res.ok) { alert('Upload failed: ' + (d.error || 'unknown error')); return; }
              // server will broadcast user_updated; also update locally immediately
              await applyAvatarUrl(resolveAvatarUrl(d.avatarUrl) || uploadedDataUrl);
            } else {
              // Fallback: send data URL
              const res = await fetch(backUrl() + '/api/profile/avatar/dataurl', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
                body: JSON.stringify({ dataUrl: uploadedDataUrl }),
              });
              const d = await res.json();
              if (!res.ok) { alert('Upload failed: ' + (d.error || 'unknown error')); return; }
              await applyAvatarUrl(resolveAvatarUrl(d.avatarUrl) || uploadedDataUrl);
            }
          } else {
            await applyAvatarUrl(uploadedDataUrl);
          }
          // Reset editor
          const ed = $('#avatarEditor');
          if (ed) ed.style.display = 'none';
          if (editBtn) editBtn.textContent = 'Edit photo';
        } catch (err) {
          alert('Save failed: ' + err.message);
        } finally {
          saveUploadBtn.disabled = false;
          saveUploadBtn.textContent = 'Save Photo';
        }
      });
    }

    // ── Save built avatar ──
    const saveBuiltBtn = $('#saveBuiltBtn');
    if (saveBuiltBtn) {
      saveBuiltBtn.addEventListener('click', async () => {
        saveBuiltBtn.disabled = true;
        saveBuiltBtn.textContent = 'Saving…';
        try {
          const svgStr = buildSvg(st);
          let dataUrl;
          try { dataUrl = await svgToDataUrl(svgStr); }
          catch { dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr))); }

          if (inServerMode() && authToken) {
            const res = await fetch(backUrl() + '/api/profile/avatar/dataurl', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
              body: JSON.stringify({ dataUrl }),
            });
            const d = await res.json();
            if (!res.ok) { alert('Save failed: ' + (d.error || 'unknown error')); return; }
            await applyAvatarUrl(resolveAvatarUrl(d.avatarUrl) || dataUrl);
          } else {
            await applyAvatarUrl(dataUrl);
          }
          const ed = $('#avatarEditor');
          if (ed) ed.style.display = 'none';
          if (editBtn) editBtn.textContent = 'Edit photo';
        } catch (err) {
          alert('Save failed: ' + err.message);
        } finally {
          saveBuiltBtn.disabled = false;
          saveBuiltBtn.textContent = 'Save Avatar';
        }
      });
    }
  }());

  $('#mobileMenuBtn').addEventListener('click', openMobileSidebar);
  sidebarOverlay.addEventListener('click', closeMobileSidebar);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      threadPanel.classList.remove('open');
      memberPanel.classList.remove('open');
      closeEmojiPicker();
      if ($('#videoIncomingModal')?.classList.contains('open')) dismissIncomingOffer(false);
      $$('.modal-overlay.open').forEach(m => m.classList.remove('open'));
      searchResults.classList.remove('open');
      closeMobileSidebar();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (!inServerMode() && currentUser) {
      const u2 = lsGetUsers(), u = u2.find(x => x.id === currentUser.id);
      if (u) { u.status = 'offline'; lsSaveUsers(u2); }
      broadcast('user_offline', { userId: currentUser.id });
    }
  });

  // ==============================
  //  INIT
  // ==============================

  bindNotificationAudioUnlock();
  renderWorkspaceRail();

  if (inServerMode() && authToken) {
    enterApp();
  } else if (!inServerMode()) {
    const uid = lsLoad('sf_session', null);
    if (uid) { const u = lsGetUsers().find(x => x.id === uid); if (u) { currentUser = u; enterApp(); } }
  }

})();
