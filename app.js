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
    const parts = channelId.slice(3).split('_');
    if (parts.length !== 2) return null;
    return parts[0] === currentUser.id ? parts[1] : parts[0];
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
          <span class="dm-avatar" style="background:${colorFor(u.name)}">${initials(u.name)}</span>
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
      if (user.id === currentUser.id) currentUser = user;
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
    if (!r) return;
    if (!currentUser) {
      r.style.visibility = 'hidden';
      return;
    }
    r.style.visibility = 'visible';
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
  const direct = EXPLICIT_WORDS.map(escape).join('|');
  const spaced = EXPLICIT_WORDS
    .filter((w) => w.length >= 4)
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
    if (inServerMode() && socket) {
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
