'use strict';

// ---------------------------------------------------------------------------
// Splashtoon client: render the authoritative grid, predict own movement,
// interpolate others, send 8-direction input, draw animated sprites + powerups.
// ---------------------------------------------------------------------------

const {
  MAX_SPEED,
  ACCEL,
  BOOST_MULT,
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

// Runtime intentionally uses only the base powerup row; pickup feedback is a
// clean fade-out, not a burst/expansion animation.
const powerupSheet = new Image();
let powerupReady = false;
powerupSheet.onload = () => { powerupReady = true; };
powerupSheet.src = '/assets/powerups.png';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const ARENA_BG = '#14171f';   // dark arena surface; neon paint and brushes pop against it
const CHROME_BG = '#0a0b10';  // app chrome behind/around the board (darker than the arena)
ctx.imageSmoothingEnabled = true;   // smooth sprite + paint scaling (was pixelated)

const els = {
  timer: document.getElementById('timer'),
  timerVal: document.querySelector('#timer .timer-val'),
  topbar: document.getElementById('topbar'),
  rankLeft: document.getElementById('rank-left'),
  rankRight: document.getElementById('rank-right'),
  spectate: document.getElementById('spectate'),
  results: document.getElementById('results'),
  resultTitle: document.getElementById('result-title'),
  resultList: document.getElementById('result-list'),
  nextCountdown: document.getElementById('next-countdown'),
  start: document.getElementById('start'),
  startForm: document.getElementById('start-form'),
  nameInput: document.getElementById('name-input'),
  stats: document.getElementById('stats'),
  soundToggle: document.getElementById('sound-toggle'),
  resultsMenuBtn: document.getElementById('results-menu-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsMenu: document.getElementById('settings-menu'),
  soundToggleIngame: document.getElementById('sound-toggle-ingame'),
  volSlider: document.getElementById('vol-slider'),
  musicSlider: document.getElementById('music-slider'),
  sfxSlider: document.getElementById('sfx-slider'),
};

const GameAudio = window.SplashtoonAudio;
const Store = window.SplashtoonStore;

// ---- World / game state -----------------------------------------------------
const G = {
  w: 128, h: 72, cell: 10,        // 16:9 arena (matches the server); the local
  worldW: 1280, worldH: 720,      // attract-mode sim uses this before any connect
};
// Default team colors so the local landing-page sim can render before the server
// sends the real palette on connect (these mirror the server config).
const DEFAULT_PALETTE = ['#ff4d6d', '#4dd2ff', '#ffd23f', '#7c4dff', '#3ddc84', '#ff8c42'];   // 6 slots, mirrors server PALETTE
let palette = [];
let paletteRGB = [];

let myId = null;
let mySlot = -1;
let spectating = true;
let phase = 'active';
let timeLeftMs = 90000;
let scores = [];

let myName = '';
let slotNames = {};       // slot -> display name, rebuilt from each player list
let inMenu = true;        // on the start screen (not connected to a match)
let lastTickSecond = -1;  // for one-shot countdown ticks
let lastRankAt = 0;       // throttle for the ranking-bar re-shuffle
const rankChips = new Map(); // slot -> ranking-bar chip element (persistent for FLIP)

// Other players: id -> render/target state.
const remote = new Map();

// Own predicted brush.
const me = { x: 0, y: 0, vx: 0, vy: 0, has: false, face: 1, dirAngle: 0, speed: 0, inputActive: false, boost: false, frozen: false, noPaint: false, castType: null };

// Active powerups on the board, transient render effects, and animation clock.
let powerups = [];
let impacts = [];          // meteor impact rings being animated: [{x,y,r,slot,start}]
let pickupFades = [];      // fading pickup icons: [{x,y,type,start}]
let nowMs = 0;

// Paint layer at grid resolution (1px per cell), scaled up on draw.
let paintLayer = null;
let paintCtx = null;

// Layout: borderless + full-screen. The 16:9 arena is scaled to COVER the whole
// viewport (centered; the longer axis overflows). zoom maps world px -> CSS px.
const cam = { zoom: 1, dpr: 1, cssW: 1280, cssH: 720 };

// ---- WebSocket --------------------------------------------------------------
let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = myName ? `?name=${encodeURIComponent(myName)}` : '';
  ws = new WebSocket(`${proto}://${location.host}/${params}`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  // Reconnect only while in a match; the menu has no connection at all.
  ws.onclose = () => { ws = null; if (!inMenu) setTimeout(connect, 1000); };
}

function disconnect() {
  if (ws) { try { ws.onclose = null; ws.close(); } catch (_) { /* ignore */ } ws = null; }
  remote.clear();
  me.has = false;
  spectating = true;
  scores = [];
  slotNames = {};
  powerups = [];
  clearRankBar();
}

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

function handle(msg) {
  switch (msg.t) {
    case 'init': {
      myId = msg.id;
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
      timeLeftMs = msg.timeLeftMs;
      scores = msg.scores;
      powerups = msg.powerups || [];
      impacts = [];
      pickupFades = [];
      applySnapshot(msg.cells, msg.paintEvents || []);
      applyPlayers(msg.players, true);
      resetTrailAnchors();
      hide(els.results);
      refreshOverlays();
      lastTickSecond = -1;
      if (GameAudio && !spectating) GameAudio.spawn();
      break;
    }
    case 'state': {
      phase = msg.phase;
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
      if (Array.isArray(msg.blobs)) drawPaintSplatter(msg.blobs, msg.slot);
      else drawPaintDisc(msg.x, msg.y, msg.r, msg.slot);
      impacts.push({ x: msg.x, y: msg.y, r: msg.r, slot: msg.slot, start: nowMs });
      if (GameAudio) GameAudio.impact();
      break;
    }
    case 'roundover': {
      phase = 'intermission';
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
        Store.recordResult(myPct, won);
        renderStats();
      }
      if (GameAudio) GameAudio.roundEnd(won);
      showResults(msg);
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
      me.frozen = !!pl.frozen;
      me.noPaint = !!pl.noPaint;
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
        face: 1, dirAngle: 0, speed: 0, inputActive: false, boost: false, frozen: false, noPaint: false, castType: null,
      };
      remote.set(pl.id, r);
    }
    r.slot = pl.slot;
    r.boost = !!pl.boost;
    r.frozen = !!pl.frozen;
    r.noPaint = !!pl.noPaint;
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
      paintCtx.strokeStyle = col;
      paintCtx.lineWidth = TRAIL_W;
      paintCtx.beginPath();
      paintCtx.moveTo(ev.x1, ev.y1);
      paintCtx.lineTo(ev.x2, ev.y2);
      paintCtx.stroke();
    } else if (ev.t === 'disc') {
      drawPaintDisc(ev.x, ev.y, ev.r, slot);
    } else if (ev.t === 'splatter') {
      drawPaintSplatter(ev.blobs, slot);
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
  if (me.has && !spectating) strokeSeg(me, mySlot, me.x, me.y);
  for (const r of remote.values()) strokeSeg(r, r.slot, r.rx, r.ry);
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
    paintCtx.strokeStyle = palette[slot] || '#fff';
    paintCtx.lineWidth = TRAIL_W;
    paintCtx.beginPath();
    paintCtx.moveTo(b.lastPaintX, b.lastPaintY);
    paintCtx.lineTo(cx, cy);
    paintCtx.stroke();
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

// Ignore game input while on the menu or while typing in a field (so WASD types
// the name instead of steering).
function inputBlocked(e) {
  if (inMenu) return true;
  const tag = e.target && e.target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

window.addEventListener('keydown', (e) => {
  if (inputBlocked(e)) return;
  const d = KEYMAP[e.code];
  if (d === undefined) return;
  e.preventDefault();
  if (e.repeat) return;
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

// ---- Prediction + interpolation --------------------------------------------
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
  me.inputActive = !!(mx || my);
  const accel = me.boost ? ACCEL * BOOST_MULT : ACCEL;
  const maxSpeed = me.boost ? MAX_SPEED * BOOST_MULT : MAX_SPEED;
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

  me.speed = Math.hypot(me.vx, me.vy);
  if (me.vx > FACE_EPS) me.face = 1;
  else if (me.vx < -FACE_EPS) me.face = -1;
  if (me.speed > DRIFT_EPS) me.dirAngle = Math.atan2(me.vy, me.vx);
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

function drawBrushSprite(x, y, slot, face, dirAngle, speed, isMe, boost, frozen, noPaint, castType, inputActive) {
  const col = palette[slot] || '#fff';
  const state = petState(speed, boost, frozen, noPaint, castType, inputActive);
  const pose = brushPose(state, face, dirAngle);
  const st = PET.states[state] || PET.states.idle;
  const rowSt = PET.states[pose.rowState] || st;
  const ts = getTintedSheet(slot);
  if (!ts) return;
  const drawH = spriteDrawHeight(state);
  const idleScale = drawH / PET_DRAW_H;

  // Colored ground glow (identity) + "you" ring.
  drawGroundShadow(x, y + 12, 21 * idleScale, 7 * idleScale, frozen ? 0.2 : 0.34);
  ctx.save();
  ctx.globalAlpha = frozen ? 0.22 : 0.42; ctx.fillStyle = col;
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
  ctx.save();
  ctx.globalAlpha = frozen ? 0.92 : 1;
  if (pose.directional) {
    ctx.translate(x, y);
    ctx.scale(pose.flipX, 1);
    ctx.drawImage(ts, sx, sy, PET.cellW, PET.cellH, -dw / 2, -dh * PET_ANCHOR_Y, dw, dh);
  } else {
    ctx.drawImage(ts, sx, sy, PET.cellW, PET.cellH, x - dw / 2, y - dh * PET_ANCHOR_Y, dw, dh);
  }
  ctx.restore();
}

function drawPowerupSprite(type, rowName, x, y, size, alpha = 1) {
  if (!powerupReady) return false;
  const col = POWERUP_SHEET.cols[type] !== undefined ? POWERUP_SHEET.cols[type] : POWERUP_SHEET.cols.speed;
  const row = POWERUP_SHEET.rows[rowName] !== undefined ? POWERUP_SHEET.rows[rowName] : POWERUP_SHEET.rows.active;
  const sx = col * POWERUP_SHEET.cellW;
  const sy = row * POWERUP_SHEET.cellH;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
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
  drawPowerupSprite(fx.type, 'active', fx.x, fx.y, 56, alpha);
}

function drawPowerup(pu) {
  if (!powerupReady) return;
  const bob = Math.sin(nowMs / 420 + pu.id * 1.3) * 1.5;
  const x = pu.x, y = pu.y + bob;

  drawGroundShadow(x, y + 19, 24, 8, 0.34);
  drawPowerupSprite(pu.type, 'active', x, y, 56);
}

// Board contents in WORLD coordinates (caller sets the world->device transform).
function drawBoardContent() {
  ctx.fillStyle = ARENA_BG;
  ctx.fillRect(0, 0, G.worldW, G.worldH);
  // paintLayer is supersampled (PAINT_SS x world res) for crisp trails on big
  // screens; scale it down to world coords here.
  if (paintLayer) ctx.drawImage(paintLayer, 0, 0, paintLayer.width, paintLayer.height, 0, 0, G.worldW, G.worldH);
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
}

// Brushes, depth-sorted, drawn in WORLD coordinates.
function drawActors() {
  const actors = [];
  for (const r of remote.values()) {
    actors.push({ x: r.rx, y: r.ry, slot: r.slot, face: r.face, dirAngle: r.dirAngle, speed: r.speed, inputActive: r.inputActive, isMe: false, boost: r.boost, frozen: r.frozen, noPaint: r.noPaint, castType: r.castType });
  }
  if (me.has && !spectating) {
    actors.push({ x: me.x, y: me.y, slot: mySlot, face: me.face, dirAngle: me.dirAngle, speed: me.speed, inputActive: me.inputActive, isMe: true, boost: me.boost, frozen: me.frozen, noPaint: me.noPaint, castType: me.castType });
  }
  actors.sort((a, b) => a.y - b.y);
  for (const a of actors) drawBrushSprite(a.x, a.y, a.slot, a.face, a.dirAngle, a.speed, a.isMe, a.boost, a.frozen, a.noPaint, a.castType, a.inputActive);
}

function render() {
  const dpr = cam.dpr;
  const barH = cam.barH || 0;
  const pvw = cam.cssW;
  const pvh = Math.max(1, cam.cssH - barH);   // everything below the top bar
  // In-game: a 16:9 board that fills the full height under the bar (CONTAIN, so it
  // can never exceed the width either). Every player sees the IDENTICAL whole arena
  // regardless of window shape -- a level playing field. Menu bg: COVER (full bleed).
  const z = inMenu
    ? Math.max(pvw / G.worldW, pvh / G.worldH)
    : Math.min(pvw / G.worldW, pvh / G.worldH);
  cam.zoom = z;
  const bw = G.worldW * z, bh = G.worldH * z;   // board size on screen (css px)
  const ox = (pvw - bw) / 2;
  // Flush to the bar: the board fills the height below it (bar takes the remaining
  // height up top); brush tips lean over the bar. Any side slack is chrome.
  const oy = inMenu ? (pvh - bh) / 2 : barH;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Chrome (darker than the board) fills the area under the bar so any side margin
  // reads as a framed surface rather than padding glued to the board.
  if (!inMenu) {
    ctx.fillStyle = CHROME_BG;
    ctx.fillRect(0, Math.round(barH * dpr), canvas.width, Math.round(pvh * dpr));
  }

  // Board content (paint, powerups, impacts) clipped to the board rect.
  ctx.save();
  ctx.beginPath();
  ctx.rect(Math.round(ox * dpr), Math.round(oy * dpr), Math.round(bw * dpr), Math.round(bh * dpr));
  ctx.clip();
  ctx.setTransform(z * dpr, 0, 0, z * dpr, ox * dpr, oy * dpr);
  drawBoardContent();
  ctx.restore();

  // Subtle framed-panel edge around the board so the margins look intentional.
  if (!inMenu) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 20 * dpr;
    ctx.shadowOffsetY = 5 * dpr;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect(ox * dpr + 0.5, oy * dpr + 0.5, bw * dpr - 1, bh * dpr - 1);
    ctx.restore();
  }

  // Brushes UNCLIPPED on top -> their tips can poke up over the bar.
  ctx.setTransform(z * dpr, 0, 0, z * dpr, ox * dpr, oy * dpr);
  if (inMenu) bgSim.drawBrushes(); else drawActors();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---- Landing-page background: a purely LOCAL sim (no server) -----------------
// A handful of wandering brushes painting trails, so the menu has a live game
// behind it without any connection. Reuses the real paint layer + brush sprites.
const bgSim = {
  agents: [],
  init() {
    if (!palette.length) { palette = DEFAULT_PALETTE.slice(); paletteRGB = palette.map(hexToRGB); }
    initPaintLayer();   // fresh, world-sized (cleared)
    this.agents = [];
    const n = Math.min(6, palette.length);   // attract sim mirrors the 6-player game
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      this.agents.push({
        x: BRUSH_R + Math.random() * (G.worldW - 2 * BRUSH_R),
        y: BRUSH_R + Math.random() * (G.worldH - 2 * BRUSH_R),
        slot: i,
        dirAngle: ang,
        face: Math.cos(ang) < 0 ? -1 : 1,
        baseSpeed: MAX_SPEED * (0.7 + Math.random() * 0.25),
        speed: 0,
        wanderPhase: Math.random() * Math.PI * 2,
        wanderFreq: 0.5 + Math.random() * 0.8,
        turnRate: 1.4 + Math.random() * 1.7,
        lastPaintX: undefined,
        lastPaintY: undefined,
      });
    }
  },
  update(dt) {
    if (!this.agents.length) this.init();
    const W = G.worldW, H = G.worldH;
    const margin = BRUSH_R * 7;
    for (const a of this.agents) {
      a.wanderPhase += dt * a.wanderFreq;
      a.dirAngle += Math.sin(a.wanderPhase) * a.turnRate * dt;
      // Smoothly steer away from walls (blend an inward push into the heading)
      // instead of hard-reflecting -- no jittery bouncing/scraping at the edges.
      let ax = 0, ay = 0;
      if (a.x < margin) ax += 1 - a.x / margin;
      else if (a.x > W - margin) ax -= 1 - (W - a.x) / margin;
      if (a.y < margin) ay += 1 - a.y / margin;
      else if (a.y > H - margin) ay -= 1 - (H - a.y) / margin;
      if (ax || ay) {
        a.dirAngle = Math.atan2(Math.sin(a.dirAngle) + ay * 2.2, Math.cos(a.dirAngle) + ax * 2.2);
      }
      a.x += Math.cos(a.dirAngle) * a.baseSpeed * dt;
      a.y += Math.sin(a.dirAngle) * a.baseSpeed * dt;
      a.x = Math.max(BRUSH_R, Math.min(W - BRUSH_R, a.x));   // safety clamp
      a.y = Math.max(BRUSH_R, Math.min(H - BRUSH_R, a.y));
      const c = Math.cos(a.dirAngle);
      if (c < -0.05) a.face = -1; else if (c > 0.05) a.face = 1;
      a.speed = a.baseSpeed;
      strokeSeg(a, a.slot, a.x, a.y);   // paint the trail onto the persistent layer
    }
  },
  drawBrushes() {
    const list = this.agents.slice().sort((p, q) => p.y - q.y);
    for (const a of list) {
      drawBrushSprite(a.x, a.y, a.slot, a.face, a.dirAngle, a.speed, false, false, false, false, null, true);
    }
  },
};

// ---- HUD --------------------------------------------------------------------
function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function updateHUD() {
  if (els.timerVal) els.timerVal.textContent = fmtTime(timeLeftMs);

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

function showResults(msg) {
  hide(els.spectate);
  const total = G.w * G.h;
  if (msg.tie) {
    els.resultTitle.textContent = 'TIE!';
  } else if (msg.winnerSlot === mySlot && !spectating) {
    els.resultTitle.textContent = 'YOU WIN!';
  } else if (msg.winnerSlot >= 0) {
    // textContent (not innerHTML) -> winner name needs no escaping here.
    els.resultTitle.textContent = `${msg.winnerName || ('P' + (msg.winnerSlot + 1))} WINS`;
  } else {
    els.resultTitle.textContent = 'ROUND OVER';
  }

  const rows = msg.scores
    .map((score, slot) => ({ slot, score }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  els.resultList.innerHTML = rows.map((r) => {
    const pct = ((r.score / total) * 100).toFixed(1);
    const meCls = r.slot === mySlot && !spectating ? ' me' : '';
    const name = slotNames[r.slot] || `P${r.slot + 1}`;
    return `<div class="result-row${meCls}">
      <span class="swatch" style="background:${palette[r.slot]}"></span>
      <span class="score-name" style="flex:1">${escapeHtml(name)}</span>
      <span class="score-pct">${pct}%</span>
    </div>`;
  }).join('') || '<div class="sub">Nobody painted anything!</div>';

  show(els.results);

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
  if (inMenu) {
    bgSim.update(dt);   // local attract-mode sim (no server)
  } else {
    if (gap > RESYNC_STALL_MS) requestResync();   // loop resumed after a stall -> catch up paint
    predict(dt);
    interpolateRemotes();
    paintTrails();      // accumulate smooth paint onto the persistent layer
  }
  render();
  updateHUD();
  if (GameAudio && !inMenu) {
    const lvl = (me.has && !spectating && phase === 'active') ? me.speed / MAX_SPEED : 0;
    GameAudio.movement(lvl);
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

function renderStats() {
  if (!els.stats) return;
  const s = Store ? Store.getStats() : null;
  if (!s || !s.matches) { els.stats.innerHTML = ''; return; }
  const cells = [
    ['Wins', s.wins],
    ['Best %', s.bestCoverage.toFixed(1)],
    ['Streak', s.bestStreak],
  ];
  els.stats.innerHTML = cells.map(([label, val]) =>
    `<div class="stat"><div class="stat-value">${escapeHtml(val)}</div><div class="stat-label">${label}</div></div>`
  ).join('');
}

function syncSoundUI() {
  const a = Store ? Store.getAudio() : { muted: false, volume: 0.7, musicVol: 1, sfxVol: 1 };
  const muted = GameAudio ? GameAudio.isMuted() : a.muted;
  const vol = GameAudio ? GameAudio.getVolume() : a.volume;
  const musicVol = GameAudio ? GameAudio.getMusicVolume() : a.musicVol;
  const sfxVol = GameAudio ? GameAudio.getSfxVolume() : a.sfxVol;
  if (els.soundToggle) els.soundToggle.textContent = `Sound: ${muted ? 'Off' : 'On'}`;
  if (els.soundToggleIngame) els.soundToggleIngame.textContent = muted ? 'Off' : 'On';
  if (els.volSlider) els.volSlider.value = String(Math.round(vol * 100));
  if (els.musicSlider) els.musicSlider.value = String(Math.round(musicVol * 100));
  if (els.sfxSlider) els.sfxSlider.value = String(Math.round(sfxVol * 100));
}

function toggleSound() {
  const muted = GameAudio ? !GameAudio.isMuted() : true;
  if (GameAudio) { GameAudio.unlock(); GameAudio.setMuted(muted); }
  if (Store) Store.setAudio({ muted });
  syncSoundUI();
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

function toggleSettings(force) {
  if (!els.settingsMenu || !els.settingsBtn) return;
  const open = force != null ? force : els.settingsMenu.classList.contains('hidden');
  els.settingsMenu.classList.toggle('hidden', !open);
  els.settingsBtn.setAttribute('aria-expanded', String(open));
}

// The bar collapses on the menu (canvas fills the whole screen for the attract
// sim) and reappears in-game; toggling it changes the playfield, so re-size.
function setBarVisible(v) {
  if (els.topbar) els.topbar.style.display = v ? '' : 'none';
  if (!v && els.settingsMenu) els.settingsMenu.classList.add('hidden');
  resize();
}

function initMenu() {
  inMenu = true;
  if (Store && els.nameInput) {
    const saved = Store.getName();
    if (saved) els.nameInput.value = saved;
  }
  renderStats();
  syncSoundUI();
  setBarVisible(false);
  show(els.start);
  hide(els.spectate);
  hide(els.results);
  bgSim.init();         // local attract-mode game behind the menu (NO connection)
  setTimeout(() => { if (els.nameInput) els.nameInput.focus(); }, 60);
}

function startPlay() {
  myName = (els.nameInput ? els.nameInput.value : '').trim().slice(0, 16);
  if (Store) Store.setName(myName);
  inMenu = false;
  if (GameAudio) { GameAudio.unlock(); syncSoundUI(); }   // unlock within the click gesture
  setBarVisible(true);
  hide(els.start);
  connect();            // open the connection only now
}

function leaveToMenu() {
  disconnect();         // drop the match; the menu is a purely local sim again
  if (GameAudio) GameAudio.movement(0);
  initMenu();
}

if (els.startForm) els.startForm.addEventListener('submit', (e) => { e.preventDefault(); startPlay(); });
if (els.soundToggle) els.soundToggle.addEventListener('click', toggleSound);
if (els.resultsMenuBtn) els.resultsMenuBtn.addEventListener('click', leaveToMenu);

// Settings dropdown (gear at the bar's left edge).
if (els.settingsBtn) els.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
if (els.soundToggleIngame) els.soundToggleIngame.addEventListener('click', toggleSound);
if (els.volSlider) els.volSlider.addEventListener('input', () => setVolume(Number(els.volSlider.value)));
if (els.musicSlider) els.musicSlider.addEventListener('input', () => setMusicVolume(Number(els.musicSlider.value)));
if (els.sfxSlider) els.sfxSlider.addEventListener('input', () => setSfxVolume(Number(els.sfxSlider.value)));
if (els.settingsMenu) els.settingsMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => toggleSettings(false));   // click outside closes it

// ---- Boot -------------------------------------------------------------------
resize();
requestAnimationFrame(frame);
initMenu();
