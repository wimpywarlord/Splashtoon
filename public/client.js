'use strict';

// ---------------------------------------------------------------------------
// Battle Painter client: render the authoritative grid, predict own movement,
// interpolate others, send 8-direction input, draw animated sprites + powerups.
// ---------------------------------------------------------------------------

const {
  MAX_SPEED,
  ACCEL,
  BOOST_MULT,
  SLOW_MULT,
  TINY_SPEED_MULT,
  DAMPING_PER_SEC,
  BRUSH_R,
  MOVE_EPS,
  DRIFT_EPS,
  FACE_EPS,
  RECONCILE_SOFT_DIST,
  RECONCILE_HARD_DIST,
  RECONCILE_SOFT_GAIN,
  PET,
  PET_DRAW_H,
  PET_IDLE_DRAW_H,
  PET_DRIFT_DRAW_H,
  PET_ANCHOR_Y,
  TRAIL_W,
  SNAPSHOT_STAMP_PX,
  POWERUP_SHEET,
  POWERUP_FADE_MS,
  SNAP_FLASH_MS,
} = window.Splashtoon.config;

// Animated brush-spirit spritesheet: 8 cols x 9 rows, 192x208 cells. Rows are
// game-specific brush/powerup interaction states. The pink paint is recolored
// to each player's color at load.
const petSheet = new Image();
let petReady = false;
petSheet.onload = () => { petReady = true; };
petSheet.src = '/assets/brush-spirit.png';
const tintedSheets = {};       // slot -> recolored <canvas>
let snapshotStamps = [];       // slot -> small rounded cell stamp for grid snapshots

// Runtime uses the active row for board pickups and the disabled gray row for
// pickup fade-out; the old burst row was removed from the atlas.
const powerupSheet = new Image();
let powerupReady = false;
powerupSheet.onload = () => { powerupReady = true; };
powerupSheet.src = '/assets/powerups.png?v=powerups-14x2-r1';

const playerArrow = new Image();
let playerArrowReady = false;
playerArrow.onload = () => { playerArrowReady = true; };
playerArrow.src = '/assets/player-arrow.svg?v=round-start-r5';
const PLAYER_ARROW_SIZE = 46;
const PLAYER_ARROW_X_OFFSET = 5;
const PLAYER_ARROW_GAP = 11;
const PLAYER_ARROW_BOB_PX = 4;
const PLAYER_ARROW_BOB_MS = 640;
const PLAYER_ARROW_TIP_Y = 0.90625;
const PLAYER_ARROW_BRUSH_TOP_INSET = 0.14;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const ARENA_BG = '#14171f';   // dark arena surface; neon paint and brushes pop against it
// Chrome matches the arena exactly: on viewports taller/wider than 16:9 the
// CONTAIN slack around the board reads as one surface with the board. NOTE: the
// board frame stroke has been removed, so with chrome == arena the playable bounds
// are now unmarked (paint just stops at the edge).
const CHROME_BG = ARENA_BG;
ctx.imageSmoothingEnabled = true;   // smooth sprite + paint scaling (was pixelated)

const els = {
  timer: document.getElementById('timer'),
  timerVal: document.querySelector('#timer .timer-val'),
  topbar: document.getElementById('topbar'),
  rankLeft: document.getElementById('rank-left'),
  rankRight: document.getElementById('rank-right'),
  spectate: document.getElementById('spectate'),
  results: document.getElementById('results'),
  resultsCard: document.getElementById('round-end-card'),
  resultsConfetti: document.getElementById('results-confetti'),
  resultKicker: document.getElementById('result-kicker'),
  resultTitle: document.getElementById('result-title'),
  resultList: document.getElementById('result-list'),
  nextCountdown: document.getElementById('next-countdown'),
  startForm: document.getElementById('start-form'),
  nameInput: document.getElementById('name-input'),
  stats: document.getElementById('stats'),
  resultsMenuBtn: document.getElementById('results-menu-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  navSettings: document.getElementById('nav-settings'),
  settingsMenu: document.getElementById('settings-menu'),
  legendBtn: document.getElementById('legend-btn'),
  legendMenu: document.getElementById('legend-menu'),
  simToast: document.getElementById('sim-toast'),
  countdown: document.getElementById('countdown'),
  volSlider: document.getElementById('vol-slider'),
  musicSlider: document.getElementById('music-slider'),
  sfxSlider: document.getElementById('sfx-slider'),
  brushSlider: document.getElementById('brush-slider'),
  playersDec: document.getElementById('players-dec'),
  playersInc: document.getElementById('players-inc'),
  playersVal: document.getElementById('players-val'),
  ping: document.getElementById('ping'),
  pingVal: document.querySelector('#ping .ping-val'),
  connOverlay: document.getElementById('conn-overlay'),
  connTitle: document.getElementById('conn-title'),
  connMsg: document.getElementById('conn-msg'),
  connBtn: document.getElementById('conn-btn'),
  chat: document.getElementById('chat'),
  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatToggle: document.getElementById('chat-toggle'),
};

const GameAudio = window.SplashtoonAudio;
const Store = window.SplashtoonStore;

const RESULT_CONFETTI_DENSITY = 220;
const RESULT_CONFETTI_SPEED = 1.0;
const RESULT_CONFETTI_GRAVITY = 330;
const RESULT_CONFETTI_COLORS = ['#ffe05d', '#16d7c7', '#ff5b51', '#a8ff78', '#f8f6ef', '#4f7dff'];
let resultConfettiCtx = els.resultsConfetti ? els.resultsConfetti.getContext('2d') : null;
let resultConfettiParticles = [];
let resultConfettiRaf = 0;
let resultConfettiLast = 0;

// ---- World / game state -----------------------------------------------------
const G = {
  w: 128, h: 72, cell: 10,        // 16:9 arena (matches the server); the local
  worldW: 1280, worldH: 720,      // attract-mode sim uses this before any connect
};
let palette = [];
let paletteRGB = [];

let myId = null;
let currentRoomId = '';
let currentRoundId = 0;
let mySlot = -1;
let spectating = true;
let phase = 'active';
let roundMs = 120000;   // round length ("starting time"); server sends the real value, this is the pre-connection fallback
let timeLeftMs = roundMs;   // pre-connection fallback: show the full round, not a stale 1:30, until the server's first state
let scores = [];

let myName = '';
let slotNames = {};       // slot -> display name, rebuilt from each player list
let inMenu = true;        // on the start screen (not connected to a match)
let lastTickSecond = -1;  // for one-shot countdown ticks
let lastRankAt = 0;       // throttle for the ranking-bar re-shuffle
let statsIntroPlayed = false;
let statsAnimationFrame = 0;
const rankChips = new Map(); // slot -> ranking-bar chip element (persistent for FLIP)

// Other players: id -> render/target state.
const remote = new Map();

// Own predicted brush.
const me = { x: 0, y: 0, vx: 0, vy: 0, has: false, face: 1, dirAngle: 0, speed: 0, inputActive: false, boost: false, slow: false, frozen: false, noPaint: false, erasing: false, paintScale: 1, paintSlot: null, castType: null };

// Active powerups on the board, transient render effects, and animation clock.
let powerups = [];
let impacts = [];          // meteor impact rings being animated: [{x,y,r,slot,start}]
let pickupFades = [];      // fading pickup icons: [{x,y,type,start}]
let snapFlashes = [];      // "snap" half-wipe white flashes: [{x,y,w,h,start}]
// Per-powerup transient render FX keyed by server id (gathering shadow, lightning
// strike, spawn pop, icon-switch flip). The crack sound fires once at the strike (see
// drawPowerup), aligned with the bolt rather than the earlier shadow.
const puFx = new Map();
const BOLT_MS = 360;          // lightning-strike duration, measured from the strike
const PU_TELEGRAPH_MS = 500;  // portal opens this long before the strike (match server)
let nowMs = 0;

// Paint layer at grid resolution (1px per cell), scaled up on draw.
let paintLayer = null;
let paintCtx = null;

// Layout: borderless + full-screen. The 16:9 arena is scaled to CONTAIN within
// the viewport (whole board always visible; any slack is chrome) so every player
// sees the identical arena regardless of window shape. zoom maps world px -> CSS px.
const cam = { zoom: 1, dpr: 1, cssW: 1280, cssH: 720 };

// ---- WebSocket --------------------------------------------------------------
let ws = null;

// Plain centered text (not a modal) for every connection/runtime failure mode -- the player
// otherwise just gets a silent black board. Transient states (connecting/dropped) say so with
// a trailing "…" and auto-clear the instant data arrives; hard states (blocked/stalled/
// unsupported/error) give a reason + an action. The blocked copy names the real-world cause
// (firewall/VPN) since that's the #1 culprit for "works for me, black screen for them".
const CONN_MSG = {
  connecting:  { title: 'Connecting…', sub: 'Reaching the game server.' },
  dropped:     { title: 'Connection lost', sub: 'Trying to reconnect…' },
  blocked:     { title: 'Can’t reach the game', sub: 'Your network may be blocking it — work and school firewalls, and some VPNs, block the real-time connection the game needs. Try a phone hotspot, a different network, or another device.', btn: 'Retry' },
  stalled:     { title: 'Server not responding', sub: 'Connected, but the game didn’t start — the server may be restarting. Retrying…', btn: 'Retry' },
  unsupported: { title: 'Live play unavailable', sub: 'This browser doesn’t support WebSockets, which the game needs. Try the latest Chrome, Edge, Firefox, or Safari.' },
  error:       { title: 'Something went wrong', sub: 'An unexpected error stopped the game.', btn: 'Reload' },
};
let connState = 'ok';
let connFails = 0;            // consecutive failed attempts that never received data
let connGotData = false;      // did the CURRENT socket ever receive a message
let connectedOnce = false;    // connected successfully at least once this match
let connWatchdog = null;      // force-fail a socket that opens/hangs but never sends
let connGrace = null;         // delay before surfacing a transient state (so a fast (re)connect never flashes)
let connErrShown = false;     // surface an uncaught same-origin error only once

function setConn(state, detail) {
  connState = state;
  const o = els.connOverlay;
  if (!o) return;
  if (state === 'ok') { o.classList.add('hidden'); return; }
  const m = CONN_MSG[state] || CONN_MSG.blocked;
  if (els.connTitle) els.connTitle.textContent = m.title;
  if (els.connMsg) els.connMsg.textContent = detail || m.sub;
  if (els.connBtn) { els.connBtn.textContent = m.btn || ''; els.connBtn.classList.toggle('hidden', !m.btn); }
  o.classList.remove('hidden');
}
function clearConnTimers() { clearTimeout(connWatchdog); clearTimeout(connGrace); connWatchdog = connGrace = null; }

function connect() {
  if (!('WebSocket' in window)) { setConn('unsupported'); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = myName ? `?name=${encodeURIComponent(myName)}` : '';
  connGotData = false;
  let opened = false;
  try {
    ws = new WebSocket(`${proto}://${location.host}/${params}`);
  } catch (_) { onConnClose(false); return; }
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onopen = () => { opened = true; startPing(); };
  ws.onerror = () => {};                          // an error is always followed by close; act there
  ws.onclose = () => { ws = null; stopPing(); hidePing(); clearTimeout(connWatchdog); onConnClose(opened); };
  // Some proxies accept the upgrade then hang silently -> drop a socket that sends no data in 8s.
  connWatchdog = setTimeout(() => { if (!connGotData && ws) { try { ws.close(); } catch (_) {} } }, 8000);
  // Only surface a transient state if the (re)connect is actually slow (avoid flashing on blips).
  clearTimeout(connGrace);
  connGrace = setTimeout(() => { if (!connGotData) setConn(connectedOnce ? 'dropped' : 'connecting'); }, 2500);
}

// Reconnect with backoff-ish retry; the right failure message depends on how far we got.
function onConnClose(opened) {
  clearTimeout(connGrace);
  if (inMenu) return;                             // left to the menu -> no error, no retry
  if (connGotData) {                              // the live socket dropped mid-session
    connFails = 0;
    setConn('dropped');
  } else if (connectedOnce) {
    // We connected earlier this session, so the network clearly allows WebSockets -- a
    // lost reconnect is the server (restart/crash) or a transient blip, NEVER a firewall.
    // Keep the honest "reconnecting" copy instead of falsely blaming their network.
    setConn('dropped');
  } else {
    connFails++;                                  // never got in: opened-but-silent = stalled, never-opened = blocked
    if (connFails >= 2) setConn(opened ? 'stalled' : 'blocked');
  }
  setTimeout(connect, 1200);                       // keep retrying; the first message clears the overlay
}

function disconnect() {
  clearConnTimers();
  if (ws) { try { ws.onclose = null; ws.close(); } catch (_) { /* ignore */ } ws = null; }
  stopPing();
  hidePing();
  setConn('ok');
  connFails = 0; connGotData = false; connectedOnce = false;
  remote.clear();
  me.has = false;
  spectating = true;
  currentRoomId = '';
  currentRoundId = 0;
  scores = [];
  slotNames = {};
  powerups = [];
  clearRankBar();
}

// Retry/Reload button on the overlay.
if (els.connBtn) els.connBtn.addEventListener('click', () => {
  if (connState === 'error') { location.reload(); return; }
  connFails = 0;
  setConn('connecting');
  if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; }
  stopPing();
  connect();
});

// Last resort: an uncaught error in OUR code (same-origin only, shown once) surfaces a
// message + Reload instead of a frozen/black screen. Cross-origin/extension/3rd-party
// script errors (no same-origin filename) are ignored to avoid false alarms.
window.addEventListener('error', (e) => {
  if (connErrShown || !e || !e.message) return;   // resource-load errors have no .message
  if ((e.filename || '').indexOf(location.origin) !== 0) return;
  connErrShown = true;
  setConn('error', e.message);
});

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// A paused/stalled render loop stops local paint accumulation: paintTrails() runs
// only inside the rAF frame, so paint laid down while the loop wasn't ticking is
// lost and can't be rebuilt from the 30Hz position stream. Ask the server to
// replay its authoritative visual paint log -- the same data a join-in-progress
// gets. Deduped so a burst of triggers can't spam the request.
let lastResyncAt = -Infinity;
function requestResync() {
  if (inMenu || !ws || ws.readyState !== WebSocket.OPEN) return;
  const t = performance.now();
  if (t - lastResyncAt < 500) return;
  lastResyncAt = t;
  send({ t: 'resync' });
}

// Live ping: a tiny app-level ping/pong over the match socket (every 2s, never per-frame),
// smoothed (EMA) and shown in the top bar. No connection on the landing -> stays hidden there.
let pingTimer = null;
let pingMs = 0;
function startPing() {
  stopPing();
  const tick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) send({ t: 'ping', id: performance.now() });
    pingTimer = setTimeout(tick, 2000);
  };
  tick();
}
function stopPing() {
  if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
}
function onPong(sentAt) {
  if (typeof sentAt !== 'number') return;
  const rtt = performance.now() - sentAt;
  pingMs = pingMs ? pingMs * 0.7 + rtt * 0.3 : rtt;   // EMA so the readout doesn't jitter
  const ms = Math.max(0, Math.round(pingMs));
  if (els.pingVal) els.pingVal.textContent = ms + 'ms';
  if (els.ping) {
    els.ping.classList.add('live');
    els.ping.classList.toggle('good', ms < 60);
    els.ping.classList.toggle('ok', ms >= 60 && ms < 120);
    els.ping.classList.toggle('bad', ms >= 120);
  }
}
function hidePing() {
  pingMs = 0;
  if (els.ping) els.ping.classList.remove('live', 'good', 'ok', 'bad');
}

function handle(msg) {
  // Any message means the socket is alive -> clear the connection overlay + failure count.
  if (!connGotData) { connGotData = true; connectedOnce = true; connFails = 0; clearConnTimers(); setConn('ok'); }
  if (msg.roundMs != null) roundMs = msg.roundMs;   // round length for the pre-round clock
  switch (msg.t) {
    case 'pong': { onPong(msg.id); break; }
    case 'chat': { onChat(msg); break; }
    case 'init': {
      myId = msg.id;
      currentRoomId = msg.roomId || '';
      if (msg.roundId != null) currentRoundId = msg.roundId;
      G.w = msg.grid.w; G.h = msg.grid.h; G.cell = msg.grid.cell;
      G.worldW = G.w * G.cell; G.worldH = G.h * G.cell;
      palette = msg.palette;
      paletteRGB = palette.map(hexToRGB);
      mySlot = msg.you.slot;
      if (msg.you.name) myName = msg.you.name;   // server may assign a fallback
      spectating = msg.you.spectating;
      phase = msg.phase;
      timeLeftMs = msg.timeLeftMs;
      initPaintLayer();
      resize();
      break;
    }
    case 'roundstart': {
      phase = msg.phase || 'active';
      if (msg.roundId != null) currentRoundId = msg.roundId;
      timeLeftMs = msg.timeLeftMs;
      scores = msg.scores;
      powerups = msg.powerups || [];
      impacts = [];
      pickupFades = [];
      snapFlashes = [];
      applySnapshot(msg.cells, msg.paintEvents || []);
      applyPlayers(msg.players, true);
      resetTrailAnchors();
      stopResultConfetti();
      hide(els.results);
      refreshOverlays();
      lastTickSecond = -1;
      if (GameAudio && !spectating) {
        if (msg.phase === 'countdown') GameAudio.countdown();   // pre-round 3-2-1 SFX
        else GameAudio.spawn();
      }
      break;
    }
    case 'state': {
      phase = msg.phase;
      if (msg.roundId != null) currentRoundId = msg.roundId;
      timeLeftMs = msg.timeLeftMs;
      scores = msg.scores;
      powerups = msg.powerups || [];
      // Visual paint is drawn locally as smooth strokes (see paintTrails);
      // server deltas are ignored for rendering. Scores stay authoritative.
      applyPlayers(msg.players, false);
      refreshOverlays();
      break;
    }
    case 'paintsync': {
      // Authoritative paint replay, requested when our render loop resumes after a
      // stall (backgrounded/minimized/slept tab). Rehydrate the board exactly like
      // a join-in-progress. Kept separate from 'roundstart' so it carries none of
      // the round-reset side effects (spawn sound, results toggle, tick reset).
      phase = msg.phase;
      if (msg.roundId != null) currentRoundId = msg.roundId;
      timeLeftMs = msg.timeLeftMs;
      scores = msg.scores;
      powerups = msg.powerups || [];
      applySnapshot(msg.cells, msg.paintEvents || []);
      applyPlayers(msg.players, true);   // snap render+target to the authoritative now
      resetTrailAnchors();               // re-seed anchors so no catch-up smear is drawn
      refreshOverlays();
      break;
    }
    case 'pickup': {
      // Fade the collected board icon in place. Brush status changes only for
      // actual ongoing effects, not for a decorative pickup splash.
      if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
        pickupFades.push({ x: msg.x, y: msg.y, type: msg.type || 'speed', start: nowMs });
      }
      if (GameAudio) GameAudio.pickup(msg.type || 'speed');
      break;
    }
    case 'impact': {
      // Meteor paint lands as an irregular splatter, while the ring gives impact.
      // 'mortar' strikes (erase) WIPE paint instead of laying it.
      if (msg.erase) {
        if (Array.isArray(msg.blobs)) erasePaintSplatter(msg.blobs);
        else erasePaintDisc(msg.x, msg.y, msg.r);
      } else if (Array.isArray(msg.blobs)) {
        drawPaintSplatter(msg.blobs, msg.slot);
      } else {
        drawPaintDisc(msg.x, msg.y, msg.r, msg.slot);
      }
      impacts.push({ x: msg.x, y: msg.y, r: msg.r, slot: msg.slot, start: nowMs });
      if (GameAudio) GameAudio.impact();
      break;
    }
    case 'snap': {
      // "Snap" half-wipe: clear the visible paint in the half right away, then slam a
      // bright white flash over it (drawBoardContent) that fades to reveal the erased
      // area -- reads as flash -> wiped. Grid/score authority already moved server-side.
      if (paintCtx && Number.isFinite(msg.x)) paintCtx.clearRect(msg.x, msg.y, msg.w, msg.h);
      snapFlashes.push({ x: msg.x, y: msg.y, w: msg.w, h: msg.h, start: nowMs });
      if (GameAudio && GameAudio.snap) GameAudio.snap();
      break;
    }
    case 'roundover': {
      phase = 'intermission';
      if (msg.roundId != null) currentRoundId = msg.roundId;
      scores = msg.scores;
      held.clear();
      pushInput();
      me.vx = 0;
      me.vy = 0;
      me.speed = 0;
      resetTrailAnchors();
      const won = msg.winnerSlot === mySlot && !spectating;
      if (!spectating && Store) {
        const total = G.w * G.h;
        const myPct = total ? ((msg.scores[mySlot] || 0) / total) * 100 : 0;
        const resultId = msg.roundId != null ? `${currentRoomId || 'room'}:${msg.roundId}:${myId || mySlot}` : '';
        Store.recordResult(myPct, won, resultId);
        renderStats();
      }
      if (GameAudio) GameAudio.roundEnd(won);
      showResults(msg, won);
      break;
    }
  }
}

// ---- Players ----------------------------------------------------------------
function applyPlayers(list, snap) {
  const seen = new Set();
  const ns = {};
  let foundMe = false;

  for (const pl of list) {
    seen.add(pl.id);
    ns[pl.slot] = pl.name || `P${pl.slot + 1}`;
    if (pl.id === myId) {
      foundMe = true;
      mySlot = pl.slot;
      me.boost = !!pl.boost;
      me.slow = !!pl.slow;
      me.frozen = !!pl.frozen;
      me.noPaint = !!pl.noPaint;
      me.erasing = !!pl.erasing;
      me.paintScale = Number.isFinite(pl.paintScale) ? pl.paintScale : 1;
      me.paintSlot = Number.isFinite(pl.paintSlot) ? pl.paintSlot : pl.slot;
      me.castType = pl.castType || null;
      me.inputActive = !!pl.inputActive;
      if (!me.has) {            // first authoritative position -> adopt it
        me.x = pl.x; me.y = pl.y; me.vx = 0; me.vy = 0; me.dirAngle = 0; me.has = true; me.lastPaintX = undefined;
      } else if (snap) {        // round reset -> snap to spawn
        me.x = pl.x; me.y = pl.y; me.vx = 0; me.vy = 0; me.dirAngle = 0; me.lastPaintX = undefined;
      }
      me.serverX = pl.x; me.serverY = pl.y;
      continue;
    }
    let r = remote.get(pl.id);
    if (!r) {
      r = {
        slot: pl.slot, rx: pl.x, ry: pl.y, tx: pl.x, ty: pl.y,
        face: 1, dirAngle: 0, speed: 0, inputActive: false, boost: false, slow: false, frozen: false, noPaint: false, erasing: false, paintScale: 1, paintSlot: pl.slot, echo: false, castType: null,
      };
      remote.set(pl.id, r);
    }
    r.slot = pl.slot;
    r.boost = !!pl.boost;
    r.slow = !!pl.slow;
    r.frozen = !!pl.frozen;
    r.noPaint = !!pl.noPaint;
    r.erasing = !!pl.erasing;
    r.paintScale = Number.isFinite(pl.paintScale) ? pl.paintScale : 1;
    r.paintSlot = Number.isFinite(pl.paintSlot) ? pl.paintSlot : pl.slot;
    r.echo = !!pl.echo;
    r.castType = pl.castType || null;
    r.inputActive = !!pl.inputActive;
    // Estimate speed + left/right facing from server position deltas.
    const dx = pl.x - r.tx, dy = pl.y - r.ty;
    r.speed = snap ? 0 : Math.hypot(dx, dy) * 30;   // ~px/s at the 30Hz tick
    if (dx > 0.4) r.face = 1; else if (dx < -0.4) r.face = -1;
    if (!snap && Math.hypot(dx, dy) > 0.35) r.dirAngle = Math.atan2(dy, dx);
    r.tx = pl.x; r.ty = pl.y;
    if (snap) { r.rx = pl.x; r.ry = pl.y; r.dirAngle = 0; r.lastPaintX = undefined; }
  }

  slotNames = ns;

  // Drop players no longer present.
  for (const id of remote.keys()) if (!seen.has(id)) remote.delete(id);

  // If I'm not in the active player list, I'm a spectator.
  spectating = !foundMe;
  if (spectating) me.has = false;
}

// ---- Paint layer (soft, splashy splats decoupled from the scoring grid) -----
// Supersample the paint layer so trails stay crisp when the board is scaled up
// on large screens (the layer is PAINT_SS x world res; all paint ops use world
// coords via the baked-in scale, and render() scales it back down to the board).
const PAINT_SS = 2;
function initPaintLayer() {
  paintLayer = document.createElement('canvas');
  paintLayer.width = G.worldW * PAINT_SS;
  paintLayer.height = G.worldH * PAINT_SS;
  paintCtx = paintLayer.getContext('2d');
  paintCtx.setTransform(PAINT_SS, 0, 0, PAINT_SS, 0, 0);   // draw in world coords at SS resolution
  paintCtx.imageSmoothingEnabled = true;
}

function makeSnapshotStamps() {
  snapshotStamps = palette.map((hex) => {
    const c = document.createElement('canvas');
    c.width = c.height = SNAPSHOT_STAMP_PX;
    const g = c.getContext('2d');
    const m = SNAPSHOT_STAMP_PX / 2;
    g.fillStyle = hex;
    g.beginPath();
    g.arc(m, m, m, 0, Math.PI * 2);
    g.fill();
    return c;
  });
}

function drawSnapshotCell(slot, idx) {
  const img = snapshotStamps[slot];
  if (!img) return;
  const cx = idx % G.w;
  const cy = (idx - cx) / G.w;
  const wx = cx * G.cell + G.cell / 2;
  const wy = cy * G.cell + G.cell / 2;
  paintCtx.drawImage(img, wx - SNAPSHOT_STAMP_PX / 2, wy - SNAPSHOT_STAMP_PX / 2);
}

function replayPaintEvents(events) {
  paintCtx.lineCap = 'round';
  paintCtx.lineJoin = 'round';
  for (const ev of events) {
    const slot = ev.slot;
    const col = palette[slot] || '#fff';
    if (ev.t === 'stroke') {
      const w = Number.isFinite(ev.w) ? ev.w : TRAIL_W;
      if (ev.erase) {
        paintCtx.save();
        paintCtx.globalCompositeOperation = 'destination-out';
        paintCtx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        paintCtx.strokeStyle = col;
      }
      paintCtx.lineWidth = w;
      paintCtx.beginPath();
      paintCtx.moveTo(ev.x1, ev.y1);
      paintCtx.lineTo(ev.x2, ev.y2);
      paintCtx.stroke();
      if (ev.erase) paintCtx.restore();
    } else if (ev.t === 'disc') {
      drawPaintDisc(ev.x, ev.y, ev.r, slot);
    } else if (ev.t === 'splatter') {
      if (ev.erase) erasePaintSplatter(ev.blobs);
      else drawPaintSplatter(ev.blobs, slot);
    } else if (ev.t === 'wipe') {
      // "Snap" replay: clear the wiped half so a join/refresh matches the live board.
      paintCtx.clearRect(ev.x, ev.y, ev.w, ev.h);
    }
  }
}

function jitter(seed) {
  return Math.sin(seed * 127.1 + 311.7) * 43758.5453123 % 1;
}

function drawPaintBlob(x, y, r, slot, seed) {
  if (!paintCtx || !palette[slot] || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) return;
  const points = Math.max(7, Math.min(13, Math.round(r / 2.8) + 4));
  paintCtx.fillStyle = palette[slot];
  paintCtx.beginPath();
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const wobble = 0.78 + Math.abs(jitter(seed + i * 13.3)) * 0.42;
    const px = x + Math.cos(a) * r * wobble;
    const py = y + Math.sin(a) * r * wobble;
    if (i === 0) paintCtx.moveTo(px, py);
    else paintCtx.lineTo(px, py);
  }
  paintCtx.closePath();
  paintCtx.fill();
}

function drawPaintDisc(x, y, r, slot) {
  drawPaintBlob(x, y, r, slot, x * 0.31 + y * 0.17 + r);
}

function drawPaintSplatter(blobs, slot) {
  if (!Array.isArray(blobs)) return;
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    drawPaintBlob(b.x, b.y, b.r, slot, b.x * 0.23 + b.y * 0.41 + i * 19.7);
  }
}

// Erase variants: the same blob shapes, composited to CLEAR the paint layer -- "mortar"
// craters wipe paint instead of laying it (mirrors the destination-out erase strokes).
function erasePaintBlob(x, y, r, seed) {
  if (!paintCtx || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) return;
  const points = Math.max(7, Math.min(13, Math.round(r / 2.8) + 4));
  paintCtx.save();
  paintCtx.globalCompositeOperation = 'destination-out';
  paintCtx.fillStyle = 'rgba(0,0,0,1)';
  paintCtx.beginPath();
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const wobble = 0.78 + Math.abs(jitter(seed + i * 13.3)) * 0.42;
    const px = x + Math.cos(a) * r * wobble;
    const py = y + Math.sin(a) * r * wobble;
    if (i === 0) paintCtx.moveTo(px, py);
    else paintCtx.lineTo(px, py);
  }
  paintCtx.closePath();
  paintCtx.fill();
  paintCtx.restore();
}

function erasePaintDisc(x, y, r) {
  erasePaintBlob(x, y, r, x * 0.31 + y * 0.17 + r);
}

function erasePaintSplatter(blobs) {
  if (!Array.isArray(blobs)) return;
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    erasePaintBlob(b.x, b.y, b.r, b.x * 0.23 + b.y * 0.41 + i * 19.7);
  }
}

function applySnapshot(b64, paintEvents = []) {
  if (!paintCtx) initPaintLayer();
  paintCtx.clearRect(0, 0, G.worldW, G.worldH);

  // Prefer high-res server replay so refresh/spectator views match live play.
  // The score grid fallback is only for compatibility if replay data is absent.
  if (paintEvents.length) {
    replayPaintEvents(paintEvents);
    return;
  }

  if (snapshotStamps.length !== palette.length) makeSnapshotStamps();
  const bytes = b64ToBytes(b64);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 255) drawSnapshotCell(bytes[i], i);
  }
}

// Paint a smooth ribbon segment under each brush, from its last painted point to
// its CURRENT on-screen position. Same position as the sprite -> always in unison,
// never leading, and continuous round-capped strokes read as flowing paint.
function paintTrails() {
  if (phase !== 'active') {
    resetTrailAnchors();
    return;
  }
  if (!paintCtx) return;
  paintCtx.lineCap = 'round';
  paintCtx.lineJoin = 'round';
  if (me.has && !spectating) strokeSeg(me, Number.isFinite(me.paintSlot) ? me.paintSlot : mySlot, me.x, me.y);
  for (const r of remote.values()) strokeSeg(r, Number.isFinite(r.paintSlot) ? r.paintSlot : r.slot, r.rx, r.ry);
}

function resetTrailAnchors() {
  me.lastPaintX = undefined;
  me.lastPaintY = undefined;
  for (const r of remote.values()) {
    r.lastPaintX = undefined;
    r.lastPaintY = undefined;
  }
}

function strokeSeg(b, slot, cx, cy) {
  if (b.lastPaintX === undefined) { b.lastPaintX = cx; b.lastPaintY = cy; return; }
  if (b.noPaint) { b.lastPaintX = cx; b.lastPaintY = cy; return; }   // ink-jammed: no paint
  const dx = cx - b.lastPaintX, dy = cy - b.lastPaintY;
  const d2 = dx * dx + dy * dy;
  if (d2 < 0.4) return;
  if (d2 < 90 * 90) {            // skip teleports (respawn)
    const w = TRAIL_W * (Number.isFinite(b.paintScale) ? b.paintScale : 1);
    if (b.erasing) {
      paintCtx.save();
      paintCtx.globalCompositeOperation = 'destination-out';
      paintCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      paintCtx.strokeStyle = palette[slot] || '#fff';
    }
    paintCtx.lineWidth = w;
    paintCtx.beginPath();
    paintCtx.moveTo(b.lastPaintX, b.lastPaintY);
    paintCtx.lineTo(cx, cy);
    paintCtx.stroke();
    if (b.erasing) paintCtx.restore();
  }
  b.lastPaintX = cx; b.lastPaintY = cy;
}

// ---- Input (WASD + diagonals) ----------------------------------------------
const KEYMAP = {
  KeyW: 0, ArrowUp: 0,
  KeyS: 1, ArrowDown: 1,
  KeyA: 2, ArrowLeft: 2,
  KeyD: 3, ArrowRight: 3,
};
// Dir codes: 0=up 1=down 2=left 3=right.
const held = new Set();      // directions currently held down
let sentMx = 9, sentMy = 9;  // last sent axes (9 = impossible -> forces first send)

// Resolve held keys to a 2D move vector (mx,my each in {-1,0,1}). Opposite keys
// on an axis CANCEL each other (SOCD-neutral); both axes may be active at once,
// which yields diagonal movement.
function currentInput() {
  const up = held.has(0), down = held.has(1), left = held.has(2), right = held.has(3);
  const my = (up && !down) ? -1 : (down && !up) ? 1 : 0;  // screen up = -y
  const mx = (left && !right) ? -1 : (right && !left) ? 1 : 0;
  return { mx, my };
}

function pushInput() {
  const { mx, my } = currentInput();
  if (mx !== sentMx || my !== sentMy) {
    sentMx = mx; sentMy = my;
    send({ t: 'input', mx, my });
  }
}

// Game keys steer in a match AND in the landing tutorial sim -- but never while
// typing in a field (so WASD types the name instead of steering).
function inputBlocked(e) {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (inMenu) return !SIM.started;
  return false;
}

window.addEventListener('keydown', (e) => {
  if (inputBlocked(e)) return;
  const d = KEYMAP[e.code];
  if (d === undefined) return;
  e.preventDefault();
  if (e.repeat) return;
  // First steer on the landing is a gesture: unlock audio so the tutorial sim
  // gets the full mix (music bed, pickups, lightning) just like a real match.
  if (inMenu && GameAudio) GameAudio.unlock();
  held.add(d);
  pushInput();
});

window.addEventListener('keyup', (e) => {
  if (inputBlocked(e)) return;
  const d = KEYMAP[e.code];
  if (d === undefined) return;
  e.preventDefault();
  held.delete(d);
  pushInput();
});

// Stop moving if focus is lost.
window.addEventListener('blur', () => { held.clear(); pushInput(); });

// A key released while a field has focus never reaches our keyup (inputBlocked),
// which would strand the brush running on a stuck direction -- entering a field
// drops all held movement.
window.addEventListener('focusin', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') { held.clear(); pushInput(); }
});

// ---- Quick chat ---------------------------------------------------------------
// Tiny bottom-right strip, match only. The server is the real gatekeeper
// (sanitize + word/length caps + per-player throttle in room.js); the client
// mirrors the caps for live feedback and keeps the panel out of the way: it
// fades to near-transparent (.idle) after a quiet spell, and Enter walks focus
// in (global listener) and back out (send blurs) so hands stay on WASD. The
// settings gear can switch it off entirely (persisted via Store prefs).
const CHAT_MAX_WORDS = 10;     // keep in sync with config MAX_CHAT_WORDS
const CHAT_LOG_MAX = 4;        // visible message lines before the oldest drops
const CHAT_IDLE_MS = 5000;     // quiet spell before the panel fades
const CHAT_THROTTLE_MS = 1500; // keep in sync with config CHAT_THROTTLE_MS
let chatIdleTimer = null;

function chatEnabled() {
  return Store ? Store.getPrefs().chat !== false : true;
}

// Any chat activity (message in, focus, send) wakes the panel; it fades back
// to .idle after the quiet spell unless someone is mid-typing.
function chatWake() {
  if (!els.chat) return;
  els.chat.classList.remove('idle');
  clearTimeout(chatIdleTimer);
  chatIdleTimer = setTimeout(() => {
    if (document.activeElement === els.chatInput) { chatWake(); return; }
    els.chat.classList.add('idle');
  }, CHAT_IDLE_MS);
}

// Reflect the setting: checkbox state + panel visibility (body.in-menu hides it
// on the landing regardless). Turning chat off also drops the backlog.
function syncChatUI() {
  const on = chatEnabled();
  if (els.chatToggle) els.chatToggle.checked = on;
  if (els.chat) els.chat.classList.toggle('hidden', !on);
  if (!on && els.chatLog) els.chatLog.textContent = '';
}

function clearChat() {
  if (els.chatLog) els.chatLog.textContent = '';
  if (els.chatInput) els.chatInput.value = '';
}

function onChat(msg) {
  if (inMenu || !chatEnabled() || !els.chatLog) return;
  const line = document.createElement('div');
  line.className = 'chat-line';
  const name = document.createElement('span');
  name.className = 'chat-name';
  const slot = Number.isInteger(msg.slot) ? msg.slot : -1;
  // Spectators chat with slot -1 -> neutral; seated players get their paint color.
  name.style.color = slot >= 0 && palette[slot] ? palette[slot] : 'var(--st-muted-fg)';
  name.textContent = String(msg.name || '');
  const text = document.createElement('span');
  text.textContent = String(msg.text || '');   // textContent: no markup path, ever
  line.append(name, text);
  els.chatLog.appendChild(line);
  while (els.chatLog.children.length > CHAT_LOG_MAX) els.chatLog.firstChild.remove();
  chatWake();
}

let lastChatSentAt = -Infinity;   // client mirror of the server throttle

function sendChat() {
  if (!els.chatInput) return;
  let text = els.chatInput.value.replace(/\s+/g, ' ').trim();
  if (text) {
    // Mirror the server's per-player throttle: hammering Enter inside the window
    // keeps the text and focus (try again in a beat) instead of firing frames
    // the server would silently drop -- the player sees their message intact.
    const t = performance.now();
    if (t - lastChatSentAt < CHAT_THROTTLE_MS) return;
    lastChatSentAt = t;
    const words = text.split(' ');
    if (words.length > CHAT_MAX_WORDS) text = words.slice(0, CHAT_MAX_WORDS).join(' ');
    send({ t: 'chat', text });
  }
  els.chatInput.value = '';
  els.chatInput.blur();            // hand the keys straight back to the brush
  chatWake();
}

if (els.chatForm) els.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
if (els.chatInput) {
  els.chatInput.addEventListener('focus', chatWake);
  els.chatInput.addEventListener('blur', chatWake);    // restart the idle clock on the way out
  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); els.chatInput.blur(); }
  });
  // Live word cap: typing visibly stops accepting an 11th word (the maxlength
  // attribute already bounds raw characters). Trims only AT the limit, so the
  // cursor jump to the end never happens during normal typing.
  els.chatInput.addEventListener('input', () => {
    const words = els.chatInput.value.split(/\s+/).filter(Boolean);
    if (words.length > CHAT_MAX_WORDS) els.chatInput.value = words.slice(0, CHAT_MAX_WORDS).join(' ');
  });
}

// Enter opens the chat box mid-match (Enter again sends, via the form). Skipped
// while any field/button has focus so it never steals a real Enter.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
  if (inMenu || !chatEnabled() || !els.chatInput) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  e.preventDefault();
  els.chatInput.focus();
});

// ---- Prediction + interpolation --------------------------------------------
// Shared local-brush physics: apply an input vector to `me`, integrate velocity
// with the active effect multipliers, advance, and wall-clamp. Mirrors the
// server's stepPlayer(); used by match prediction (predict) and the landing
// tutorial sim (simTick) so both move identically.
function driveBrush(mx, my, dt) {
  me.inputActive = !!(mx || my);
  let speedMult = 1;
  if (me.boost) speedMult *= BOOST_MULT;
  if (me.slow) speedMult *= SLOW_MULT;
  if (me.paintScale < 1) speedMult *= TINY_SPEED_MULT;
  const accel = ACCEL * speedMult;
  const maxSpeed = MAX_SPEED * speedMult;
  if (mx || my) {
    const len = Math.hypot(mx, my);   // normalize so diagonals aren't faster
    me.dirAngle = Math.atan2(my, mx);
    me.vx += (mx / len) * accel * dt;
    me.vy += (my / len) * accel * dt;
  }
  const damp = Math.exp(-DAMPING_PER_SEC * dt);
  me.vx *= damp; me.vy *= damp;
  const sp = Math.hypot(me.vx, me.vy);
  if (sp > maxSpeed) { const k = maxSpeed / sp; me.vx *= k; me.vy *= k; }

  me.x += me.vx * dt;
  me.y += me.vy * dt;
  if (me.x < BRUSH_R) { me.x = BRUSH_R; if (me.vx < 0) me.vx = 0; }
  if (me.x > G.worldW - BRUSH_R) { me.x = G.worldW - BRUSH_R; if (me.vx > 0) me.vx = 0; }
  if (me.y < BRUSH_R) { me.y = BRUSH_R; if (me.vy < 0) me.vy = 0; }
  if (me.y > G.worldH - BRUSH_R) { me.y = G.worldH - BRUSH_R; if (me.vy > 0) me.vy = 0; }
}

// Refresh the derived kinematics (speed for anim states, left/right facing,
// drift heading) after the position has settled for this frame.
function finishBrushKinematics() {
  me.speed = Math.hypot(me.vx, me.vy);
  if (me.vx > FACE_EPS) me.face = 1;
  else if (me.vx < -FACE_EPS) me.face = -1;
  if (me.speed > DRIFT_EPS) me.dirAngle = Math.atan2(me.vy, me.vx);
}

function predict(dt) {
  if (!me.has) return;
  if (phase !== 'active') {
    me.vx = 0; me.vy = 0; me.speed = 0;
    me.inputActive = false;
    if (me.serverX !== undefined) {
      me.x += (me.serverX - me.x) * 0.35;
      me.y += (me.serverY - me.y) * 0.35;
    }
    return;
  }
  if (me.frozen) {                      // frozen by a rival: locked in place
    me.vx = 0; me.vy = 0; me.speed = 0;
    me.inputActive = false;
    if (me.serverX !== undefined) { me.x += (me.serverX - me.x) * 0.2; me.y += (me.serverY - me.y) * 0.2; }
    return;
  }
  const { mx, my } = currentInput();
  driveBrush(mx, my, dt);

  // Gently reconcile toward the server's authoritative position.
  if (me.serverX !== undefined) {
    const dx = me.serverX - me.x;
    const dy = me.serverY - me.y;
    const err = Math.hypot(dx, dy);
    if (err > RECONCILE_HARD_DIST) {
      me.x = me.serverX;
      me.y = me.serverY;
      me.vx = 0;
      me.vy = 0;
    } else if (err > RECONCILE_SOFT_DIST) {
      me.x += dx * RECONCILE_SOFT_GAIN;
      me.y += dy * RECONCILE_SOFT_GAIN;
    }
  }

  finishBrushKinematics();
}

function interpolateRemotes() {
  for (const r of remote.values()) {
    r.rx += (r.tx - r.rx) * 0.35;
    r.ry += (r.ty - r.ry) * 0.35;
  }
}

// ---- Render -----------------------------------------------------------------
// RGB(0-255) <-> HSL(h deg, s/l 0-1), used to recolor the brush's pink paint.
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  h /= 360;
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Recolor the brush's pink "paint" pixels to the player's hue (lazy + cached).
function getTintedSheet(slot) {
  if (tintedSheets[slot]) return tintedSheets[slot];
  if (!petReady || !paletteRGB[slot]) return null;
  const [targetHue, targetSat, targetL] = rgbToHsl(paletteRGB[slot][0], paletteRGB[slot][1], paletteRGB[slot][2]);
  const c = document.createElement('canvas');
  c.width = petSheet.naturalWidth; c.height = petSheet.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(petSheet, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (s > 0.22 && h >= 285 && h <= 355) {   // pink/magenta paint -> player hue
      // Pure hue-swap leaves the source pink's saturation/lightness, which washes
      // out bright targets (yellow) and lets warm ones blend into the brush handle.
      // Bias saturation toward the target and temper highlights so every hue reads.
      const ns = Math.min(1, s * 0.45 + targetSat * 0.6);
      const nl = l > 0.5 ? 0.5 + (l - 0.5) * (1 - 0.45 * targetL) : l;
      const [nr, ng, nb] = hslToRgb(targetHue, ns, nl);
      d[i] = nr; d[i + 1] = ng; d[i + 2] = nb;
    }
  }
  g.putImageData(img, 0, 0);
  tintedSheets[slot] = c;
  return c;
}

function petState(speed, boost, frozen, noPaint, castType, inputActive) {
  const moving = !!inputActive;
  if (frozen) return 'frozen-disabled';
  if (noPaint) return moving ? 'inkjam-disabled' : 'inkjam-disabled-idle';
  if (castType === 'freeze') return moving ? 'freeze-cast' : 'freeze-idle';
  if (castType === 'missile') return moving ? 'missile-cast' : 'missile-idle';
  if (boost) return moving ? 'speed' : 'speed-idle';
  if (!inputActive && speed > DRIFT_EPS) return 'drift';
  if (speed > MOVE_EPS) return 'running-right';
  return 'idle';
}

function brushPose(state, face, dirAngle) {
  const directional =
    state === 'running-right' ||
    state === 'running-left' ||
    state === 'speed' ||
    state === 'freeze-cast' ||
    state === 'inkjam-disabled' ||
    state === 'missile-cast';
  if (!directional) return { rowState: state, flipX: 1, directional: false };

  const fallback = face < 0 ? Math.PI : 0;
  const heading = Number.isFinite(dirAngle) ? dirAngle : fallback;
  const cos = Math.cos(heading);
  const headingLeft = cos < -0.08 || (Math.abs(cos) <= 0.08 && face < 0);

  if (state === 'running-right' || state === 'running-left') {
    return { rowState: headingLeft ? 'running-left' : 'running-right', flipX: 1, directional: true };
  }

  return { rowState: state, flipX: headingLeft ? -1 : 1, directional: true };
}

function drawGroundShadow(x, y, rx, ry, alpha = 0.32) {
  ctx.save();
  const g = ctx.createRadialGradient(x, y, 1, x, y, Math.max(rx, ry));
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCountdownPlayerArrow(x, spriteTop, drawH, scaleCue) {
  if (!playerArrowReady || phase !== 'countdown') return;

  const lift = prefersReducedMotion() ? 0 : (0.5 + 0.5 * Math.sin((nowMs / PLAYER_ARROW_BOB_MS) * Math.PI * 2)) * PLAYER_ARROW_BOB_PX;
  const scale = Math.max(0.88, Math.min(1.08, 0.96 + scaleCue * 0.04));
  const size = PLAYER_ARROW_SIZE * scale;
  const brushTop = spriteTop + drawH * PLAYER_ARROW_BRUSH_TOP_INSET;
  const tipY = Math.max(size * PLAYER_ARROW_TIP_Y + 8, brushTop - PLAYER_ARROW_GAP - lift);
  const y = tipY - size * PLAYER_ARROW_TIP_Y;

  ctx.save();
  ctx.globalAlpha = 0.98;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.drawImage(playerArrow, x + PLAYER_ARROW_X_OFFSET - size / 2, y, size, size);
  ctx.restore();
}

// Draw the in-game brush spirit. The atlas owns pose; runtime only selects a
// row and mirrors speed-left. Do not rotate brush sprites to fake direction.
function spriteDrawHeight(state) {
  let h;
  if (state === 'idle' || state.endsWith('-idle')) h = PET_IDLE_DRAW_H;
  else if (state === 'drift') h = PET_DRIFT_DRAW_H;
  else h = PET_DRAW_H;
  // The ink-jam (no-paint) art reads a touch larger than the other states because
  // of its spiky ink burst; trim it slightly so it matches the rest.
  if (state === 'inkjam-disabled' || state === 'inkjam-disabled-idle') h *= 0.94;
  return h;
}

function drawBrushSprite(x, y, slot, face, dirAngle, speed, isMe, boost, frozen, noPaint, castType, inputActive, paintScale = 1, isEcho = false) {
  const col = palette[slot] || '#fff';
  const echoMul = isEcho ? 0.5 : 1;   // ghost twin: render the whole sprite translucent
  const state = petState(speed, boost, frozen, noPaint, castType, inputActive);
  const pose = brushPose(state, face, dirAngle);
  const st = PET.states[state] || PET.states.idle;
  const rowSt = PET.states[pose.rowState] || st;
  const ts = getTintedSheet(slot);
  if (!ts) return;
  // Brush-size powerups (mega/tiny) visibly grow/shrink the spirit to match its
  // brush -- near-linear so it reads clearly, lightly damped + clamped so it never
  // gets grotesque (mega 1.55 -> ~1.45x, tiny 0.55 -> ~0.6x, normal -> 1x).
  const ps = Number.isFinite(paintScale) ? paintScale : 1;
  const scaleCue = Math.max(0.55, Math.min(1.5, Math.pow(ps, 0.85)));
  const drawH = spriteDrawHeight(state) * scaleCue;
  const idleScale = drawH / PET_DRAW_H;

  // Colored ground glow (identity) + "you" ring.
  drawGroundShadow(x, y + 12, 21 * idleScale, 7 * idleScale, (frozen ? 0.2 : 0.34) * echoMul);
  ctx.save();
  ctx.globalAlpha = (frozen ? 0.22 : 0.42) * echoMul; ctx.fillStyle = col;
  ctx.beginPath(); ctx.ellipse(x, y + 9, 14 * idleScale, 5 * idleScale, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (isMe) {
    ctx.save();
    ctx.globalAlpha = 0.95; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(x, y + 9, 16 * idleScale, 6 * idleScale, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  const frame = Math.floor(nowMs / st.rate) % st.frames;
  const sx = ((rowSt.col || 0) + frame) * PET.cellW, sy = rowSt.row * PET.cellH;
  const dw = PET.cellW * (drawH / PET.cellH);
  const dh = drawH;
  const spriteTop = y - dh * PET_ANCHOR_Y;
  ctx.save();
  ctx.globalAlpha = (frozen ? 0.92 : 1) * echoMul;
  if (pose.directional) {
    ctx.translate(x, y);
    ctx.scale(pose.flipX, 1);
    ctx.drawImage(ts, sx, sy, PET.cellW, PET.cellH, -dw / 2, -dh * PET_ANCHOR_Y, dw, dh);
  } else {
    ctx.drawImage(ts, sx, sy, PET.cellW, PET.cellH, x - dw / 2, y - dh * PET_ANCHOR_Y, dw, dh);
  }
  ctx.restore();
  if (isMe) drawCountdownPlayerArrow(x, spriteTop, drawH, scaleCue);
}

function drawPowerupSprite(type, rowName, x, y, size, alpha = 1, scaleX = 1, scaleY = 1) {
  if (!powerupReady) return false;
  const col = POWERUP_SHEET.cols[type] !== undefined ? POWERUP_SHEET.cols[type] : POWERUP_SHEET.cols.speed;
  const row = POWERUP_SHEET.rows[rowName] !== undefined ? POWERUP_SHEET.rows[rowName] : POWERUP_SHEET.rows.active;
  const sx = col * POWERUP_SHEET.cellW;
  const sy = row * POWERUP_SHEET.cellH;
  // Columns past what the loaded sheet actually contains (e.g. a new power-up whose art
  // hasn't been added yet) render as nothing rather than sampling off-image.
  if (sx + POWERUP_SHEET.cellW > powerupSheet.naturalWidth + 0.5) return false;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
  ctx.drawImage(
    powerupSheet,
    sx, sy, POWERUP_SHEET.cellW, POWERUP_SHEET.cellH,
    -size / 2, -size / 2, size, size,
  );
  ctx.restore();
  return true;
}

function drawPickupFade(fx) {
  const age = (nowMs - fx.start) / POWERUP_FADE_MS;
  if (age < 0 || age >= 1) return;
  const alpha = Math.pow(1 - age, 1.35);
  drawPowerupSprite(fx.type, 'disabled', fx.x, fx.y, 56, alpha);
}

// Lazily track per-powerup FX state and detect type switches. The server only
// sends the current type, so a change here means the icon just cycled (the twist).
function powerupFx(pu) {
  let fx = puFx.get(pu.id);
  if (!fx) {
    // First seen mid-shadow -> play the gather, then strike. First seen already armed
    // (join/resync) -> backdate past the strike so it appears settled, no replay.
    const settled = pu.armed === true;
    fx = {
      bornMs: settled ? nowMs - PU_TELEGRAPH_MS - BOLT_MS : nowMs,
      switchMs: -1e9, type: pu.type, bolt: makeBolt(pu.x, pu.y), struck: settled,
    };
    puFx.set(pu.id, fx);
  } else if (fx.type !== pu.type) { fx.type = pu.type; fx.switchMs = nowMs; }
  return fx;
}
function prunePowerupFx() {
  if (!puFx.size) return;
  const live = new Set(powerups.map((p) => p.id));
  for (const id of puFx.keys()) if (!live.has(id)) puFx.delete(id);
}

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1, u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}
// Soft glow so a powerup reads against busy paint -- kept type-agnostic (white/
// cream) so it never leaks the good/bad identity; reading the icon is the skill.
function powerupGlow(x, y, r, alpha) {
  const g = ctx.createRadialGradient(x, y, 1, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${alpha})`);
  g.addColorStop(0.55, `rgba(255,246,210,${alpha * 0.5})`);
  g.addColorStop(1, 'rgba(255,246,210,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
function powerupRing(x, y, r, alpha, w) {
  if (alpha <= 0.002 || r <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function strokePath(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}
// A cluster of 3-4 bold lightning bolts that fan out from spread entry points and
// converge onto a tight strike zone on the powerup, each with an occasional fork.
// Generated once per strike so the cluster holds while it flickers. Returns an
// array of polylines (drawBolt renders every one bold).
function makeBolt(x, y) {
  const strokes = [];
  const count = 3 + ((Math.random() * 2) | 0);       // 3-4 bolts
  for (let b = 0; b < count; b++) {
    const topY = Math.max(0, y - (110 + Math.random() * 90));
    const topX = x + (Math.random() - 0.5) * 130;    // fan the entry points apart...
    const ex = x + (Math.random() - 0.5) * 16;        // ...onto a tight strike cluster
    const ey = y + (Math.random() - 0.5) * 12;
    const segs = 7 + ((Math.random() * 2) | 0);
    const main = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const amp = 20 * (1 - t);                       // jitter shrinks to 0 at the strike
      const baseX = topX + (ex - topX) * t;           // centerline drifts entry -> strike
      main.push([i === segs ? ex : baseX + (Math.random() - 0.5) * 2 * amp, topY + (ey - topY) * t]);
    }
    strokes.push(main);
    if (Math.random() < 0.5) {                        // an occasional fork for streakiness
      const j = 2 + ((Math.random() * (segs - 2)) | 0);
      const dir = Math.random() < 0.5 ? -1 : 1;
      let fxp = main[j][0], fyp = main[j][1];
      const fork = [[fxp, fyp]];
      const n = 2 + ((Math.random() * 2) | 0);
      for (let i = 0; i < n; i++) { fxp += dir * (8 + Math.random() * 12); fyp += 9 + Math.random() * 14; fork.push([fxp, fyp]); }
      strokes.push(fork);
    }
  }
  return strokes;
}
// Layered draw: wide blue glow + light-blue mid + white core = classic bolt.
function drawBolt(strokes, alpha) {
  if (alpha <= 0.02) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const passes = [['#6fb0ff', 9, 0.55], ['#cfe6ff', 4, 0.85], ['#ffffff', 2, 1.1]];
  for (const [color, w, a] of passes) {
    ctx.globalAlpha = Math.min(1, alpha * a);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    for (const s of strokes) strokePath(s);
  }
  ctx.restore();
}
// Blue-white flash at the strike point.
function lightningFlash(x, y, r, alpha) {
  if (alpha <= 0.01) return;
  const g = ctx.createRadialGradient(x, y, 1, x, y, r);
  g.addColorStop(0, `rgba(235,245,255,${alpha})`);
  g.addColorStop(0.5, `rgba(150,200,255,${alpha * 0.5})`);
  g.addColorStop(1, 'rgba(120,180,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// Opening portal before the strike (p: 0 -> 1 across the telegraph). An oval portal
// irises open on the ground -- soft halo, a dark mouth with light rising from the depth,
// a glowing 3D rim, a sweeping energy arc, and electric sparks crackling off the edge --
// then the bolt strikes through it. The oval + depth keep it from reading as a flat
// sticker on the paint. Type-agnostic (no icon) so it never leaks the good/bad identity.
function drawPowerupPortal(x, y, p, id) {
  const e = p * p * (3 - 2 * p);                          // smoothstep open
  const rx = 6 + 16 * e;                                  // portal irises open (halo/mouth/sparks scale off this)
  const ry = rx * 0.46;                                   // oval -> a portal lying in perspective
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Soft outer halo.
  const halo = ctx.createRadialGradient(x, y, 1, x, y, rx * 1.7);
  halo.addColorStop(0, `rgba(120,185,255,${0.18 * e})`);
  halo.addColorStop(1, 'rgba(120,185,255,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.ellipse(x, y, rx * 1.7, ry * 1.7, 0, 0, Math.PI * 2); ctx.fill();
  // Dark mouth -> reads as a hole punched in the surface, not a decal on the paint.
  ctx.fillStyle = `rgba(6,10,24,${0.55 * e})`;
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  // Light rising from the depth.
  const depth = ctx.createRadialGradient(x, y, 1, x, y, rx * 0.9);
  depth.addColorStop(0, `rgba(190,228,255,${0.55 * e})`);
  depth.addColorStop(0.5, `rgba(80,145,240,${0.30 * e})`);
  depth.addColorStop(1, 'rgba(20,45,95,0)');
  ctx.fillStyle = depth;
  ctx.beginPath(); ctx.ellipse(x, y, rx * 0.85, ry * 0.85, 0, 0, Math.PI * 2); ctx.fill();
  // Glowing rim + a thin inner lip -> a 3D edge.
  ctx.lineWidth = 2.4; ctx.strokeStyle = `rgba(205,238,255,${0.9 * e})`;
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1; ctx.strokeStyle = `rgba(120,180,255,${0.55 * e})`;
  ctx.beginPath(); ctx.ellipse(x, y, rx * 0.88, ry * 0.88, 0, 0, Math.PI * 2); ctx.stroke();
  // Energy arc sweeping the rim -> the portal feels alive.
  const spin = nowMs * 0.005 + id * 2;
  ctx.lineWidth = 2.6; ctx.strokeStyle = `rgba(255,255,255,${0.8 * e})`;
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, spin, spin + 1.1); ctx.stroke();
  // Electric sparks crackling off the rim, busier near the strike.
  const burst = 0.5 + 0.5 * Math.sin(nowMs * 0.02 + id * 2.1);
  const count = 1 + Math.floor(e * 4 + burst * 2);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    let sx = x + Math.cos(a) * rx, sy = y + Math.sin(a) * ry;
    const len = (4 + 12 * e) * (0.5 + Math.random() * 0.5);
    const nx = Math.cos(a), ny = Math.sin(a) * 0.8;       // splay outward along the oval
    const pts = [[sx, sy]];
    const segs = 2 + ((Math.random() * 2) | 0);
    for (let s = 1; s <= segs; s++) {
      const f = s / segs;
      sx += nx * (len / segs) + (Math.random() - 0.5) * 5 * (1 - f);
      sy += ny * (len / segs) + (Math.random() - 0.5) * 5 * (1 - f);
      pts.push([sx, sy]);
    }
    const alpha = (0.45 + 0.55 * Math.random()) * (0.4 + 0.6 * e);
    ctx.globalAlpha = alpha * 0.5; ctx.strokeStyle = '#7fb4ff'; ctx.lineWidth = 2.2; strokePath(pts);
    ctx.globalAlpha = alpha; ctx.strokeStyle = '#eaf4ff'; ctx.lineWidth = 1; strokePath(pts);
  }
  ctx.restore();
}

function drawPowerup(pu) {
  if (!powerupReady) return;
  const fx = powerupFx(pu);
  const bob = Math.sin(nowMs / 420 + pu.id * 1.3) * 1.5;
  const x = pu.x, y = pu.y + bob;
  const age = nowMs - fx.bornMs;

  // Telegraph: an oval portal opens for PU_TELEGRAPH_MS, then the bolt strikes through it
  // and the powerup lands. The warning gives nearby contesters a fair start; the icon
  // stays hidden so the portal never leaks the good/bad identity. liveAge measures time
  // since the strike -- the pop/bolt/icon all key off it.
  const liveAge = age - PU_TELEGRAPH_MS;
  if (liveAge < 0) { drawPowerupPortal(pu.x, pu.y, age / PU_TELEGRAPH_MS, pu.id); return; }
  // The crack lands with the bolt, not with the portal -- once per powerup.
  if (!fx.struck) {
    fx.struck = true;
    if (phase === 'active' && GameAudio && GameAudio.powerupSpawn) GameAudio.powerupSpawn();
  }

  // Spawn pop: scale up from nothing with a little overshoot (first 320ms after the strike).
  const scale = liveAge < 320 ? Math.max(0, easeOutBack(liveAge / 320)) : 1;
  // Gentle idle pulse so it keeps catching the eye while it sits on the board.
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 360 + pu.id * 1.7);

  drawGroundShadow(x, y + 19, 24, 8, 0.34);
  powerupGlow(x, y, (28 + 4 * pulse) * Math.max(scale, 0.6), 0.16 + 0.07 * pulse);

  // Lightning strike: a cluster of jagged bolts cracks down onto the powerup as it
  // lands and flickers out.
  if (liveAge < BOLT_MS && fx.bolt) {
    const e = 1 - liveAge / BOLT_MS;
    const flick = Math.pow(Math.abs(Math.cos(liveAge * 0.05)), 0.6) * e;
    lightningFlash(pu.x, pu.y, 30 + 48 * e, 0.62 * flick);
    drawBolt(fx.bolt, flick);
  }

  // Icon switched -> flash ring + a quick edge-on flip to sell the change. Kept
  // snappy so a pickup never feels like it landed mid-switch: the server type is
  // already final the instant it flips; this only has to read as a blink.
  let flipX = 1;
  const sage = nowMs - fx.switchMs;
  if (sage < 200) {
    const st = sage / 200;
    powerupRing(x, y, 12 + st * 34, (1 - st) * 0.7, 1 + 3 * (1 - st));
    flipX = Math.abs(Math.cos(st * Math.PI));   // 1 -> 0 (edge-on) -> 1
  }

  drawPowerupSprite(pu.type, 'active', x, y, 56, 1, scale * flipX, scale);
}

// Board contents in WORLD coordinates (caller sets the world->device transform).
function drawBoardContent() {
  ctx.fillStyle = ARENA_BG;
  ctx.fillRect(0, 0, G.worldW, G.worldH);
  // paintLayer is supersampled (PAINT_SS x world res) for crisp trails on big
  // screens; scale it down to world coords here.
  if (paintLayer) ctx.drawImage(paintLayer, 0, 0, paintLayer.width, paintLayer.height, 0, 0, G.worldW, G.worldH);
  prunePowerupFx();
  for (const pu of powerups) drawPowerup(pu);
  if (pickupFades.length) {
    for (const fx of pickupFades) drawPickupFade(fx);
    pickupFades = pickupFades.filter((fx) => nowMs - fx.start < POWERUP_FADE_MS);
  }
  if (impacts.length) {
    for (const im of impacts) {
      const age = (nowMs - im.start) / 450;
      if (age >= 1) continue;
      ctx.save();
      ctx.globalAlpha = (1 - age) * 0.85;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(im.x, im.y, im.r * (0.55 + age * 1.2), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    impacts = impacts.filter((im) => nowMs - im.start < 450);
  }
  if (snapFlashes.length) {
    for (const f of snapFlashes) {
      const age = (nowMs - f.start) / SNAP_FLASH_MS;
      if (age >= 1) continue;
      // Hold opaque white briefly (hides the instant the paint clears), then fade out
      // to reveal the now-erased half.
      const a = age < 0.18 ? 1 : Math.pow(1 - (age - 0.18) / 0.82, 1.4);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(f.x, f.y, f.w, f.h);
      ctx.restore();
    }
    snapFlashes = snapFlashes.filter((f) => nowMs - f.start < SNAP_FLASH_MS);
  }
}

// Brushes, depth-sorted, drawn in WORLD coordinates.
function drawActors() {
  const actors = [];
  for (const r of remote.values()) {
    const drawSlot = Number.isFinite(r.paintSlot) ? r.paintSlot : r.slot;
    actors.push({ x: r.rx, y: r.ry, slot: drawSlot, face: r.face, dirAngle: r.dirAngle, speed: r.speed, inputActive: r.inputActive, isMe: false, boost: r.boost, frozen: r.frozen, noPaint: r.noPaint, castType: r.castType, paintScale: r.paintScale, echo: r.echo });
  }
  if (me.has && !spectating) {
    const drawSlot = Number.isFinite(me.paintSlot) ? me.paintSlot : mySlot;
    actors.push({ x: me.x, y: me.y, slot: drawSlot, face: me.face, dirAngle: me.dirAngle, speed: me.speed, inputActive: me.inputActive, isMe: true, boost: me.boost, frozen: me.frozen, noPaint: me.noPaint, castType: me.castType, paintScale: me.paintScale, echo: false });
  }
  actors.sort((a, b) => a.y - b.y);
  for (const a of actors) drawBrushSprite(a.x, a.y, a.slot, a.face, a.dirAngle, a.speed, a.isMe, a.boost, a.frozen, a.noPaint, a.castType, a.inputActive, a.paintScale, a.echo);
}

function syncCountdownBounds(x, y, w, h) {
  const el = els.countdown;
  if (!el) return;
  const key = `${Math.round(x)}:${Math.round(y)}:${Math.round(w)}:${Math.round(h)}`;
  if (el.dataset.boundsKey === key) return;
  el.dataset.boundsKey = key;
  el.style.setProperty('--cd-left', `${x.toFixed(2)}px`);
  el.style.setProperty('--cd-top', `${y.toFixed(2)}px`);
  el.style.setProperty('--cd-w', `${w.toFixed(2)}px`);
  el.style.setProperty('--cd-h', `${h.toFixed(2)}px`);
}

function render() {
  const dpr = cam.dpr;
  const barH = cam.barH || 0;
  const pvw = cam.cssW;
  const pvh = Math.max(1, cam.cssH - barH);   // everything below the top bar
  // A 16:9 board that fills the full height under the bar (CONTAIN, so it can never
  // exceed the width either). Every player sees the IDENTICAL whole arena regardless
  // of window shape -- a level playing field.
  const z = Math.min(pvw / G.worldW, pvh / G.worldH);
  cam.zoom = z;
  const bw = G.worldW * z, bh = G.worldH * z;   // board size on screen (css px)
  const ox = (pvw - bw) / 2;
  // Flush to the bar: the board fills the height below it (bar takes the remaining
  // height up top); brush tips lean over the bar. Any side slack is chrome.
  const oy = barH;
  syncCountdownBounds(ox, oy, bw, bh);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Chrome (darker than the board) fills the area under the bar so any side margin
  // reads as a framed surface rather than padding glued to the board.
  ctx.fillStyle = CHROME_BG;
  ctx.fillRect(0, Math.round(barH * dpr), canvas.width, Math.round(pvh * dpr));

  // Board content (paint, powerups, impacts) clipped to the board rect.
  ctx.save();
  ctx.beginPath();
  ctx.rect(Math.round(ox * dpr), Math.round(oy * dpr), Math.round(bw * dpr), Math.round(bh * dpr));
  ctx.clip();
  ctx.setTransform(z * dpr, 0, 0, z * dpr, ox * dpr, oy * dpr);
  drawBoardContent();
  ctx.restore();

  // Board frame/border removed (was a subtle white strokeRect + drop shadow here).

  // Brushes UNCLIPPED on top -> their tips can poke up over the bar.
  ctx.setTransform(z * dpr, 0, 0, z * dpr, ox * dpr, oy * dpr);
  drawActors();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---- HUD --------------------------------------------------------------------
function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

// Pre-round countdown overlay state + setter (re-pops on each number change).
let lastCountdownPhase = '';
let goUntil = 0;

const COUNTDOWN_CROWN_COLORS = {
  '3': { a: '#ff4d8d', b: '#ffd23f' },
  '2': { a: '#36d8ff', b: '#7c4dff' },
  '1': { a: '#ffd23f', b: '#ff4d6d' },
  'GO!': { a: '#ff4d8d', b: '#36d8ff' },
};

function renderCountdownCrown(text) {
  const colors = COUNTDOWN_CROWN_COLORS[text] || COUNTDOWN_CROWN_COLORS['3'];

  return `
    <span class="sc-beam sc-beam-a" aria-hidden="true"></span>
    <span class="sc-beam sc-beam-b" aria-hidden="true"></span>
    <span class="sc-beam sc-beam-c" aria-hidden="true"></span>
    <div class="sc-stage" data-value="${text}" style="--sc-a:${colors.a}; --sc-b:${colors.b};">
      <span class="sc-sparkle sc-sparkle-a" aria-hidden="true"></span>
      <span class="sc-sparkle sc-sparkle-b" aria-hidden="true"></span>
      <span class="sc-sparkle sc-sparkle-c" aria-hidden="true"></span>
      <span class="sc-sparkle sc-sparkle-d" aria-hidden="true"></span>
      <span class="sc-sparkle sc-sparkle-e" aria-hidden="true"></span>
      <span class="sc-ring" aria-hidden="true"></span>
      <span class="sc-swash" aria-hidden="true"></span>
      <span class="sc-digit">${text}</span>
    </div>
  `;
}

function setCountdown(text) {
  const el = els.countdown;
  if (!el) return;
  if (text) {
    if (el.dataset.v !== text) {
      el.innerHTML = renderCountdownCrown(text);
      el.dataset.v = text;
      el.classList.toggle('go', text === 'GO!');
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');   // restart the pop
    }
    el.classList.add('show');
  } else if (el.dataset.v) {
    el.classList.remove('show');
    el.dataset.v = '';
  }
}

function updateHUD() {
  const inCountdown = phase === 'countdown';
  // During the pre-round 3-2-1 the clock is frozen at the round's starting time:
  // timeLeftMs is the 3..0 countdown remainder then, not the round length, so show
  // the configured round duration instead.
  if (els.timerVal) els.timerVal.textContent = fmtTime(inCountdown ? roundMs : timeLeftMs);

  // Pre-round 3-2-1: the server freezes the field during the 'countdown' phase and
  // releases at 0. Mirror it, and flash GO! the instant it goes active.
  let cd = '';
  if (inCountdown) cd = String(Math.max(1, Math.min(3, Math.ceil(timeLeftMs / 1000))));
  else if (lastCountdownPhase === 'countdown' && phase === 'active') goUntil = nowMs + 700;
  if (!cd && goUntil) { if (nowMs < goUntil) cd = 'GO!'; else goUntil = 0; }
  setCountdown(cd);
  lastCountdownPhase = phase;
  if (els.timer) els.timer.style.visibility = '';   // clock stays up through the countdown, showing the start time

  // Electric timer states: yellow <30s, red <10s, and the breathing speeds up as
  // it approaches 0 (--eb-speed shrinks from ~2.2s down to ~0.45s).
  const secs = Math.ceil(timeLeftMs / 1000);
  const active = phase === 'active';
  els.timer.classList.toggle('warn', active && secs <= 30 && secs > 10);
  els.timer.classList.toggle('danger', active && secs <= 10);
  if (active && secs <= 30) {
    const t01 = Math.max(0, Math.min(1, secs / 30));          // 1 at 30s -> 0 at 0s
    els.timer.style.setProperty('--eb-speed', (0.45 + 1.75 * t01).toFixed(2) + 's');
  }

  // One-shot countdown ticks in the final 10 seconds (driven by the displayed
  // clock so they're smooth between the 30Hz state updates).
  if (!inMenu && active && secs >= 1 && secs <= 10) {
    if (secs !== lastTickSecond) { lastTickSecond = secs; if (GameAudio) GameAudio.tick(secs); }
  } else if (!active) {
    lastTickSecond = -1;
  }

  // Live ranking bar (throttled so the FLIP re-shuffle reads clearly).
  if (!inMenu && nowMs - lastRankAt > 350) { lastRankAt = nowMs; updateRankBar(); }
}

// Ranking bar: every active player as a chip, sorted by coverage (leader
// crowned). The list is split around the centered timer -- top half to the left
// group, bottom half to the right group. Chips persist and slide to their new
// spot when ranks change (FLIP), so the ranking visibly re-shuffles.
function updateRankBar() {
  if (!els.rankLeft || !els.rankRight) return;
  const total = G.w * G.h;
  const ranked = [];
  for (let s = 0; s < scores.length; s++) {
    const occupied = mySlot === s || [...remote.values()].some((r) => r.slot === s);
    if (scores[s] > 0 || occupied) ranked.push(s);
  }
  ranked.sort((a, b) => scores[b] - scores[a]);
  const mid = Math.ceil(ranked.length / 2);

  // FIRST: where each chip is now.
  const firstLeft = new Map();
  for (const [slot, el] of rankChips) firstLeft.set(slot, el.getBoundingClientRect().left);

  // Build/update chips in ranked order; left half -> left group, rest -> right.
  const active = new Set(ranked);
  ranked.forEach((slot, i) => {
    let el = rankChips.get(slot);
    if (!el) { el = document.createElement('div'); rankChips.set(slot, el); }
    const pct = ((scores[slot] / total) * 100).toFixed(1);
    const isMe = slot === mySlot && !spectating;
    const nm = slotNames[slot] || `P${slot + 1}`;
    const badge = i === 0
      ? '<img class="lb-crown" src="/assets/crown.png" alt="leader">'
      : `<span class="lb-rank">${i + 1}</span>`;
    el.className = 'lb-item' + (isMe ? ' me' : '');
    el.innerHTML = `${badge}<span class="swatch" style="background:${palette[slot]}"></span><span class="lb-name">${escapeHtml(nm)}</span><span class="lb-pct">${pct}%</span>`;
    (i < mid ? els.rankLeft : els.rankRight).appendChild(el);
  });
  for (const [slot, el] of [...rankChips]) {
    if (!active.has(slot)) { el.remove(); rankChips.delete(slot); }
  }

  // LAST + INVERT + PLAY: slide each chip from its old spot to the new one
  // (works across the two groups since rects are viewport-absolute).
  for (const [slot, el] of rankChips) {
    if (!firstLeft.has(slot)) continue;
    const dx = firstLeft.get(slot) - el.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5) continue;
    el.style.transition = 'none';
    el.style.transform = `translateX(${dx}px)`;
    el.getBoundingClientRect();            // force reflow so the invert applies
    el.style.transition = 'transform 0.45s ease';
    el.style.transform = '';
  }
}

function clearRankBar() {
  rankChips.clear();
  if (els.rankLeft) els.rankLeft.innerHTML = '';
  if (els.rankRight) els.rankRight.innerHTML = '';
}

function refreshOverlays() {
  if (!inMenu && phase === 'active' && spectating) show(els.spectate);
  else hide(els.spectate);
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resizeResultConfetti() {
  if (!els.resultsConfetti || !resultConfettiCtx) return;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (els.resultsConfetti.width !== w) els.resultsConfetti.width = w;
  if (els.resultsConfetti.height !== h) els.resultsConfetti.height = h;
  els.resultsConfetti.style.width = `${window.innerWidth}px`;
  els.resultsConfetti.style.height = `${window.innerHeight}px`;
  resultConfettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function stopResultConfetti() {
  if (resultConfettiRaf) cancelAnimationFrame(resultConfettiRaf);
  resultConfettiRaf = 0;
  resultConfettiParticles = [];
  if (resultConfettiCtx) resultConfettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

function makeResultConfettiParticle(i) {
  const x = Math.random() * window.innerWidth;
  const y = -18 - Math.random() * Math.min(180, window.innerHeight * 0.24);
  const paintDrop = Math.random() < 0.26;
  const size = paintDrop ? 8 + Math.random() * 12 : 6 + Math.random() * 13;
  return {
    x,
    y,
    vx: (Math.random() - 0.5) * 120,
    vy: (100 + Math.random() * 210) * RESULT_CONFETTI_SPEED,
    w: paintDrop ? size : 8 + Math.random() * 16,
    h: paintDrop ? size * (0.7 + Math.random() * 0.34) : 4 + Math.random() * 9,
    color: RESULT_CONFETTI_COLORS[Math.floor(Math.random() * RESULT_CONFETTI_COLORS.length)],
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 15,
    life: -(i / RESULT_CONFETTI_DENSITY) * 1.15,
    maxLife: 4.2 + Math.random() * 1.8,
    gravity: (RESULT_CONFETTI_GRAVITY + Math.random() * 190) * RESULT_CONFETTI_SPEED,
    drag: 0.982 + Math.random() * 0.012,
    paintDrop,
  };
}

function drawResultConfettiParticle(p) {
  resultConfettiCtx.save();
  resultConfettiCtx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife);
  resultConfettiCtx.translate(p.x, p.y);
  resultConfettiCtx.rotate(p.rot);
  resultConfettiCtx.fillStyle = p.color;
  if (p.paintDrop) {
    resultConfettiCtx.beginPath();
    resultConfettiCtx.ellipse(0, 0, p.w * 0.56, p.h * 0.46, 0, 0, Math.PI * 2);
    resultConfettiCtx.fill();
    resultConfettiCtx.beginPath();
    resultConfettiCtx.arc(p.w * 0.22, -p.h * 0.18, p.w * 0.17, 0, Math.PI * 2);
    resultConfettiCtx.fill();
  } else {
    resultConfettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
  }
  resultConfettiCtx.restore();
}

function drawResultConfetti(t) {
  const dt = Math.min(0.033, (t - resultConfettiLast) / 1000 || 0.016);
  resultConfettiLast = t;
  resultConfettiCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  resultConfettiParticles = resultConfettiParticles.filter((p) => {
    p.life += dt;
    if (p.life < 0) return true;
    p.vx *= p.drag;
    p.vy = p.vy * p.drag + p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    drawResultConfettiParticle(p);
    return p.life < p.maxLife && p.y < window.innerHeight + 80;
  });
  if (resultConfettiParticles.length) {
    resultConfettiRaf = requestAnimationFrame(drawResultConfetti);
  } else {
    stopResultConfetti();
  }
}

function startResultConfetti() {
  if (!els.resultsCard || !resultConfettiCtx || prefersReducedMotion()) return;
  stopResultConfetti();
  resizeResultConfetti();
  resultConfettiParticles = Array.from({ length: RESULT_CONFETTI_DENSITY }, (_, i) => makeResultConfettiParticle(i));
  resultConfettiLast = performance.now();
  resultConfettiRaf = requestAnimationFrame(drawResultConfetti);
}

function showResults(msg, won) {
  hide(els.spectate);
  stopResultConfetti();
  const total = G.w * G.h;
  if (msg.tie) {
    els.resultTitle.textContent = 'TIE!';
    els.results.dataset.outcome = 'tie';
  } else if (msg.winnerSlot === mySlot && !spectating) {
    els.resultTitle.textContent = 'YOU WIN!';
    els.results.dataset.outcome = 'winner';
  } else if (msg.winnerSlot >= 0) {
    // textContent (not innerHTML) -> winner name needs no escaping here.
    els.resultTitle.textContent = `${msg.winnerName || ('P' + (msg.winnerSlot + 1))} WINS`;
    els.results.dataset.outcome = 'loser';
  } else {
    els.resultTitle.textContent = 'ROUND OVER';
    els.results.dataset.outcome = 'neutral';
  }
  if (els.resultKicker) els.resultKicker.textContent = msg.roundId != null ? `Round ${msg.roundId}` : 'Round over';

  const rows = msg.scores
    .map((score, slot) => ({ slot, score }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const topScore = rows.length ? rows[0].score : 0;
  els.resultList.innerHTML = rows.map((r) => {
    const pctValue = total ? (r.score / total) * 100 : 0;
    const pct = pctValue.toFixed(1);
    const relativePct = topScore ? (r.score / topScore) * 100 : 0;
    const barPct = Math.max(8, Math.min(100, relativePct));
    const meCls = r.slot === mySlot && !spectating ? ' me' : '';
    const name = slotNames[r.slot] || `P${r.slot + 1}`;
    return `<div class="result-row${meCls}" style="--bar-color:${palette[r.slot]};--pct:${barPct}%">
      <span class="swatch" style="background:${palette[r.slot]}"></span>
      <span class="score-name">${escapeHtml(name)}</span>
      <span class="result-bar" aria-hidden="true"><span></span></span>
      <span class="score-pct">${pct}%</span>
    </div>`;
  }).join('') || '<div class="result-empty">Nobody painted anything!</div>';

  show(els.results);
  if (won) startResultConfetti();

  // Local countdown for the intermission.
  let left = Math.ceil((msg.intermissionMs || 6000) / 1000);
  els.nextCountdown.textContent = left;
  clearInterval(showResults._iv);
  showResults._iv = setInterval(() => {
    left--;
    els.nextCountdown.textContent = Math.max(0, left);
    if (left <= 0) clearInterval(showResults._iv);
  }, 1000);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ---- Loop -------------------------------------------------------------------
let lastFrame = performance.now();
// A frame gap this large means the loop was paused (hidden/minimized/slept tab) or
// badly stalled -- past it, strokeSeg's 90px teleport guard (~390ms at top speed)
// would drop the catch-up stroke, so the missed window is gone. Detecting the gap
// directly catches every stall cause uniformly without relying on visibility events.
const RESYNC_STALL_MS = 300;
function frame(t) {
  const gap = t - lastFrame;
  const dt = Math.min(0.05, gap / 1000);
  lastFrame = t;
  nowMs = t;
  // In a match: the full netcode pipeline. On the landing: the local
  // single-brush tutorial sim instead (no network, same renderer).
  if (!inMenu) {
    if (gap > RESYNC_STALL_MS) requestResync();   // loop resumed after a stall -> catch up paint
    predict(dt);
    interpolateRemotes();
    paintTrails();      // accumulate smooth paint onto the persistent layer
    render();
    updateHUD();
    if (GameAudio) {
      const lvl = (me.has && !spectating && phase === 'active') ? me.speed / MAX_SPEED : 0;
      GameAudio.movement(lvl);
    }
  } else if (SIM.started) {
    simTick(dt, t);
    paintTrails();
    render();
    simUpdateHUD(t);
    if (GameAudio) GameAudio.movement(me.speed / MAX_SPEED);
  }
  requestAnimationFrame(frame);
}

// ---- Layout: full-viewport canvas overlay; play area rendered below the bar ---
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vw = window.innerWidth, vh = window.innerHeight;
  cam.dpr = dpr;
  cam.cssW = vw;
  cam.cssH = vh;
  cam.barH = els.topbar ? els.topbar.offsetHeight : 0;   // 0 when hidden on the menu

  canvas.style.width = `${vw}px`;
  canvas.style.height = `${vh}px`;
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  resizeResultConfetti();
}
window.addEventListener('resize', resize);

// ---- Utils ------------------------------------------------------------------
function hexToRGB(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- Menu / scene + audio + stats UI ---------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatStatValue(value, decimals) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return decimals ? safe.toFixed(decimals) : String(Math.round(safe));
}

function renderStats(opts = {}) {
  if (!els.stats) return;
  const s = Store ? Store.getStats() : null;
  const hasStats = !!s && (s.matches > 0 || s.wins > 0 || s.bestCoverage > 0 || s.winStreak > 0);
  if (!hasStats) { els.stats.innerHTML = ''; return; }
  const cells = [
    { label: 'Wins', value: s.wins, decimals: 0 },
    { label: 'Streak', value: s.winStreak, decimals: 0 },
  ];
  const animate = !!opts.animate;
  if (statsAnimationFrame) {
    cancelAnimationFrame(statsAnimationFrame);
    statsAnimationFrame = 0;
  }
  els.stats.innerHTML = cells.map((c) =>
    `<div class="stat" aria-label="${escapeHtml(c.label)}: ${escapeHtml(formatStatValue(c.value, c.decimals))}">
      <div class="stat-value tabular-nums" data-value="${c.value}" data-decimals="${c.decimals}">${animate ? formatStatValue(0, c.decimals) : escapeHtml(formatStatValue(c.value, c.decimals))}</div>
      <div class="stat-label">${escapeHtml(c.label)}</div>
    </div>`
  ).join('');
  if (!animate) return;
  const vals = [...els.stats.querySelectorAll('.stat-value')];
  const start = performance.now();
  const duration = 720;
  const tick = (t) => {
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    vals.forEach((el) => {
      const target = Number(el.dataset.value) || 0;
      const decimals = Number(el.dataset.decimals) || 0;
      el.textContent = formatStatValue(target * eased, decimals);
    });
    if (p < 1) statsAnimationFrame = requestAnimationFrame(tick);
    else statsAnimationFrame = 0;
  };
  statsAnimationFrame = requestAnimationFrame(tick);
}

function syncSoundUI() {
  const a = Store ? Store.getAudio() : { muted: false, volume: 0.7, musicVol: 1, sfxVol: 1, brushVol: 1 };
  const vol = GameAudio ? GameAudio.getVolume() : a.volume;
  const musicVol = GameAudio ? GameAudio.getMusicVolume() : a.musicVol;
  const sfxVol = GameAudio ? GameAudio.getSfxVolume() : a.sfxVol;
  const brushVol = GameAudio ? GameAudio.getBrushVolume() : a.brushVol;
  if (els.volSlider) els.volSlider.value = String(Math.round(vol * 100));
  if (els.musicSlider) els.musicSlider.value = String(Math.round(musicVol * 100));
  if (els.sfxSlider) els.sfxSlider.value = String(Math.round(sfxVol * 100));
  if (els.brushSlider) els.brushSlider.value = String(Math.round(brushVol * 100));
}

function setVolume(pct) {
  const v = Math.max(0, Math.min(1, pct / 100));
  if (GameAudio) { GameAudio.unlock(); GameAudio.setVolume(v); if (v > 0 && GameAudio.isMuted()) GameAudio.setMuted(false); }
  if (Store) Store.setAudio({ volume: v, ...(v > 0 ? { muted: false } : {}) });
  syncSoundUI();
}

function setMusicVolume(pct) {
  const v = Math.max(0, Math.min(1, pct / 100));
  if (GameAudio) { GameAudio.unlock(); GameAudio.setMusicVolume(v); }
  if (Store) Store.setAudio({ musicVol: v });
  syncSoundUI();
}

function setSfxVolume(pct) {
  const v = Math.max(0, Math.min(1, pct / 100));
  if (GameAudio) { GameAudio.unlock(); GameAudio.setSfxVolume(v); }
  if (Store) Store.setAudio({ sfxVol: v });
  syncSoundUI();
}

function setBrushVolume(pct) {
  const v = Math.max(0, Math.min(1, pct / 100));
  if (GameAudio) { GameAudio.unlock(); GameAudio.setBrushVolume(v); }
  if (Store) Store.setAudio({ brushVol: v });
  syncSoundUI();
}

function toggleSettings(force) {
  if (!els.settingsMenu || !els.settingsBtn) return;
  const open = force != null ? force : els.settingsMenu.classList.contains('hidden');
  els.settingsMenu.classList.toggle('hidden', !open);
  els.settingsBtn.setAttribute('aria-expanded', String(open));
}

// Power-up legend popover (avatar-stack button at the landing's top right).
function toggleLegend(force) {
  if (!els.legendMenu || !els.legendBtn) return;
  const open = force != null ? force : els.legendMenu.classList.contains('hidden');
  els.legendMenu.classList.toggle('hidden', !open);
  els.legendBtn.setAttribute('aria-expanded', String(open));
}

// The top bar now lives in BOTH scenes (the landing sim feeds it too); the
// toggle remains since showing/hiding it changes the playfield -> re-size.
function setBarVisible(v) {
  if (els.topbar) els.topbar.style.display = v ? '' : 'none';
  if (!v && els.settingsMenu) els.settingsMenu.classList.add('hidden');
  resize();
}

// The landing-only bottom nav and the menu-anchored quick overlay are driven by a
// single body class: `body.in-menu` shows the nav and re-anchors the settings panel
// above it (see style.css). In-match the class is off, so neither shows on the menu.
function setNavVisible(v) {
  document.body.classList.toggle('in-menu', v);
  if (!v && els.settingsMenu) els.settingsMenu.classList.add('hidden');
  if (!v) toggleLegend(false);   // don't leave the legend open for the next visit
}

function initMenu() {
  inMenu = true;
  myId = null;          // the landing sim is purely local; no server identity
  if (Store && els.nameInput) {
    const saved = Store.getName();
    if (saved) els.nameInput.value = saved;
  }
  renderStats({ animate: !statsIntroPlayed });
  statsIntroPlayed = true;
  syncSoundUI();
  // The top bar stays up on the landing: the tutorial sim feeds it live ranks
  // and a looping 2:00 clock (see simUpdateHUD).
  setBarVisible(true);
  setNavVisible(true);
  hide(els.spectate);
  clearChat();
  stopResultConfetti();
  hide(els.results);
  setCountdown('');                          // clear any leftover countdown overlay
  lastCountdownPhase = ''; goUntil = 0;
  // No name-field autofocus: on the landing, WASD/arrows belong to the tutorial
  // brush (click the field to type). Music plays here too -- the landing is a
  // real round, so it gets the real mix (it starts on the first WASD gesture).
  if (GameAudio) GameAudio.setMusicEnabled(true);
  simStart();
}

function startPlay() {
  // Slice by code point (not UTF-16 unit) so an emoji at the 16-char boundary
  // isn't split into a lone surrogate -- that would throw in encodeURIComponent
  // when we build the connect URL. The server re-sanitizes regardless.
  myName = [...(els.nameInput ? els.nameInput.value : '').trim()].slice(0, 10).join('');   // keep in sync with config MAX_NAME_LEN
  if (Store) Store.setName(myName);
  simStop();            // hand the shared world state back to the match pipeline
  inMenu = false;
  if (GameAudio) { GameAudio.unlock(); syncSoundUI(); }   // unlock within the click gesture (music already on)
  setBarVisible(true);
  setNavVisible(false);
  clearChat();
  syncChatUI();
  chatWake();           // show the chat hint briefly, then it fades
  connect();            // open the connection only now
}

function leaveToMenu() {
  disconnect();         // drop the match and return to the landing
  if (GameAudio) GameAudio.movement(0);
  initMenu();
}

if (els.startForm) els.startForm.addEventListener('submit', (e) => { e.preventDefault(); startPlay(); });
if (els.resultsMenuBtn) els.resultsMenuBtn.addEventListener('click', leaveToMenu);

// Settings dropdown (gear at the bar's left edge). Opening either popover
// closes the other so the two never stack on screen together.
if (els.settingsBtn) els.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLegend(false); toggleSettings(); });
if (els.navSettings) els.navSettings.addEventListener('click', (e) => { e.stopPropagation(); toggleLegend(false); toggleSettings(); });
if (els.volSlider) els.volSlider.addEventListener('input', () => setVolume(Number(els.volSlider.value)));
if (els.musicSlider) els.musicSlider.addEventListener('input', () => setMusicVolume(Number(els.musicSlider.value)));
if (els.sfxSlider) els.sfxSlider.addEventListener('input', () => setSfxVolume(Number(els.sfxSlider.value)));
if (els.brushSlider) els.brushSlider.addEventListener('input', () => setBrushVolume(Number(els.brushSlider.value)));
if (els.chatToggle) els.chatToggle.addEventListener('change', () => {
  if (Store) Store.setPrefs({ chat: els.chatToggle.checked });
  syncChatUI();
});
syncChatUI();

// Landing tutorial-sim player count: the gear dropdown's left/right stepper (you + 1..5
// bots, total 2..6). Persists immediately; takes effect at the NEXT sim round (the rebuild
// happens in simNextRound) -- a real match is always server-filled, so this is landing-only.
function syncPlayersUI() {
  const n = Store ? Store.getSim().players : 6;
  if (els.playersVal) els.playersVal.textContent = String(n);
  if (els.playersDec) els.playersDec.disabled = n <= 2;
  if (els.playersInc) els.playersInc.disabled = n >= 6;
}
function stepSimPlayers(d) {
  if (!Store) return;
  const cur = Math.max(2, Math.min(6, (Store.getSim().players | 0) || 6));
  const next = Math.max(2, Math.min(6, cur + d));
  if (next === cur) return;
  Store.setSim({ players: next });
  syncPlayersUI();
  // Not started yet (still idling under the "you" arrow)? Apply it right now. Once the
  // round is live it waits for the next round (non-disruptive mid-game).
  if (typeof SIM === 'object' && SIM.started && SIM.stage === 'waiting') simRebuildBots();
}
if (els.playersDec) els.playersDec.addEventListener('click', () => stepSimPlayers(-1));
if (els.playersInc) els.playersInc.addEventListener('click', () => stepSimPlayers(1));
syncPlayersUI();
if (els.settingsMenu) els.settingsMenu.addEventListener('click', (e) => e.stopPropagation());

// Power-up legend popover (landing top right).
if (els.legendBtn) els.legendBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(false); toggleLegend(); });
if (els.legendMenu) els.legendMenu.addEventListener('click', (e) => e.stopPropagation());

document.addEventListener('click', () => { toggleSettings(false); toggleLegend(false); });   // click outside closes them

// ---- Landing tutorial sim ----------------------------------------------------
// A purely client-side sandbox that runs only on the landing (inMenu). The
// scene waits under the "you" arrow (match countdown semantics) until the
// visitor presses WASD/arrows -- that first input begins the game. Three
// sparring bots run the REAL bot AI (SimBotAI) against a headless score grid:
// they sweep territory, race you to pickups, and dodge bad icons like a match
// field. Lessons run LINEARLY: one pickup on the board, its effect runs out,
// then the next portal opens. It reuses the match renderer/state wholesale;
// simStop() hands everything back clean before a match connects, so server
// authority is never in play here.
//
// Numbers are client copies of src/server/config.js so the lesson moves and
// times exactly like the real game -- keep them in sync.
const SIM_PALETTE = ['#ff4d6d', '#4dd2ff', '#ffd23f', '#7c4dff', '#3ddc84', '#ff8c42'];   // = server PALETTE
const SIM_POWERUP_R = 28;            // pickup radius (POWERUP_R)
const SIM_PU_TTL_MS = 6000;          // armed lifetime (POWERUP_TTL_MS)
// Linear lesson pacing: exactly ONE pickup on the board at a time, and after a
// grab the next portal waits until the collected effect has fully run its
// course -- every lesson gets the stage to itself.
const SIM_FIRST_SPAWN_MS = 1400;     // first portal after the visitor starts moving
const SIM_SPAWN_GAP_MS = 900;        // breath between an effect ending and the next portal
const SIM_SPAWN_JITTER_MS = 2200;    // random extra breath -- with pads fixed, WHEN is the surprise
const SIM_RESPAWN_GAP_MS = 1500;     // pause after an unclaimed pickup expires
const SIM_EFFECT_MS = {              // per-type effect windows (server *_MS)
  speed: 4000, slow: 4000, freeze: 3500, inkjam: 3500, erase: 5000,
  selfFreeze: 3000, selfInkjam: 3000, mega: 4000, tiny: 5000, echo: 5500, missile: 4000, mortar: 4000,
};
// How long a collected lesson holds the stage before the next portal may open.
// Timed effects own their full window; the instant ones get a readability beat.
function simLessonMs(type) {
  if (type === 'snap') return 1600;        // flash + reveal
  if (type === 'badMissile') return 2000;  // the burst around you settles
  return SIM_EFFECT_MS[type] || 2000;
}
const SIM_MEGA_MULT = 1.55;          // MEGA_BRUSH_MULT
const SIM_TINY_MULT = 0.55;          // TINY_BRUSH_MULT
const SIM_MISSILE_COUNT = 12;
const SIM_MISSILE_DELAY_MS = 200;
const SIM_MISSILE_INTERVAL_MS = Math.floor((SIM_EFFECT_MS.missile - SIM_MISSILE_DELAY_MS) / (SIM_MISSILE_COUNT - 1));
const SIM_CRATER_R = 36;
const SIM_MORTAR_CRATER_R = 46;      // "mortar" erasing shower -> bigger craters than a paint missile
// The twist: flip odds + timing, straight from POWERUP_SWITCH_CHANCES /
// makePowerupSwitches. A flip is now a 50/50 boon-or-hazard coin toss (mirror of
// pickFlipType); fresh SPAWNS instead use a shuffle bag over all types so a visitor
// sees everything without repeats.
const SIM_SWITCH_CHANCES = [
  { changes: 0, weight: 0.15 },
  { changes: 1, weight: 0.39 },
  { changes: 2, weight: 0.32 },
  { changes: 3, weight: 0.14 },
];
const SIM_FLIP_BOONS = ['speed', 'freeze', 'inkjam', 'missile', 'mega', 'echo', 'erase'];
const SIM_FLIP_HAZARDS = ['slow', 'selfFreeze', 'selfInkjam', 'badMissile', 'tiny'];
const SIM_TOAST_MS = 3400;           // pickup toast linger
const SIM_ROUND_MS = 120000;         // full rounds on the real length (ROUND_MS)
const SIM_INTERMISSION_MS = 10000;   // results linger inline (INTERMISSION_MS)
const SIM_COUNTDOWN_MS = 3000;       // pre-round freeze before the next GO (COUNTDOWN_MS)
const SIM_ECHO_ID = 'sim-echo';      // synthetic actor/remote key for the ghost twin
const SIM_BOT_IDS = ['sim-bot-a', 'sim-bot-b', 'sim-bot-c', 'sim-bot-d', 'sim-bot-e'];   // up to 5 sparring bots
// Landing bots run the REAL bot AI (see SimBotAI below). A fierce-leaning spread of
// personalities is forced (instead of the server's weighted draw), shuffled per round;
// the first N (for the chosen player count) are used.
const SIM_BOT_KINDS = ['aggressive', 'balanced', 'casual', 'aggressive', 'balanced'];
// Rank-bar handles for the bots (a slice of the server's NAME_POOL flavor).
const SIM_BOT_NAMES = [
  'Riley', 'Nova', 'Pip', 'Zane', 'Cleo', 'Finn', 'Wraith', 'NoScope',
  'Skibidi', 'Goku', 'Latvia', 'PixelPusher',
];

// Names/descriptions match the legend popover in index.html -- keep in sync.
// `note` can add a sim-only sub-line under a toast when one needs context.
const SIM_PU_INFO = {
  speed:      { name: 'Speed', desc: 'Double speed.', bad: false },
  freeze:     { name: 'Freeze', desc: 'Roots every rival in place.', bad: false },
  inkjam:     { name: 'Ink Jam', desc: 'Rivals’ paint stops flowing.', bad: false },
  missile:    { name: 'Missiles', desc: 'Rains 12 splats of your color.', bad: false },
  mega:       { name: 'Mega Brush', desc: 'Paints a far wider trail.', bad: false },
  echo:       { name: 'Echo', desc: 'A ghost twin mirrors your moves.', bad: false },
  erase:      { name: 'Erase', desc: 'Rivals erase instead of paint.', bad: false },
  mortar:     { name: 'Mortar', desc: 'Rains strikes that erase paint.', bad: true },   // a gamble that can wipe YOUR paint -> hazard-coded (like snap)
  snap:       { name: 'Snap', desc: 'Wipes a random half.', bad: true },   // a gamble that can nuke YOUR paint -> hazard-coded
  slow:       { name: 'Slow', desc: 'You crawl at half speed.', bad: true },
  selfFreeze: { name: 'Self-Freeze', desc: 'Freezes you instead.', bad: true },
  selfInkjam: { name: 'Self Ink Jam', desc: 'Your own paint cuts out.', bad: true },
  badMissile: { name: 'Backfire', desc: 'Rival-colored splats burst from you.', bad: true },
  tiny:       { name: 'Tiny Brush', desc: 'Slim trail, slightly faster.', bad: true },
};
const SIM_TYPES = Object.keys(SIM_PU_INFO);

// ---- sim score grid (mirror of the Room's grid/scores/coarse zones) ---------
// The real bot AI perceives the world through the room's paint grid: scores for
// rubber-banding, coarse zones for territory targets, fine cells for the local
// paint-field. The sim keeps the same authoritative-style grid (invisible
// bookkeeping; visuals stay on the paint layer) so the AI port runs unmodified.
const SIM_MAX_PLAYERS = 6;           // MAX_PLAYERS
const SIM_EMPTY = 255;               // EMPTY
const SIM_BOT_COARSE_MS = 400;       // BOT_COARSE_MS
const SIM_STAMP_STEP = BRUSH_R / 2;  // STAMP_STEP

function simPaintCellG(cx, cy, slot) {
  if (cx < 0 || cy < 0 || cx >= G.w || cy >= G.h) return;
  const idx = cy * G.w + cx;
  const prev = SIM.room.grid[idx];
  if (prev === slot) return;
  if (prev !== SIM_EMPTY) SIM.room.scores[prev]--;
  SIM.room.scores[slot]++;
  SIM.room.grid[idx] = slot;
}

function simClearCellG(cx, cy) {
  if (cx < 0 || cy < 0 || cx >= G.w || cy >= G.h) return;
  const idx = cy * G.w + cx;
  const prev = SIM.room.grid[idx];
  if (prev === SIM_EMPTY) return;
  SIM.room.scores[prev]--;
  SIM.room.grid[idx] = SIM_EMPTY;
}

function simFillDiscG(wx, wy, rPx, slot) {
  const ccx = wx / G.cell;
  const ccy = wy / G.cell;
  const rc = rPx / G.cell;
  const r2 = rc * rc;
  const minX = Math.floor(ccx - rc);
  const maxX = Math.ceil(ccx + rc);
  const minY = Math.floor(ccy - rc);
  const maxY = Math.ceil(ccy + rc);
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const dx = cx + 0.5 - ccx;
      const dy = cy + 0.5 - ccy;
      if (dx * dx + dy * dy <= r2) simPaintCellG(cx, cy, slot);
    }
  }
}

function simClearDiscG(wx, wy, rPx) {
  const ccx = wx / G.cell;
  const ccy = wy / G.cell;
  const rc = rPx / G.cell;
  const r2 = rc * rc;
  const minX = Math.floor(ccx - rc);
  const maxX = Math.ceil(ccx + rc);
  const minY = Math.floor(ccy - rc);
  const maxY = Math.ceil(ccy + rc);
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const dx = cx + 0.5 - ccx;
      const dy = cy + 0.5 - ccy;
      if (dx * dx + dy * dy <= r2) simClearCellG(cx, cy);
    }
  }
}

function simPaintPathG(px, py, cx, cy, slot, rPx) {
  const dx = cx - px;
  const dy = cy - py;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / Math.max(4, rPx / 2, SIM_STAMP_STEP)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    simFillDiscG(px + dx * t, py + dy * t, rPx, slot);
  }
}

function simErasePathG(px, py, cx, cy, rPx) {
  const dx = cx - px;
  const dy = cy - py;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / Math.max(4, rPx / 2, SIM_STAMP_STEP)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    simClearDiscG(px + dx * t, py + dy * t, rPx);
  }
}

function simFillSplatterG(blobs, slot) {
  for (const b of blobs) simFillDiscG(b.x, b.y, b.r, slot);
}

function simClearSplatterG(blobs) {
  for (const b of blobs) simClearDiscG(b.x, b.y, b.r);
}

// Mirror of Room.recomputeCoarse(): summarize the grid into 12x8 zones.
function simRecomputeCoarse() {
  const room = SIM.room;
  const ZW = 12, ZH = 8;   // COARSE_ZW / COARSE_ZH
  const nz = ZW * ZH;
  if (!room.coarseBlank) {
    room.coarseBlank = new Int16Array(nz);
    room.coarseOwn = new Int16Array(nz * SIM_MAX_PLAYERS);
  } else {
    room.coarseBlank.fill(0);
    room.coarseOwn.fill(0);
  }
  const zcw = G.w / ZW, zch = G.h / ZH;
  const grid = room.grid;
  for (let cy = 0; cy < G.h; cy++) {
    const zRow = Math.min(ZH - 1, (cy / zch) | 0) * ZW;
    const base = cy * G.w;
    for (let cx = 0; cx < G.w; cx++) {
      const v = grid[base + cx];
      const z = zRow + Math.min(ZW - 1, (cx / zcw) | 0);
      if (v === SIM_EMPTY) room.coarseBlank[z]++;
      else room.coarseOwn[z * SIM_MAX_PLAYERS + v]++;
    }
  }
}

// ---- SimBotAI: client copy of src/server/bot-ai.js -------------------------
// The landing bots ARE the game's bots: this is the server module minus the
// name pool / exports, with its config requires inlined as literals. Internal
// names are preserved verbatim so the two files stay trivially diffable --
// KEEP IN SYNC with src/server/bot-ai.js when the AI changes. It operates on
// the sim's room adapter (grid/scores/coarse/players/powerups) built above.
const SimBotAI = (() => {
  const GRID_W = 128, GRID_H = 72, CELL = 10, EMPTY = 255;     // server config literals
  const WORLD_W = 1280, WORLD_H = 720, MAX_PLAYERS = 6;
  const BOT_NOTICE_R = 1400;
  const COARSE_ZW = 12, COARSE_ZH = 8;
  const POWERUP_TTL_MS = 6000, POWERUP_R = 28;
  // BRUSH_R / MAX_SPEED come from the shared client config (same values).

  const TWO_PI = Math.PI * 2;
  const TOTAL_CELLS = GRID_W * GRID_H;
  const ZONE_CELLS = (GRID_W / COARSE_ZW) * (GRID_H / COARSE_ZH);
  const ZONE_W_PX = WORLD_W / COARSE_ZW;
  const ZONE_H_PX = WORLD_H / COARSE_ZH;

  const BAD_PU_GAMBLE_BASE = 0.032;
  const BAD_PU_GAMBLE_EXTRA = 0.062;
  const BAD_PU_GAMBLE_GREED_BASE = 0.020;
  const BAD_PU_GAMBLE_GREED_EXTRA = 0.032;
  const BAD_PU_GAMBLE_CAP = 0.34;
  const BAD_PU_FLIP_BET = 0.06;
  const FLIP_BOON_PROB = 0.5;        // flips are a 50/50 boon/hazard coin toss now (config FLIP_*)
  const FLIP_BET_REF_PROB = 0.7;     // odds the flip-bet was tuned against (old weighted pool)
  const DISRUPT_IDLE_BASE = 0.012;
  const REVENGE_SPARK_BASE = 0.018;
  const REVENGE_SPARK_VENGEANCE = 0.15;
  const REVENGE_SPARK_BEHIND = 0.06;
  const REVENGE_SPARK_LEADER_BONUS = 0.025;
  const REVENGE_SPARK_LEADING_PENALTY = 0.12;
  const REVENGE_SPARK_CAP = 0.26;
  const ERASER_HUNT_BASE = 0.24;
  const ERASER_HUNT_VENGEANCE = 0.30;
  const ERASER_HUNT_BEHIND = 0.08;
  const ERASER_HUNT_CAP = 0.62;
  const INKJAM_SHADOW_BASE = 0.20;
  const INKJAM_SHADOW_VENGEANCE = 0.24;
  const INKJAM_SHADOW_BEHIND = 0.06;
  const INKJAM_SHADOW_CAP = 0.52;
  const DISRUPT_HUNT_RETARGET_MIN_MS = 150;
  const DISRUPT_HUNT_RETARGET_MAX_MS = 250;
  const DISRUPT_SHADOW_RETARGET_MIN_MS = 320;
  const DISRUPT_SHADOW_RETARGET_MAX_MS = 520;
  const DISRUPT_TURF_RETARGET_SCALE = 0.65;
  const DISRUPT_OBJECTIVE_RETARGET_SCALE = 0.75;
  const TELEGRAPH_MISS_BASE = 0.55;

  const BAD_POWERUPS = new Set(['slow', 'selfFreeze', 'selfInkjam', 'badMissile', 'tiny']);

  const PERSONALITIES = {
    aggressive: {
      reactMs: [80, 150], aimError: 0.06, turnRate: 7.5,
      thinkProb: 0.02, thinkMs: [100, 250], retargetMs: [450, 800],
      greed: 0.85, contest: 0.6, vengeance: 0.70, wanderAmp: 0.04, wanderFreq: 1.4,
    },
    balanced: {
      reactMs: [120, 220], aimError: 0.12, turnRate: 5.6,
      thinkProb: 0.06, thinkMs: [180, 380], retargetMs: [600, 1100],
      greed: 0.6, contest: 0.4, vengeance: 0.42, wanderAmp: 0.07, wanderFreq: 1.1,
    },
    casual: {
      reactMs: [200, 330], aimError: 0.20, turnRate: 4.1,
      thinkProb: 0.12, thinkMs: [260, 560], retargetMs: [1000, 1700],
      greed: 0.42, contest: 0.22, vengeance: 0.24, wanderAmp: 0.12, wanderFreq: 0.95,
    },
    wanderer: {
      reactMs: [180, 300], aimError: 0.30, turnRate: 3.4,
      thinkProb: 0.18, thinkMs: [280, 650], retargetMs: [1300, 2200],
      greed: 0.30, contest: 0.12, vengeance: 0.12, wanderAmp: 0.18, wanderFreq: 0.8,
    },
  };
  const PERSONALITY_WEIGHTS = [
    ['aggressive', 0.40],
    ['balanced', 0.40],
    ['casual', 0.15],
    ['wanderer', 0.05],
  ];

  function rand(min, max) { return min + Math.random() * (max - min); }
  function gauss() {
    return ((Math.random() - 0.5) + (Math.random() - 0.5) + (Math.random() - 0.5)) * 2;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function stepAngle(cur, target, maxStep) {
    let diff = target - cur;
    while (diff > Math.PI) diff -= TWO_PI;
    while (diff < -Math.PI) diff += TWO_PI;
    if (Math.abs(diff) <= maxStep) return target;
    return cur + Math.sign(diff) * maxStep;
  }

  function pickPersonalityName() {
    let r = Math.random();
    for (const [name, w] of PERSONALITY_WEIGHTS) {
      if (r < w) return name;
      r -= w;
    }
    return 'balanced';
  }

  // forceKind is a sim-only extension (the server always draws weighted).
  function createBotAI(forceKind) {
    const kind = forceKind || pickPersonalityName();
    const t = PERSONALITIES[kind];
    return {
      kind,
      reactMs: t.reactMs.slice(),
      aimError: t.aimError,
      turnRate: t.turnRate,
      thinkProb: t.thinkProb,
      thinkMs: t.thinkMs.slice(),
      retargetMs: t.retargetMs.slice(),
      greed: t.greed,
      contest: t.contest,
      vengeance: clamp(t.vengeance + gauss() * 0.14, 0, 1),
      wanderAmp: t.wanderAmp,
      wanderFreq: t.wanderFreq,
      noticeR: BOT_NOTICE_R * (0.7 + 0.6 * t.greed),
      aimAngle: rand(0, TWO_PI),
      aimBias: gauss() * t.aimError,
      wanderPhase: rand(0, TWO_PI),
      targetX: undefined,
      targetY: undefined,
      retargetAt: 0,
      thinkUntil: 0,
      puId: null,
      puChase: false,
      puReactAt: 0,
      puReCheckAt: 0,
      puReadType: null,
      puJudgeAt: 0,
      puVerdict: 'go',
      disruptSeen: 0,
      disruptIdle: false,
      disruptMode: 'objective',
      disruptTargetId: 0,
      disruptTargetSlot: -1,
      disruptRetargetAt: 0,
    };
  }

  function rubberBand(room, p) {
    let leader = 0;
    for (let s = 0; s < MAX_PLAYERS; s++) if (room.scores[s] > leader) leader = room.scores[s];
    const mine = room.scores[p.slot] || 0;
    return clamp((leader - mine) / (0.12 * TOTAL_CELLS), -1, 1);
  }

  function leaderSlotOf(room) {
    let slot = -1, best = 0;
    for (let s = 0; s < MAX_PLAYERS; s++) if (room.scores[s] > best) { best = room.scores[s]; slot = s; }
    return slot;
  }

  function topEnemySlotOf(room, p) {
    let slot = -1, best = 0;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (s === p.slot) continue;
      if (room.scores[s] > best) { best = room.scores[s]; slot = s; }
    }
    return slot;
  }

  function botIsLeading(room, p) {
    const mine = room.scores[p.slot] || 0;
    let topRival = 0;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (s === p.slot) continue;
      if (room.scores[s] > topRival) topRival = room.scores[s];
    }
    return mine > topRival + 150;
  }

  function nearestPowerup(room, p, noticeR) {
    let best = null;
    let bestD = noticeR;
    for (const pu of room.powerups) {
      const d = Math.hypot(pu.x - p.x, pu.y - p.y);
      if (d < bestD) { bestD = d; best = pu; }
    }
    return best;
  }

  function isNormalPainter(o, t) {
    return t >= o.noPaintUntil && t >= o.erasingUntil && t >= o.frozenUntil;
  }

  function closestActorForSlot(room, p, slot, t, normalOnly = false) {
    if (slot < 0) return null;
    let best = null;
    let bestD2 = Infinity;
    for (const o of room.players.values()) {
      if (o.slot !== slot || o.slot === p.slot || o.slot < 0) continue;
      if (normalOnly && !isNormalPainter(o, t)) continue;
      const dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = o; }
    }
    return best;
  }

  function soleEnemyNormalPainter(room, p, t) {
    const bySlot = new Map();
    for (const o of room.players.values()) {
      if (o.slot < 0 || o.slot === p.slot || !isNormalPainter(o, t)) continue;
      const cur = bySlot.get(o.slot);
      const dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (!cur || d2 < cur.d2) bySlot.set(o.slot, { p: o, d2 });
    }
    if (bySlot.size !== 1) return null;
    return bySlot.values().next().value.p;
  }

  function activeCaster(room, p, t, castType) {
    let best = null;
    let bestD2 = Infinity;
    for (const o of room.players.values()) {
      if (o.slot < 0 || o.slot === p.slot || o.castType !== castType || t >= o.castUntil) continue;
      const dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = o; }
    }
    return best;
  }

  function disruptionAggressor(room, p, t, kind) {
    const sole = soleEnemyNormalPainter(room, p, t);
    if (sole) return sole;
    const caster = activeCaster(room, p, t, kind === 'erase' ? 'erase' : 'inkjam');
    if (caster) return caster;
    return closestActorForSlot(room, p, topEnemySlotOf(room, p), t);
  }

  function badGrabChance(pu, ai, dist, t) {
    const seen = pu.switchIndex || 0;
    const extra = Math.max(0, seen - 1);
    const greed = ai ? ai.greed : 0;
    let chance =
      BAD_PU_GAMBLE_BASE
        + BAD_PU_GAMBLE_EXTRA * extra
        + greed * (BAD_PU_GAMBLE_GREED_BASE + BAD_PU_GAMBLE_GREED_EXTRA * extra);
    if (seen === 0 && ai) {
      const far = Math.min(1, dist / ai.noticeR);
      const aliveMs = POWERUP_TTL_MS - (pu.expiresAt - t);
      const overdue = Math.min(1, aliveMs / (POWERUP_TTL_MS * 0.55));
      // Scaled by the new 50/50 flip odds (see config FLIP_*): a rescue flip is far less
      // likely than when this was tuned, so the bet on a currently-bad icon is worth less.
      chance += BAD_PU_FLIP_BET * (0.35 + 0.65 * Math.max(far, overdue)) * (FLIP_BOON_PROB / FLIP_BET_REF_PROB);
    }
    return Math.min(chance, BAD_PU_GAMBLE_CAP);
  }

  function badPowerupRepel(p, pu) {
    const dx = p.x - pu.x, dy = p.y - pu.y;
    const d = Math.hypot(dx, dy);
    const R = POWERUP_R + BRUSH_R * 5;
    if (d >= R || d < 0.001) return { x: 0, y: 0 };
    const w = (1 - d / R) * 2.2;
    return { x: (dx / d) * w, y: (dy / d) * w };
  }

  function worthChasing(p, pu, room, ai, t) {
    const myD = Math.hypot(pu.x - p.x, pu.y - p.y);
    let rivalD = Infinity;
    for (const o of room.players.values()) {
      if (o.slot < 0 || o === p) continue;
      const d = Math.hypot(pu.x - o.x, pu.y - o.y);
      if (d < rivalD) rivalD = d;
    }
    const timeLeft = (pu.expiresAt - t) / 1000;
    if (Number.isFinite(timeLeft) && myD > timeLeft * MAX_SPEED * 0.85 * 1.1) {
      return Math.random() < 0.12;
    }
    const ageFrac = Number.isFinite(timeLeft)
      ? clamp(1 - timeLeft / (POWERUP_TTL_MS / 1000), 0, 1)
      : 0;
    const behindEff = Math.max(0, myD - rivalD) * (1 - 0.8 * ageFrac);
    if (behindEff <= BRUSH_R * 3) return true;
    const behind = clamp(behindEff / 240, 0, 1);
    const chaseProb = (0.55 + 0.25 * ai.greed) - 0.55 * behind + 0.35 * ageFrac;
    return Math.random() < chaseProb;
  }

  function chooseTerritoryTarget(p, room, ai, band) {
    const blank = room.coarseBlank;
    const own = room.coarseOwn;
    if (!blank) {
      ai.targetX = WORLD_W * 0.5 + gauss() * 220;
      ai.targetY = WORLD_H * 0.5 + gauss() * 160;
      return;
    }
    const ZW = COARSE_ZW, ZH = COARSE_ZH;
    const behind = Math.max(0, band);
    const leader = leaderSlotOf(room);
    let painted = 0;
    for (let s = 0; s < MAX_PLAYERS; s++) painted += room.scores[s];
    const endgame = clamp(1 - (1 - painted / TOTAL_CELLS) / 0.25, 0, 1);
    const enemyW = 1.6 + ai.contest + 0.6 * behind + 1.4 * endgame;
    const leaderW = (leader >= 0 && leader !== p.slot) ? (0.4 + 1.0 * behind + 1.3 * endgame) : 0;

    const occ = new Int8Array(ZW * ZH);
    for (const o of room.players.values()) {
      if (o.slot < 0) continue;
      const zx = Math.min(ZW - 1, (o.x / ZONE_W_PX) | 0);
      const zy = Math.min(ZH - 1, (o.y / ZONE_H_PX) | 0);
      occ[zy * ZW + zx]++;
    }
    const myZX = Math.min(ZW - 1, (p.x / ZONE_W_PX) | 0);
    const myZY = Math.min(ZH - 1, (p.y / ZONE_H_PX) | 0);

    let b1 = -Infinity, b2 = -Infinity, b3 = -Infinity;
    let x1 = p.x, y1 = p.y, x2 = p.x, y2 = p.y, x3 = p.x, y3 = p.y;
    for (let zy = 0; zy < ZH; zy++) {
      for (let zx = 0; zx < ZW; zx++) {
        const z = zy * ZW + zx;
        const b = blank[z];
        const ownC = own[z * MAX_PLAYERS + p.slot];
        const enemy = ZONE_CELLS - b - ownC;
        let value = b + enemy * enemyW - ownC * 0.7;
        if (zx === 0 || zx === ZW - 1 || zy === 0 || zy === ZH - 1) value += b * 0.18;
        if (leaderW) value += own[z * MAX_PLAYERS + leader] * leaderW;
        const cxp = (zx + 0.5) * ZONE_W_PX;
        const cyp = (zy + 0.5) * ZONE_H_PX;
        const dist = Math.hypot(cxp - p.x, cyp - p.y);
        const crowd = Math.max(0, occ[z] - (zx === myZX && zy === myZY ? 1 : 0));
        const score = value / (1 + dist * 0.0024) - crowd * 16;
        if (score > b1) { b3 = b2; x3 = x2; y3 = y2; b2 = b1; x2 = x1; y2 = y1; b1 = score; x1 = cxp; y1 = cyp; }
        else if (score > b2) { b3 = b2; x3 = x2; y3 = y2; b2 = score; x2 = cxp; y2 = cyp; }
        else if (score > b3) { b3 = score; x3 = cxp; y3 = cyp; }
      }
    }
    const r = Math.random();
    let px = x1, py = y1;
    if (r > 0.85 && b3 > -Infinity) { px = x3; py = y3; }
    else if (r > 0.6 && b2 > -Infinity) { px = x2; py = y2; }
    ai.targetX = clamp(px + gauss() * (ZONE_W_PX * 0.3), BRUSH_R, WORLD_W - BRUSH_R);
    ai.targetY = clamp(py + gauss() * (ZONE_H_PX * 0.3), BRUSH_R, WORLD_H - BRUSH_R);
    ai.aimBias = gauss() * ai.aimError;
  }

  function chooseEraseTarget(p, room, ai, band, focusSlot = -1) {
    const blank = room.coarseBlank;
    const own = room.coarseOwn;
    if (!blank) {
      ai.targetX = WORLD_W * 0.5 + gauss() * 220;
      ai.targetY = WORLD_H * 0.5 + gauss() * 160;
      return;
    }

    const ZW = COARSE_ZW, ZH = COARSE_ZH;
    const behind = Math.max(0, band);
    const leader = leaderSlotOf(room);
    const focus = focusSlot >= 0 && focusSlot !== p.slot ? focusSlot : -1;
    const enemyW = 1.2 + 0.5 * ai.contest;
    const leaderW = (leader >= 0 && leader !== p.slot) ? (0.8 + 0.9 * behind) : 0;
    const focusW = focus >= 0 ? (0.8 + 1.25 * ai.vengeance) : 0;

    const occ = new Int8Array(ZW * ZH);
    for (const o of room.players.values()) {
      if (o.slot < 0) continue;
      const zx = Math.min(ZW - 1, (o.x / ZONE_W_PX) | 0);
      const zy = Math.min(ZH - 1, (o.y / ZONE_H_PX) | 0);
      occ[zy * ZW + zx]++;
    }
    const myZX = Math.min(ZW - 1, (p.x / ZONE_W_PX) | 0);
    const myZY = Math.min(ZH - 1, (p.y / ZONE_H_PX) | 0);

    let b1 = -Infinity, b2 = -Infinity, b3 = -Infinity;
    let x1 = p.x, y1 = p.y, x2 = p.x, y2 = p.y, x3 = p.x, y3 = p.y;
    for (let zy = 0; zy < ZH; zy++) {
      for (let zx = 0; zx < ZW; zx++) {
        const z = zy * ZW + zx;
        const b = blank[z];
        const ownC = own[z * MAX_PLAYERS + p.slot];
        const enemy = Math.max(0, ZONE_CELLS - b - ownC);
        let value = enemy * enemyW - ownC * 2.4 - b * 0.22;
        if (leaderW) value += own[z * MAX_PLAYERS + leader] * leaderW;
        if (focusW && focus !== leader) value += own[z * MAX_PLAYERS + focus] * focusW;
        const cxp = (zx + 0.5) * ZONE_W_PX;
        const cyp = (zy + 0.5) * ZONE_H_PX;
        const dist = Math.hypot(cxp - p.x, cyp - p.y);
        const crowd = Math.max(0, occ[z] - (zx === myZX && zy === myZY ? 1 : 0));
        const score = value / (1 + dist * 0.0028) - crowd * 12;
        if (score > b1) { b3 = b2; x3 = x2; y3 = y2; b2 = b1; x2 = x1; y2 = y1; b1 = score; x1 = cxp; y1 = cyp; }
        else if (score > b2) { b3 = b2; x3 = x2; y3 = y2; b2 = score; x2 = cxp; y2 = cyp; }
        else if (score > b3) { b3 = score; x3 = cxp; y3 = cyp; }
      }
    }

    const r = Math.random();
    let px = x1, py = y1;
    if (r > 0.88 && b3 > -Infinity) { px = x3; py = y3; }
    else if (r > 0.64 && b2 > -Infinity) { px = x2; py = y2; }
    ai.targetX = clamp(px + gauss() * (ZONE_W_PX * 0.25), BRUSH_R, WORLD_W - BRUSH_R);
    ai.targetY = clamp(py + gauss() * (ZONE_H_PX * 0.25), BRUSH_R, WORLD_H - BRUSH_R);
    ai.aimBias = gauss() * ai.aimError;
  }

  function avoidEdges(p, desired) {
    const margin = BRUSH_R * 2;
    const dx = Math.cos(desired), dy = Math.sin(desired);
    let nx = 0, ny = 0;
    if (p.x < margin && dx < 0) nx += (1 - p.x / margin);
    else if (p.x > WORLD_W - margin && dx > 0) nx -= (1 - (WORLD_W - p.x) / margin);
    if (p.y < margin && dy < 0) ny += (1 - p.y / margin);
    else if (p.y > WORLD_H - margin && dy > 0) ny -= (1 - (WORLD_H - p.y) / margin);
    if (nx === 0 && ny === 0) return desired;
    return Math.atan2(dy + ny, dx + nx);
  }

  function paintField(room, p, enemyVal) {
    const grid = room.grid;
    const LA = BRUSH_R * 2.0;
    let vx = 0, vy = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TWO_PI;
      const dx = Math.cos(a), dy = Math.sin(a);
      let val = 0, n = 0;
      for (let s = 1; s <= 3; s++) {
        const wx = p.x + dx * LA * s;
        const wy = p.y + dy * LA * s;
        if (wx < 0 || wy < 0 || wx >= WORLD_W || wy >= WORLD_H) continue;
        const c = grid[((wy / CELL) | 0) * GRID_W + ((wx / CELL) | 0)];
        n++;
        if (c === EMPTY) val += 1;
        else if (c === p.slot) val -= 0.4;
        else val += enemyVal;
      }
      if (n) { const w = val / n; vx += dx * w; vy += dy * w; }
    }
    return { vx, vy };
  }

  function rivalRepel(room, p) {
    const R = BRUSH_R * 6;
    let vx = 0, vy = 0;
    for (const o of room.players.values()) {
      if (o.slot < 0 || o === p) continue;
      const dx = p.x - o.x, dy = p.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.001 && d < R) {
        const w = 1 - d / R;
        vx += (dx / d) * w;
        vy += (dy / d) * w;
      }
    }
    return { vx, vy };
  }

  function setTargetNearActor(p, ai, target, velocitySeconds) {
    const vx = Number.isFinite(target.vx) ? target.vx : 0;
    const vy = Number.isFinite(target.vy) ? target.vy : 0;
    ai.targetX = clamp(target.x + vx * velocitySeconds + gauss() * BRUSH_R * 0.7, BRUSH_R, WORLD_W - BRUSH_R);
    ai.targetY = clamp(target.y + vy * velocitySeconds + gauss() * BRUSH_R * 0.7, BRUSH_R, WORLD_H - BRUSH_R);
    ai.aimBias = gauss() * ai.aimError * 0.45;
  }

  function revengeSpark(ai, behind, leading, targetIsLeader) {
    const chance = clamp(
      REVENGE_SPARK_BASE
        + REVENGE_SPARK_VENGEANCE * ai.vengeance
        + REVENGE_SPARK_BEHIND * behind
        + (targetIsLeader ? REVENGE_SPARK_LEADER_BONUS : 0)
        - REVENGE_SPARK_LEADING_PENALTY * leading,
      0,
      REVENGE_SPARK_CAP
    );
    return Math.random() < chance;
  }

  function beginDisruptionPlan(p, room, ai, t, band, kind) {
    const target = disruptionAggressor(room, p, t, kind);
    const leader = leaderSlotOf(room);
    const behind = Math.max(0, band);
    const leading = Math.max(0, -band);
    ai.disruptTargetId = target ? target.id : 0;
    ai.disruptTargetSlot = target ? target.slot : topEnemySlotOf(room, p);
    ai.disruptRetargetAt = 0;
    ai.retargetAt = 0;

    if (kind === 'erase') {
      if (!target) {
        ai.disruptMode = 'objective';
        return;
      }
      if (!revengeSpark(ai, behind, leading, target.slot === leader)) {
        ai.disruptMode = 'objective';
        return;
      }
      const huntProb = clamp(
        ERASER_HUNT_BASE
          + ERASER_HUNT_VENGEANCE * ai.vengeance
          + ERASER_HUNT_BEHIND * behind
          - 0.08 * leading,
        0.18,
        ERASER_HUNT_CAP
      );
      ai.disruptMode = Math.random() < huntProb ? 'hunt' : 'turf';
    } else {
      if (!target) {
        ai.disruptMode = 'objective';
        return;
      }
      if (!revengeSpark(ai, behind, leading, target.slot === leader)) {
        ai.disruptMode = 'objective';
        return;
      }
      const shadowProb = clamp(
        INKJAM_SHADOW_BASE
          + INKJAM_SHADOW_VENGEANCE * ai.vengeance
          + INKJAM_SHADOW_BEHIND * behind
          - 0.18 * leading,
        0.02,
        INKJAM_SHADOW_CAP
      );
      ai.disruptMode = Math.random() < shadowProb ? 'shadow' : 'objective';
    }
  }

  function currentDisruptionTarget(room, p, ai, t, normalOnly = false) {
    const byId = ai.disruptTargetId ? room.players.get(ai.disruptTargetId) : null;
    if (byId && byId.slot >= 0 && byId.slot !== p.slot && (!normalOnly || isNormalPainter(byId, t))) return byId;
    return closestActorForSlot(room, p, ai.disruptTargetSlot, t, normalOnly);
  }

  function refreshDisruptionTarget(p, room, ai, t, band, kind) {
    if (kind === 'erase') {
      if (ai.disruptMode === 'hunt') {
        const target = currentDisruptionTarget(room, p, ai, t, true);
        if (target) {
          setTargetNearActor(p, ai, target, -0.18);
          ai.disruptRetargetAt = t + rand(DISRUPT_HUNT_RETARGET_MIN_MS, DISRUPT_HUNT_RETARGET_MAX_MS);
          return;
        }
        ai.disruptMode = 'turf';
      }
      chooseEraseTarget(p, room, ai, band, ai.disruptMode === 'turf' ? ai.disruptTargetSlot : -1);
      ai.disruptRetargetAt = t + rand(ai.retargetMs[0], ai.retargetMs[1]) * DISRUPT_TURF_RETARGET_SCALE;
      return;
    }

    if (ai.disruptMode === 'shadow') {
      const target = currentDisruptionTarget(room, p, ai, t, false);
      if (target) {
        setTargetNearActor(p, ai, target, 0.20);
        ai.disruptRetargetAt = t + rand(DISRUPT_SHADOW_RETARGET_MIN_MS, DISRUPT_SHADOW_RETARGET_MAX_MS);
        return;
      }
      ai.disruptMode = 'objective';
    }
    chooseTerritoryTarget(p, room, ai, band);
    ai.disruptRetargetAt = t + rand(ai.retargetMs[0], ai.retargetMs[1]) * DISRUPT_OBJECTIVE_RETARGET_SCALE;
  }

  function updateBot(p, room, dt, t) {
    const ai = p.ai;
    if (!ai) { p.mx = 0; p.my = 0; return; }

    if (t < ai.thinkUntil) { p.mx = 0; p.my = 0; return; }

    const band = rubberBand(room, p);

    const disrupted = t < p.noPaintUntil || t < p.erasingUntil;
    const disruptKind = t < p.noPaintUntil ? 'nopaint' : 'erase';
    if (disrupted) {
      const sig = `${disruptKind}:${Math.max(p.noPaintUntil, p.erasingUntil)}`;
      if (ai.disruptSeen !== sig) {
        ai.disruptSeen = sig;
        ai.disruptIdle = Math.random() < DISRUPT_IDLE_BASE * (1 - 0.65 * ai.vengeance);
        beginDisruptionPlan(p, room, ai, t, band, disruptKind);
      }
      if (ai.disruptIdle) { p.mx = 0; p.my = 0; return; }
    }

    let urgent = false;
    let avoidPU = false;
    const pu = nearestPowerup(room, p, ai.noticeR);
    if (pu) {
      if (ai.puId !== pu.id) {
        ai.puId = pu.id;
        const reaction = rand(ai.reactMs[0], ai.reactMs[1]);
        const missed = t < pu.armsAt && Math.random() < TELEGRAPH_MISS_BASE * (1 - 0.7 * ai.greed);
        ai.puReactAt = (missed ? pu.armsAt : t) + reaction;
        ai.puChase = worthChasing(p, pu, room, ai, t);
        ai.puReCheckAt = t + 500;
        ai.puReadType = null;
      } else if (t >= ai.puReCheckAt) {
        ai.puReCheckAt = t + 500;
        ai.puChase = worthChasing(p, pu, room, ai, t);
      }
      if (ai.puReadType !== pu.type) {
        ai.puReadType = pu.type;
        ai.puVerdict = 'pending';
        ai.puJudgeAt = t + rand(ai.reactMs[0], ai.reactMs[1]) + 520 * ai.greed + rand(0, 140);
      }
      if (ai.puVerdict === 'pending') {
        const dist = Math.hypot(pu.x - p.x, pu.y - p.y);
        if (t >= ai.puJudgeAt || dist < BRUSH_R * 8) {
          const bad = BAD_POWERUPS.has(pu.type)
            || ((pu.type === 'snap' || pu.type === 'mortar') && botIsLeading(room, p));
          ai.puVerdict = (!bad || Math.random() < badGrabChance(pu, ai, dist, t)) ? 'go' : 'avoid';
          if (ai.puVerdict === 'avoid') {
            ai.retargetAt = 0;
            ai.disruptRetargetAt = 0;
          }
        }
      }
      if (ai.puChase && ai.puVerdict !== 'avoid' && t >= ai.puReactAt) { ai.targetX = pu.x; ai.targetY = pu.y; urgent = true; }
      else if (ai.puVerdict === 'avoid') avoidPU = true;
    } else if (ai.puId !== null) {
      ai.puId = null;
      ai.puChase = false;
      ai.puReadType = null;
      ai.puVerdict = 'go';
      ai.retargetAt = 0;
      ai.disruptRetargetAt = 0;
    }

    if (!urgent) {
      if (disrupted) {
        if (ai.targetX === undefined || t >= ai.disruptRetargetAt) {
          refreshDisruptionTarget(p, room, ai, t, band, disruptKind);
        }
      } else if (ai.targetX === undefined || t >= ai.retargetAt) {
        let interval = rand(ai.retargetMs[0], ai.retargetMs[1]);
        if (band > 0) interval *= (1 - 0.45 * band);
        else interval *= (1 + 0.4 * -band);
        ai.retargetAt = t + interval;
        const pauseProb = ai.thinkProb * (1 - 0.7 * Math.max(0, band));
        if (Math.random() < pauseProb) ai.thinkUntil = t + rand(ai.thinkMs[0], ai.thinkMs[1]);
        chooseTerritoryTarget(p, room, ai, band);
      }
      const dx0 = ai.targetX - p.x, dy0 = ai.targetY - p.y;
      if (dx0 * dx0 + dy0 * dy0 < (BRUSH_R * 2.5) * (BRUSH_R * 2.5)) {
        if (disrupted) ai.disruptRetargetAt = Math.min(ai.disruptRetargetAt, t + 100);
        else ai.retargetAt = Math.min(ai.retargetAt, t + 100);
      }
    }

    ai.wanderPhase += dt * ai.wanderFreq;
    let desired;
    if (urgent || disrupted) {
      desired = Math.atan2(ai.targetY - p.y, ai.targetX - p.x) + Math.sin(ai.wanderPhase) * (ai.wanderAmp * 0.25);
    } else {
      let painted = 0;
      for (let s = 0; s < MAX_PLAYERS; s++) painted += room.scores[s];
      const attack = clamp(1 - (1 - painted / TOTAL_CELLS) / 0.25, 0, 1);
      const enemyVal = 0.15 + 1.9 * Math.max(attack, 0.6 * Math.max(0, band));
      const field = paintField(room, p, enemyVal);
      const tAng = Math.atan2(ai.targetY - p.y, ai.targetX - p.x);
      let dvx = Math.cos(tAng) * 0.45 + field.vx * 1.2 + Math.cos(ai.aimAngle) * 0.55;
      let dvy = Math.sin(tAng) * 0.45 + field.vy * 1.2 + Math.sin(ai.aimAngle) * 0.55;
      const spaceW = 0.9 * (1 - attack) * (1 - 0.5 * Math.max(0, band));
      if (spaceW > 0.05) {
        const rep = rivalRepel(room, p);
        dvx += rep.vx * spaceW;
        dvy += rep.vy * spaceW;
      }
      desired = Math.atan2(dvy, dvx) + Math.sin(ai.wanderPhase) * ai.wanderAmp + ai.aimBias;
    }
    if (avoidPU) {
      const rep = badPowerupRepel(p, pu);
      if (rep.x || rep.y) desired = Math.atan2(Math.sin(desired) + rep.y, Math.cos(desired) + rep.x);
    }
    desired = avoidEdges(p, desired);

    const turn = ai.turnRate * (urgent ? 1.5 : disrupted ? 1.3 : 1) * (1 + 0.3 * Math.max(0, band));
    ai.aimAngle = stepAngle(ai.aimAngle, desired, turn * dt);
    p.mx = Math.cos(ai.aimAngle);
    p.my = Math.sin(ai.aimAngle);
  }

  return { createBotAI, updateBot };
})();

const SIM = {
  started: false,
  // Round stage machine, mirroring the match lifecycle:
  // 'waiting' (first visit, until WASD) -> 'active' (2:00 round) ->
  // 'intermission' (inline results, 10s) -> 'countdown' (3-2-1) -> 'active'...
  stage: 'waiting',
  stageUntil: 0,       // when intermission/countdown hands over
  nextId: 1,
  bag: [],             // shuffle bag for spawn types (full coverage, no repeats)
  firstSpawnDone: false,
  nextSpawnAt: 0,
  roundEndsAt: 0,      // the live round's clock
  lastCoarseAt: 0,     // next coarse-grid rebuild gate (SIM_BOT_COARSE_MS)
  players: new Map(),  // server-shaped actors: 'me', the bots, and the echo
  room: null,          // the room adapter SimBotAI perceives the world through
  impactQueue: [],     // pending missile splats: [{at,x,y,slot}]
};
let simToastTimer = 0;

function simStart() {
  if (!palette.length) {
    palette = SIM_PALETTE.slice();
    paletteRGB = palette.map(hexToRGB);
  }
  mySlot = Math.floor(Math.random() * palette.length);   // fresh color each visit
  spectating = false;
  // Wait in the match's countdown semantics: paint is held and the bobbing
  // "you" arrow marks the visitor's brush until their first directional input
  // flips the sim to 'active' (simBegin).
  phase = 'countdown';
  if (!paintCtx) initPaintLayer();
  else paintCtx.clearRect(0, 0, G.worldW, G.worldH);
  powerups = [];
  impacts = [];
  pickupFades = [];
  snapFlashes = [];
  remote.clear();
  me.x = G.worldW / 2;
  me.y = G.worldH * 0.46;   // a touch above center so the bottom nav never hides you
  me.vx = 0; me.vy = 0; me.speed = 0; me.face = 1; me.dirAngle = 0;
  me.has = true; me.inputActive = false;
  me.boost = false; me.slow = false; me.frozen = false; me.noPaint = false; me.erasing = false;
  me.paintScale = 1; me.paintSlot = mySlot; me.castType = null;
  me.lastPaintX = undefined; me.lastPaintY = undefined;
  me.serverX = undefined; me.serverY = undefined;
  // Headless room: the score grid + actor map the real bot AI plays against.
  SIM.players.clear();
  SIM.room = {
    grid: new Uint8Array(G.w * G.h).fill(SIM_EMPTY),
    scores: new Int32Array(SIM_MAX_PLAYERS),
    coarseBlank: null,
    coarseOwn: null,
    players: SIM.players,
    powerups: [],
  };
  SIM.lastCoarseAt = 0;
  // Rank bar: you + the bots, live off the sim's score grid.
  scores = new Array(SIM_MAX_PLAYERS).fill(0);
  slotNames = {};
  slotNames[mySlot] = (Store && Store.getName()) || 'You';
  clearRankBar();
  SIM.players.set('me', simMakeActor('me', mySlot, me.x, me.y));
  simSpawnBots();
  SIM.impactQueue = [];
  SIM.bag = [];
  SIM.nextId = 1;
  SIM.firstSpawnDone = false;
  SIM.nextSpawnAt = 0;
  SIM.roundEndsAt = 0;
  SIM.stage = 'waiting';
  SIM.stageUntil = 0;
  SIM.started = true;
  showSimHint();
}

// First directional input ever: the opening round's GO.
function simBegin(t) {
  simRoundGo(t);
}

// GO: a fresh 2:00 round opens (the first input, or the 3-2-1 expiring).
function simRoundGo(t) {
  SIM.stage = 'active';
  phase = 'active';                            // paint flows; the "you" arrow retires
  SIM.roundEndsAt = t + SIM_ROUND_MS;
  SIM.nextSpawnAt = t + SIM_FIRST_SPAWN_MS;    // this round's first portal
  simRecomputeCoarse();                        // fresh zones, like startRound
  SIM.lastCoarseAt = t;
}

// Time! Freeze the field, rank the room, and show the result right where the
// tutorial line lives -- no modal out here. Confetti when the visitor wins.
function simRoundOver(t) {
  SIM.stage = 'intermission';
  phase = 'intermission';                      // brushes hold; paint stops
  SIM.stageUntil = t + SIM_INTERMISSION_MS;
  powerups = [];
  SIM.impactQueue = [];
  me.vx = 0; me.vy = 0; me.speed = 0; me.inputActive = false;
  const sc = SIM.room.scores;
  const slots = [];
  for (const a of SIM.players.values()) if (!a.isEcho) slots.push(a.slot);
  slots.sort((x, y) => sc[y] - sc[x]);
  const tie = slots.length > 1 && sc[slots[0]] === sc[slots[1]] && sc[slots[0]] > 0;
  const myRank = slots.indexOf(mySlot) + 1;
  const myPct = (((sc[mySlot] || 0) / (G.w * G.h)) * 100).toFixed(1);
  const won = !tie && slots[0] === mySlot && sc[mySlot] > 0;
  if (won) {
    showSimResults('boon', 'You win!', `${myPct}% painted — rematch in a moment.`, true);
    startResultConfetti();
  } else if (tie) {
    showSimResults('hint', 'Tie!', `You finished ${simOrdinal(myRank)} at ${myPct}%.`, false);
  } else {
    const champ = slotNames[slots[0]] || `P${slots[0] + 1}`;
    showSimResults('bad', `${champ} wins`, `You finished ${simOrdinal(myRank)} of ${slots.length} at ${myPct}%.`, false);
  }
  if (GameAudio) GameAudio.roundEnd(won);
}

// Intermission over: wipe the canvas, restage the formation, and run the
// match-style 3-2-1 (the "you" arrow re-marks the visitor) before GO.
function simNextRound(t) {
  SIM.stage = 'countdown';
  phase = 'countdown';
  SIM.stageUntil = t + SIM_COUNTDOWN_MS;
  hideSimToast();
  if (paintCtx) paintCtx.clearRect(0, 0, G.worldW, G.worldH);
  SIM.room.grid.fill(SIM_EMPTY);
  SIM.room.scores.fill(0);
  simRecomputeCoarse();
  SIM.lastCoarseAt = t;
  pickupFades = [];
  impacts = [];
  snapFlashes = [];
  SIM.players.delete(SIM_ECHO_ID);
  remote.delete(SIM_ECHO_ID);
  // Fresh formation: you back at center, bots re-flanked, every effect cleared.
  me.x = G.worldW / 2;
  me.y = G.worldH * 0.46;
  me.vx = 0; me.vy = 0; me.speed = 0; me.face = 1; me.dirAngle = 0; me.inputActive = false;
  me.boost = false; me.slow = false; me.frozen = false; me.noPaint = false; me.erasing = false;
  me.paintScale = 1; me.paintSlot = mySlot; me.castType = null;
  me.lastPaintX = undefined; me.lastPaintY = undefined;
  // Reset the SIM 'me' actor in place (the render `me` was reset just above).
  const meA = SIM.players.get('me');
  if (meA) {
    meA.x = me.x; meA.y = me.y; meA.prevX = me.x; meA.prevY = me.y;
    meA.vx = 0; meA.vy = 0; meA.mx = 0; meA.my = 0;
    meA.boostUntil = 0; meA.slowUntil = 0; meA.frozenUntil = 0; meA.noPaintUntil = 0; meA.erasingUntil = 0;
    meA.brushScale = 1; meA.brushScaleUntil = 0;
    meA.castType = null; meA.castUntil = 0;
  }
  // Rebuild the bot set fresh so any change to the Players count takes effect this round.
  simRebuildBots();
  resetTrailAnchors();
  simSyncRenderActors(t);
  scores = new Array(SIM_MAX_PLAYERS).fill(0);
}

function simOrdinal(n) {
  return ['1st', '2nd', '3rd', '4th', '5th', '6th'][n - 1] || `${n}th`;
}

// Hand the shared world state back to the match pipeline clean: no sim effects,
// powerups, bots, or ghost twin survive, and me.has=false so the first
// authoritative snapshot is adopted as-is.
function simStop() {
  if (!SIM.started) return;
  SIM.started = false;
  SIM.stage = 'waiting';
  SIM.impactQueue = [];
  stopResultConfetti();
  hideSimToast();
  clearRankBar();      // the match rebuilds its own chips from server state
  slotNames = {};
  remote.clear();
  SIM.players.clear();
  SIM.room = null;
  powerups = [];
  impacts = [];
  pickupFades = [];
  snapFlashes = [];
  me.has = false;
  me.boost = false; me.slow = false; me.frozen = false; me.noPaint = false; me.erasing = false;
  me.paintScale = 1; me.paintSlot = null; me.castType = null;
  spectating = true;
  phase = 'active';   // neutral until the server's init/roundstart takes over
}

function simTick(dt, t) {
  // Stage machine. Waiting: everyone idles under the "you" arrow until the
  // visitor's first WASD/arrow input. Intermission: results linger, field
  // frozen. Countdown: fresh formation under the arrow, then GO.
  if (SIM.stage === 'waiting') {
    const { mx, my } = currentInput();
    if (mx || my) simBegin(t);
    else return;
  } else if (SIM.stage === 'intermission') {
    if (t >= SIM.stageUntil) simNextRound(t);
    return;
  } else if (SIM.stage === 'countdown') {
    if (t < SIM.stageUntil) return;
    simRoundGo(t);
  }

  // Time's up -> results + intermission (everything below is live-round only).
  if (t >= SIM.roundEndsAt) {
    simRoundOver(t);
    return;
  }

  // Your brush: effect flags come off your shared room-actor (a bot's freeze /
  // ink-jam / erase lands there too), then the usual client drive.
  const meA = SIM.players.get('me');
  me.boost = t < meA.boostUntil;
  me.slow = t < meA.slowUntil;
  me.frozen = t < meA.frozenUntil;
  me.noPaint = t < meA.noPaintUntil;
  me.erasing = t < meA.erasingUntil;
  me.paintScale = (t < meA.brushScaleUntil && meA.brushScale > 0) ? meA.brushScale : 1;
  me.castType = t < meA.castUntil ? meA.castType : null;
  me.paintSlot = mySlot;

  if (me.frozen) {              // frozen lesson: locked in place
    me.vx = 0; me.vy = 0; me.speed = 0; me.inputActive = false;
  } else {
    const { mx, my } = currentInput();
    driveBrush(mx, my, dt);
    finishBrushKinematics();
  }

  // Sync your actor into the room and stamp your paint onto the score grid --
  // the bots SEE your turf and react to it like in a match.
  const inp = currentInput();
  meA.prevX = meA.x; meA.prevY = meA.y;
  meA.x = me.x; meA.y = me.y; meA.vx = me.vx; meA.vy = me.vy;
  meA.mx = inp.mx; meA.my = inp.my;
  simStampActor(meA, t);

  // The room thinks: coarse zones on the server cadence, real bot AI, the echo
  // mirroring its owner, then server physics for everyone but you.
  if (t - SIM.lastCoarseAt >= SIM_BOT_COARSE_MS) { simRecomputeCoarse(); SIM.lastCoarseAt = t; }
  // Lesson #1 is reserved for the visitor: the bots don't even see it.
  SIM.room.powerups = powerups.filter((pu) => pu.id !== 1);
  for (const a of SIM.players.values()) {
    if (a.id === 'me') continue;
    if (a.isEcho) {
      const owner = SIM.players.get(a.ownerId);
      if (owner) { a.mx = owner.mx; a.my = owner.my; }
      else { a.mx = 0; a.my = 0; }
    } else {
      SimBotAI.updateBot(a, SIM.room, dt, t);
    }
    simStepActor(a, dt, t);
    simStampActor(a, t);
  }

  simUpdatePowerups(t);
  simProcessImpacts(t);
  simExpireEcho(t);
  simSyncRenderActors(t);
}

// ---- sim actors (server-shaped bodies the AI + physics run on) --------------
function simMakeActor(id, slot, x, y) {
  return {
    id, slot, isEcho: false, ownerId: null, ai: null,
    x, y, vx: 0, vy: 0, mx: 0, my: 0, prevX: x, prevY: y,
    boostUntil: 0, slowUntil: 0, frozenUntil: 0, noPaintUntil: 0, erasingUntil: 0,
    brushScale: 1, brushScaleUntil: 0,
    castType: null, castUntil: 0,
    echoExpiresAt: 0,
  };
}

// Fresh remote-map entry for an actor (the render pipeline's shape).
function simMakeRenderEntry(a) {
  return {
    slot: a.slot, rx: a.x, ry: a.y, tx: a.x, ty: a.y,
    face: 1, dirAngle: 0, speed: 0, inputActive: false,
    boost: false, slow: false, frozen: false, noPaint: false, erasing: false,
    paintScale: 1, paintSlot: a.slot, echo: a.isEcho, castType: null,
  };
}

// Landing player count (you + bots), 2..6, persisted; read at each round stage.
function simTargetPlayers() {
  let n = SIM_MAX_PLAYERS;
  try { if (Store) n = Store.getSim().players; } catch (_) { /* ignore */ }
  n = Math.round(Number(n) || SIM_MAX_PLAYERS);
  return Math.max(2, Math.min(SIM_MAX_PLAYERS, n));
}

function simShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

// N spawn spots ringed around your center, jittered, clamped inside the arena.
function simBotSpots(n) {
  const cx = G.worldW / 2, cy = G.worldH * 0.5;
  const rx = G.worldW * 0.30, ry = G.worldH * 0.32;
  const base = Math.random() * Math.PI * 2;
  const spots = [];
  for (let i = 0; i < n; i++) {
    const ang = base + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const x = cx + Math.cos(ang) * rx * (0.82 + Math.random() * 0.34);
    const y = cy + Math.sin(ang) * ry * (0.82 + Math.random() * 0.34);
    spots.push({
      x: Math.max(BRUSH_R * 2, Math.min(G.worldW - BRUSH_R * 2, x)),
      y: Math.max(BRUSH_R * 2, Math.min(G.worldH - BRUSH_R * 2, y)),
    });
  }
  return spots;
}

// Remove all sim bots (keeps 'me'); used before a rebuild.
function simClearBots() {
  for (const bid of SIM_BOT_IDS) { SIM.players.delete(bid); remote.delete(bid); }
}

// Rebuild the bot set fresh (count from the Players setting); keeps 'me'.
function simRebuildBots() {
  slotNames = {}; slotNames[mySlot] = (Store && Store.getName()) || 'You';
  simClearBots();
  simSpawnBots();
}

// The bots: real AI brains in rival colors, ringed around your center spawn. The count
// follows the Players setting (you + 1..5 bots); identities/personalities shuffle per round.
function simSpawnBots() {
  const n = Math.max(1, Math.min(SIM_BOT_IDS.length, simTargetPlayers() - 1));
  const open = simShuffle(palette.map((_, s) => s).filter((s) => s !== mySlot));
  const kinds = simShuffle(SIM_BOT_KINDS.slice());
  const names = simShuffle(SIM_BOT_NAMES.slice());
  const spots = simBotSpots(n);
  for (let i = 0; i < n; i++) {
    const bid = SIM_BOT_IDS[i];
    const a = simMakeActor(bid, open[i], spots[i].x, spots[i].y);
    a.ai = SimBotAI.createBotAI(kinds[i % kinds.length]);
    slotNames[a.slot] = names[i % names.length];   // rank-bar handle
    SIM.players.set(bid, a);
    remote.set(bid, simMakeRenderEntry(a));
  }
}

// Server stepPlayer(), minus painting (simStampActor) and netcode.
function simStepActor(p, dt, t) {
  p.prevX = p.x;
  p.prevY = p.y;
  if (t < p.frozenUntil) {
    p.vx = 0;
    p.vy = 0;
    return;
  }
  let speedMult = 1;
  if (t < p.boostUntil) speedMult *= BOOST_MULT;
  if (t < p.slowUntil) speedMult *= SLOW_MULT;
  if (t < p.brushScaleUntil && p.brushScale < 1) speedMult *= TINY_SPEED_MULT;
  const accel = ACCEL * speedMult;
  const maxSpeed = MAX_SPEED * speedMult;
  if (p.mx || p.my) {
    const len = Math.hypot(p.mx, p.my);
    p.vx += (p.mx / len) * accel * dt;
    p.vy += (p.my / len) * accel * dt;
  }
  const damp = Math.exp(-DAMPING_PER_SEC * dt);
  p.vx *= damp;
  p.vy *= damp;
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > maxSpeed) { const k = maxSpeed / sp; p.vx *= k; p.vy *= k; }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (p.x < BRUSH_R) { p.x = BRUSH_R; if (p.vx < 0) p.vx = 0; }
  if (p.x > G.worldW - BRUSH_R) { p.x = G.worldW - BRUSH_R; if (p.vx > 0) p.vx = 0; }
  if (p.y < BRUSH_R) { p.y = BRUSH_R; if (p.vy < 0) p.vy = 0; }
  if (p.y > G.worldH - BRUSH_R) { p.y = G.worldH - BRUSH_R; if (p.vy > 0) p.vy = 0; }
}

// Grid-side paint (the AI's world model). Visuals ride the render pipeline
// (strokeSeg for trails), so this never draws -- it only keeps score.
function simStampActor(p, t) {
  if (phase !== 'active' || t < p.noPaintUntil) return;
  const dx = p.x - p.prevX, dy = p.y - p.prevY;
  if (dx * dx + dy * dy < 0.4) return;        // MIN_PAINT_MOVE2
  const r = BRUSH_R * ((t < p.brushScaleUntil && p.brushScale > 0) ? p.brushScale : 1);
  if (t < p.erasingUntil) {
    simErasePathG(p.prevX, p.prevY, p.x, p.y, r);
  } else {
    simPaintPathG(p.prevX, p.prevY, p.x, p.y, p.slot, r);
  }
}

// Push each non-player actor's state out to its remote-map render entry.
function simSyncRenderActors(t) {
  for (const a of SIM.players.values()) {
    if (a.id === 'me') continue;
    const r = remote.get(a.id);
    if (!r) continue;
    r.rx = a.x; r.ry = a.y; r.tx = a.x; r.ty = a.y;
    r.slot = a.slot;
    r.boost = t < a.boostUntil;
    r.frozen = t < a.frozenUntil;
    r.noPaint = t < a.noPaintUntil;
    r.erasing = t < a.erasingUntil;
    r.paintScale = (t < a.brushScaleUntil && a.brushScale > 0) ? a.brushScale : 1;
    r.paintSlot = a.slot;
    r.castType = t < a.castUntil ? a.castType : null;
    r.inputActive = !!(a.mx || a.my);
    r.speed = Math.hypot(a.vx, a.vy);
    if (a.vx > FACE_EPS) r.face = 1;
    else if (a.vx < -FACE_EPS) r.face = -1;
    if (r.speed > DRIFT_EPS) r.dirAngle = Math.atan2(a.vy, a.vx);
  }
}

// ---- sim HUD: the top bar, live on the landing -------------------------------
// The real round clock (frozen at 2:00 until play, 0:00 through the results)
// with the match's warn/danger states, plus ranking chips fed by the sim's
// score grid. No countdown ticks out here -- the landing stays quiet.
function simUpdateHUD(t) {
  let leftMs;
  if (SIM.stage === 'active') leftMs = Math.max(0, SIM.roundEndsAt - t);
  else if (SIM.stage === 'intermission') leftMs = 0;   // the round just ended
  else leftMs = SIM_ROUND_MS;                          // waiting/countdown: fresh clock
  if (els.timerVal) els.timerVal.textContent = fmtTime(leftMs);
  const secs = Math.ceil(leftMs / 1000);
  const active = SIM.stage === 'active';
  els.timer.classList.toggle('warn', active && secs <= 30 && secs > 10);
  els.timer.classList.toggle('danger', active && secs <= 10);
  if (active && secs <= 30) {
    const t01 = Math.max(0, Math.min(1, secs / 30));          // 1 at 30s -> 0 at 0s
    els.timer.style.setProperty('--eb-speed', (0.45 + 1.75 * t01).toFixed(2) + 's');
  }
  if (t - lastRankAt > 350) {
    lastRankAt = t;
    scores = Array.from(SIM.room.scores);
    updateRankBar();
  }
}

// ---- sim power-ups ----
function simBagDraw() {
  if (!SIM.bag.length) {
    SIM.bag = SIM_TYPES.slice();
    for (let i = SIM.bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = SIM.bag[i]; SIM.bag[i] = SIM.bag[j]; SIM.bag[j] = tmp;
    }
  }
  return SIM.bag.pop();
}

// 50/50 boon-or-hazard re-roll for mid-life flips (mirror of pickFlipType): pick the
// bucket first, then a type within it -- always a visible change.
function simFlipType(exclude) {
  const pool = Math.random() < 0.5 ? SIM_FLIP_BOONS : SIM_FLIP_HAZARDS;
  let type = pool[Math.floor(Math.random() * pool.length)];
  if (type === exclude) {
    const alts = pool.filter((tp) => tp !== exclude);
    if (alts.length) type = alts[Math.floor(Math.random() * alts.length)];
  }
  return type;
}

// Pre-roll the flip moments across the armed life (mirror of makePowerupSwitches).
function simMakeSwitches(armsAt) {
  let r = Math.random();
  let count = 0;
  for (const entry of SIM_SWITCH_CHANCES) {
    if (r < entry.weight) { count = entry.changes; break; }
    r -= entry.weight;
  }
  if (!count) return [];
  const minT = 650;                      // after the spawn lightning settles
  const maxT = SIM_PU_TTL_MS - 700;      // before expiry
  const minGap = 600;                    // each flip reads distinctly
  const times = [];
  for (let attempt = 0; attempt < 40 && times.length < count; attempt++) {
    const cand = minT + Math.random() * (maxT - minT);
    if (times.every((u) => Math.abs(u - cand) >= minGap)) times.push(cand);
  }
  while (times.length < count) times.push(minT + (maxT - minT) * ((times.length + 1) / (count + 1)));
  times.sort((a, b) => a - b);
  return times.map((u) => Math.round(armsAt + u));
}

// Fixed spawn pads, mirroring the server's POWERUP_PADS: center + the four quadrant
// midpoints. Pick a random FREE pad that's clear of every brush and not hidden under
// the landing UI (nav/legend/gear/popovers/toast -- DOM rects, so pads are tested in
// CSS px); else take the farthest-from-anyone unblocked pad.
function simSpawnPoint() {
  const z = Math.min(cam.cssW / G.worldW, (cam.cssH - (cam.barH || 0)) / G.worldH);
  const ox = (cam.cssW - G.worldW * z) / 2;
  const oy = cam.barH || 0;
  const clearR2 = 250 * 250;             // no freebie at anyone's feet (POWERUP_PAD_CLEAR_R)
  const uiPad = SIM_POWERUP_R * z + 18;
  const blockers = [];
  for (const sel of ['#bottom-nav', '#legend', '#legend-menu', '#landing-settings', '#settings-menu', '#sim-toast']) {
    const el = document.querySelector(sel);
    if (!el || el.classList.contains('hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.height) blockers.push(r);
  }
  const pads = [
    [G.worldW * 0.25, G.worldH * 0.25],
    [G.worldW * 0.75, G.worldH * 0.25],
    [G.worldW * 0.50, G.worldH * 0.50],
    [G.worldW * 0.25, G.worldH * 0.75],
    [G.worldW * 0.75, G.worldH * 0.75],
  ];
  const taken = new Set();
  for (const pu of powerups) if (pu.pad != null) taken.add(pu.pad);
  const open = [];
  let farIdx = -1, farD2 = -1;
  for (let i = 0; i < pads.length; i++) {
    if (taken.has(i)) continue;
    const [x, y] = pads[i];
    const cx = ox + x * z, cy = oy + y * z;
    if (blockers.some((r) => cx > r.left - uiPad && cx < r.right + uiPad && cy > r.top - uiPad && cy < r.bottom + uiPad)) continue;
    let n2 = Infinity;
    for (const a of SIM.players.values()) {
      const d2 = (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y);
      if (d2 < n2) n2 = d2;
    }
    if (n2 >= clearR2) open.push(i);
    if (n2 > farD2) { farD2 = n2; farIdx = i; }
  }
  const idx = open.length ? open[Math.floor(Math.random() * open.length)] : farIdx;
  if (idx < 0) return { x: G.worldW / 2, y: G.worldH / 2, pad: null };  // every pad UI-blocked
  return { x: pads[idx][0], y: pads[idx][1], pad: idx };
}

function simSpawnPowerup(t) {
  const pos = simSpawnPoint();
  const armsAt = t + PU_TELEGRAPH_MS;
  // The first lesson is always Speed -- the most instantly readable cause->effect.
  const type = SIM.firstSpawnDone ? simBagDraw() : 'speed';
  SIM.firstSpawnDone = true;
  powerups.push({
    id: SIM.nextId++,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    pad: pos.pad,
    type,
    armed: false,
    armsAt,
    expiresAt: armsAt + SIM_PU_TTL_MS,
    switches: simMakeSwitches(armsAt),
    switchIndex: 0,
  });
}

function simUpdatePowerups(t) {
  for (const pu of powerups) {
    while (pu.switchIndex < pu.switches.length && t >= pu.switches[pu.switchIndex]) {
      pu.type = simFlipType(pu.type);    // powerupFx spots the change and plays the flip
      pu.switchIndex++;
    }
    pu.armed = t >= pu.armsAt;
  }
  // Unclaimed pickups expire quietly; give the empty stage a short pause
  // before the next portal so lessons never blur together.
  const before = powerups.length;
  powerups = powerups.filter((pu) => t < pu.expiresAt);
  if (powerups.length < before && !powerups.length) {
    SIM.nextSpawnAt = Math.max(SIM.nextSpawnAt, t + SIM_RESPAWN_GAP_MS + Math.random() * SIM_SPAWN_JITTER_MS);
  }

  // Swept pickup test for EVERY non-echo actor -- the bots race you to these,
  // judged by the real AI (worthChasing / bad-icon verdicts) above.
  const reach = SIM_POWERUP_R + BRUSH_R;
  for (const a of SIM.players.values()) {
    if (a.isEcho) continue;
    for (let i = powerups.length - 1; i >= 0; i--) {
      const pu = powerups[i];
      if (!pu.armed) continue;             // still telegraphing -- not grabbable yet
      if (pu.id === 1 && a.id !== 'me') continue;   // lesson #1 is the visitor's
      if (!simPowerupHit(a, pu, reach)) continue;
      powerups.splice(i, 1);
      pickupFades.push({ x: pu.x, y: pu.y, type: pu.type, start: nowMs });
      if (GameAudio) GameAudio.pickup(pu.type);
      simApplyPowerup(a, pu.type, t);
      showSimToast(pu.type, a.id !== 'me');
      // The collected lesson holds the stage; the next portal waits until the
      // effect has fully run out (plus a breath) -- one power at a time.
      SIM.nextSpawnAt = t + simLessonMs(pu.type) + SIM_SPAWN_GAP_MS + Math.random() * SIM_SPAWN_JITTER_MS;
    }
  }

  // Linear spawning: only onto an empty board, never during a running lesson.
  if (!powerups.length && t >= SIM.nextSpawnAt) {
    simSpawnPowerup(t);
  }
}

// Swept reach test (server powerupHit/closestPointDist2): a boosted brush
// can't tunnel through a pickup between frames.
function simPowerupHit(p, pu, reach) {
  const ax = Number.isFinite(p.prevX) ? p.prevX : p.x;
  const ay = Number.isFinite(p.prevY) ? p.prevY : p.y;
  const dx = p.x - ax, dy = p.y - ay;
  const len2 = dx * dx + dy * dy;
  let d2;
  if (len2 <= 0.0001) {
    const x = pu.x - p.x, y = pu.y - p.y;
    d2 = x * x + y * y;
  } else {
    const tt = Math.max(0, Math.min(1, ((pu.x - ax) * dx + (pu.y - ay) * dy) / len2));
    const cx = ax + dx * tt, cy = ay + dy * tt;
    const x = pu.x - cx, y = pu.y - cy;
    d2 = x * x + y * y;
  }
  return d2 <= reach * reach;
}

// Mirror of the server's applyPowerup(), against the shared actor map: self
// effects hit the grabber, rival-targeting powers hit everyone else -- you
// included, when a bot wins the race.
function simApplyPowerup(p, type, t) {
  const rivals = [];
  for (const o of SIM.players.values()) if (o.slot !== p.slot) rivals.push(o);
  if (type === 'speed') {
    p.boostUntil = t + SIM_EFFECT_MS.speed;
  } else if (type === 'slow') {
    p.slowUntil = t + SIM_EFFECT_MS.slow;
  } else if (type === 'freeze') {
    p.castType = 'freeze'; p.castUntil = t + SIM_EFFECT_MS.freeze;
    for (const o of rivals) o.frozenUntil = t + SIM_EFFECT_MS.freeze;
  } else if (type === 'selfFreeze') {
    p.frozenUntil = t + SIM_EFFECT_MS.selfFreeze;
  } else if (type === 'inkjam') {
    for (const o of rivals) o.noPaintUntil = t + SIM_EFFECT_MS.inkjam;
  } else if (type === 'selfInkjam') {
    p.noPaintUntil = t + SIM_EFFECT_MS.selfInkjam;
  } else if (type === 'missile') {
    p.castType = 'missile'; p.castUntil = t + SIM_EFFECT_MS.missile;
    simScheduleMissiles(p.slot, t, SIM_MISSILE_COUNT, null);
  } else if (type === 'badMissile') {
    // opponentSlots(): distinct active slots other than the grabber's.
    const slots = [];
    const seen = new Set();
    for (const o of SIM.players.values()) {
      if (o.slot === p.slot || seen.has(o.slot)) continue;
      seen.add(o.slot);
      slots.push(o.slot);
    }
    for (let i = 0; i < SIM_MISSILE_COUNT && slots.length; i++) {
      simScheduleMissiles(slots[i % slots.length], t + i * 35, 1, { x: p.x, y: p.y });
    }
  } else if (type === 'mega') {
    p.brushScale = SIM_MEGA_MULT; p.brushScaleUntil = t + SIM_EFFECT_MS.mega;
  } else if (type === 'tiny') {
    p.brushScale = SIM_TINY_MULT; p.brushScaleUntil = t + SIM_EFFECT_MS.tiny;
  } else if (type === 'echo') {
    simSpawnEcho(p, t);
  } else if (type === 'erase') {
    p.castType = 'erase'; p.castUntil = t + SIM_EFFECT_MS.erase;
    for (const o of rivals) o.erasingUntil = t + SIM_EFFECT_MS.erase;
  } else if (type === 'mortar') {
    p.castType = 'missile'; p.castUntil = t + SIM_EFFECT_MS.mortar;
    simScheduleMissiles(p.slot, t, SIM_MISSILE_COUNT, null, { erase: true, r: SIM_MORTAR_CRATER_R });
  } else if (type === 'snap') {
    simHalfWipe();
  }
}

// ---- sim missiles (mirror of scheduleMissiles + makePaintSplatter) ----
function simScheduleMissiles(slot, t, count, around, opts = {}) {
  const erase = !!opts.erase;
  const r = opts.r || SIM_CRATER_R;
  const m = 60;
  for (let i = 0; i < count; i++) {
    let x, y;
    if (around) {
      const a = Math.random() * Math.PI * 2;
      const d = 35 + Math.random() * 210;
      x = Math.max(m, Math.min(G.worldW - m, around.x + Math.cos(a) * d));
      y = Math.max(m, Math.min(G.worldH - m, around.y + Math.sin(a) * d));
    } else {
      x = m + Math.random() * (G.worldW - 2 * m);
      y = m + Math.random() * (G.worldH - 2 * m);
    }
    SIM.impactQueue.push({ at: t + SIM_MISSILE_DELAY_MS + i * SIM_MISSILE_INTERVAL_MS, x: Math.round(x), y: Math.round(y), slot, erase, r });
  }
}

function simSplatterBlobs(x, y, rPx) {
  const blobs = [{ x: Math.round(x), y: Math.round(y), r: Math.round(rPx * 0.56) }];
  const droplets = 10 + Math.floor(Math.random() * 5);
  for (let i = 0; i < droplets; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = rPx * (0.18 + Math.random() * 0.95);
    blobs.push({ x: Math.round(x + Math.cos(a) * d), y: Math.round(y + Math.sin(a) * d), r: Math.max(4, Math.round(rPx * (0.08 + Math.random() * 0.19))) });
  }
  const streaks = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < streaks; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = rPx * (0.85 + Math.random() * 0.75);
    blobs.push({ x: Math.round(x + Math.cos(a) * d), y: Math.round(y + Math.sin(a) * d), r: Math.max(3, Math.round(rPx * (0.05 + Math.random() * 0.08))) });
  }
  return blobs;
}

function simProcessImpacts(t) {
  if (!SIM.impactQueue.length) return;
  const remain = [];
  for (const im of SIM.impactQueue) {
    if (t >= im.at) {
      const r = im.r || SIM_CRATER_R;
      const blobs = simSplatterBlobs(im.x, im.y, r);
      if (im.erase) {
        simClearSplatterG(blobs);           // score grid (the AI sees the holes)
        erasePaintSplatter(blobs);          // wipe the visual paint layer
      } else {
        simFillSplatterG(blobs, im.slot);   // score grid (the AI sees the craters)
        drawPaintSplatter(blobs, im.slot);  // visual paint layer
      }
      impacts.push({ x: im.x, y: im.y, r, slot: im.slot, start: nowMs });
      if (GameAudio) GameAudio.impact();
    } else {
      remain.push(im);
    }
  }
  SIM.impactQueue = remain;
}

// ---- sim snap (mirror of doHalfWipe) ----
function simHalfWipe() {
  const halves = ['left', 'right', 'top', 'bottom'];
  const dir = halves[Math.floor(Math.random() * halves.length)];
  const halfW = (G.w >> 1) * G.cell;
  const halfH = (G.h >> 1) * G.cell;
  let x = 0, y = 0, w = G.worldW, h = G.worldH;
  if (dir === 'left') w = halfW;
  else if (dir === 'right') { x = halfW; w = G.worldW - halfW; }
  else if (dir === 'top') h = halfH;
  else { y = halfH; h = G.worldH - halfH; }
  if (paintCtx) paintCtx.clearRect(x, y, w, h);
  // Score grid follows the wipe (server clears cells -> scores).
  const cx0 = (x / G.cell) | 0, cy0 = (y / G.cell) | 0;
  const cx1 = ((x + w) / G.cell) | 0, cy1 = ((y + h) / G.cell) | 0;
  for (let cy = cy0; cy < cy1; cy++) {
    for (let cx = cx0; cx < cx1; cx++) simClearCellG(cx, cy);
  }
  snapFlashes.push({ x, y, w, h, start: nowMs });
  if (GameAudio && GameAudio.snap) GameAudio.snap();
}

// ---- sim echo: the ghost twin (mirror of spawnEcho) -------------------------
// Drops one brush-width beside its OWNER (you or a bot) and mirrors that
// owner's live input each tick (see simTick) under identical physics. Renders
// translucent through the normal remote-brush path.
function simSpawnEcho(owner, t) {
  const off = BRUSH_R * 3.5;
  let ex = owner.x - off;
  let ey = owner.y - off;
  if (ex < BRUSH_R) ex = owner.x + off;
  if (ey < BRUSH_R) ey = owner.y + off;
  ex = Math.max(BRUSH_R, Math.min(G.worldW - BRUSH_R, ex));
  ey = Math.max(BRUSH_R, Math.min(G.worldH - BRUSH_R, ey));
  const e = simMakeActor(SIM_ECHO_ID, owner.slot, ex, ey);
  e.isEcho = true;
  e.ownerId = owner.id;
  e.echoExpiresAt = t + SIM_EFFECT_MS.echo;
  e.mx = owner.mx;
  e.my = owner.my;
  SIM.players.set(SIM_ECHO_ID, e);
  remote.set(SIM_ECHO_ID, simMakeRenderEntry(e));
}

function simExpireEcho(t) {
  const e = SIM.players.get(SIM_ECHO_ID);
  if (!e) return;
  if (t >= e.echoExpiresAt) {
    SIM.players.delete(SIM_ECHO_ID);
    remote.delete(SIM_ECHO_ID);
  }
}

// ---- sim toast (top-center pill; doubles as the initial controls hint) ----
function setSimToast(cls, iconCol, name, desc, note) {
  const el = els.simToast;
  if (!el) return;
  el.className = cls;                  // also clears any leftover 'hidden'
  el.innerHTML =
    (note ? `<span class="sim-toast-note">${note}</span>` : '') +   // its own line, above
    (iconCol == null ? '' : `<span class="pu-avatar" style="--pu-col: ${iconCol}"></span>`) +
    `<span class="sim-toast-text"><span class="sim-toast-name">${name}</span>` +
    `<span class="sim-toast-desc">${desc}</span></span>`;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');   // restart the pop
}

function showSimHint() {
  clearTimeout(simToastTimer);
  setSimToast('hint', null, 'WASD / arrows to move', 'Grab power-ups to learn what they do.', null);
}

function showSimToast(type, byRival = false) {
  const info = SIM_PU_INFO[type];
  if (!info) return;
  const col = POWERUP_SHEET.cols[type] !== undefined ? POWERUP_SHEET.cols[type] : 0;
  const note = byRival ? 'A rival grabbed this one.' : (info.note || null);
  setSimToast(info.bad ? 'bad' : 'boon', col, info.name, info.desc, note);
  clearTimeout(simToastTimer);
  simToastTimer = setTimeout(() => { if (els.simToast) els.simToast.classList.add('hidden'); }, SIM_TOAST_MS);
}

// Round results in the same line (no modal on the landing): outcome headline +
// your placing, crowned when you take the round. Lingers the full intermission.
function showSimResults(cls, headline, detail, crowned) {
  const el = els.simToast;
  if (!el) return;
  clearTimeout(simToastTimer);
  el.className = cls;
  el.innerHTML =
    (crowned ? '<img class="sim-result-crown" src="/assets/crown.png" alt="">' : '') +
    `<span class="sim-toast-text"><span class="sim-toast-name">${headline}</span>` +
    `<span class="sim-toast-desc">${detail}</span></span>`;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  simToastTimer = setTimeout(() => { if (els.simToast) els.simToast.classList.add('hidden'); }, SIM_INTERMISSION_MS);
}

function hideSimToast() {
  clearTimeout(simToastTimer);
  if (els.simToast) els.simToast.classList.add('hidden');
}

// ---- Boot -------------------------------------------------------------------
resize();
requestAnimationFrame(frame);
initMenu();
