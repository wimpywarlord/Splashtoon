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
ctx.imageSmoothingEnabled = true;   // smooth sprite + paint scaling (was pixelated)

const els = {
  timer: document.getElementById('timer'),
  scoreboard: document.getElementById('scoreboard'),
  hud: document.getElementById('hud'),
  spectate: document.getElementById('spectate'),
  results: document.getElementById('results'),
  resultTitle: document.getElementById('result-title'),
  resultList: document.getElementById('result-list'),
  nextCountdown: document.getElementById('next-countdown'),
  start: document.getElementById('start'),
  startForm: document.getElementById('start-form'),
  nameInput: document.getElementById('name-input'),
  stats: document.getElementById('stats'),
  muteBtn: document.getElementById('mute-btn'),
  soundToggle: document.getElementById('sound-toggle'),
  resultsMenuBtn: document.getElementById('results-menu-btn'),
  minimap: document.getElementById('minimap'),
};

const GameAudio = window.SplashtoonAudio;
const Store = window.SplashtoonStore;

// ---- World / game state -----------------------------------------------------
const G = {
  w: 120, h: 75, cell: 10,
  worldW: 1200, worldH: 750,
};
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

// Layout: the canvas fills the viewport and the fixed 16:9 arena is drawn as an
// elevated, rounded, white-bordered "platform" inset within it (board* rect, in
// CSS px). The matte around it is the canvas background; brushes are drawn on top
// UNCLIPPED so they lean over the platform edge instead of being cut. zoom maps
// world px -> CSS px on the board.
const ARENA_VOID = '#0a0b10';
const cam = { boardX: 0, boardY: 0, boardW: 1280, boardH: 720, zoom: 1, dpr: 1, cssW: 1280, cssH: 720 };

// ---- WebSocket --------------------------------------------------------------
let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  // If we're mid-game when a reconnect lands, re-enter play; on the menu we stay
  // a spectator (the background game).
  ws.onopen = () => { if (!inMenu && myName) send({ t: 'ready', name: myName }); };
  ws.onclose = () => { ws = null; setTimeout(connect, 1000); };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
  if (state === 'idle' || state.endsWith('-idle')) return PET_IDLE_DRAW_H;
  if (state === 'drift') return PET_DRIFT_DRAW_H;
  return PET_DRAW_H;
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

function roundRectPath(c, x, y, w, h, r) {
  if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
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

  // Landing page: the game is just a full-bleed BACKGROUND -- fill the viewport
  // (cover), no platform / border / shadow / minimap.
  if (inMenu) {
    const z = Math.max(cam.cssW / G.worldW, cam.cssH / G.worldH);
    const ox = (cam.cssW - G.worldW * z) / 2;
    const oy = (cam.cssH - G.worldH * z) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = ARENA_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(z * dpr, 0, 0, z * dpr, ox * dpr, oy * dpr);
    drawBoardContent();
    drawActors();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }

  // In game: draw the arena as an elevated, rounded, white-bordered platform.
  const zoom = cam.zoom;
  const dx = Math.round(cam.boardX * dpr), dy = Math.round(cam.boardY * dpr);
  const dw = Math.round(cam.boardW * dpr), dh = Math.round(cam.boardH * dpr);
  const R = 16 * dpr;
  const worldTf = () => ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, dx, dy);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ARENA_VOID;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Elevated drop shadow under the board.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 40 * dpr;
  ctx.shadowOffsetY = 18 * dpr;
  ctx.fillStyle = '#000';
  roundRectPath(ctx, dx, dy, dw, dh, R);
  ctx.fill();
  ctx.restore();

  // Board surface, clipped to the rounded rect.
  ctx.save();
  roundRectPath(ctx, dx, dy, dw, dh, R);
  ctx.clip();
  worldTf();
  drawBoardContent();
  ctx.restore();

  // White rounded border.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = '#ffffff';
  roundRectPath(ctx, dx, dy, dw, dh, R);
  ctx.stroke();

  // Brushes on top, UNCLIPPED, so they lean over the platform edge.
  worldTf();
  drawActors();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawMinimap();
}

// Bird's-eye overview: whole arena scaled down with paint + player dots, on a
// translucent panel so it stays light over the board.
function drawMiniDot(g, x, y, color, sx, sy, r, ring) {
  g.beginPath();
  g.arc(x * sx, y * sy, r, 0, Math.PI * 2);
  g.fillStyle = color || '#fff';
  g.fill();
  if (ring) { g.lineWidth = Math.max(1, r * 0.5); g.strokeStyle = '#fff'; g.stroke(); }
}

function drawMinimap() {
  const mm = els.minimap;
  if (!mm) return;
  const g = mm._ctx || (mm._ctx = mm.getContext('2d'));
  const MW = mm.width, MH = mm.height;
  if (!MW || !MH) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, MW, MH);
  g.fillStyle = 'rgba(8, 9, 13, 0.34)';   // as transparent as stays readable
  g.fillRect(0, 0, MW, MH);

  const sx = MW / G.worldW, sy = MH / G.worldH;
  if (paintLayer) { g.imageSmoothingEnabled = true; g.globalAlpha = 0.95; g.drawImage(paintLayer, 0, 0, MW, MH); g.globalAlpha = 1; }

  const otherR = Math.max(1.5, MW * 0.013);
  const meR = Math.max(2.5, MW * 0.02);
  for (const r of remote.values()) drawMiniDot(g, r.rx, r.ry, palette[r.slot], sx, sy, otherR, false);
  if (me.has && !spectating) drawMiniDot(g, me.x, me.y, palette[mySlot], sx, sy, meR, true);
}

// ---- HUD --------------------------------------------------------------------
function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function updateHUD() {
  els.timer.textContent = fmtTime(timeLeftMs);
  els.timer.classList.toggle('urgent', phase === 'active' && timeLeftMs <= 10000);

  // One-shot countdown ticks in the final 10 seconds (driven by the displayed
  // clock so they're smooth between the 30Hz state updates).
  const secs = Math.ceil(timeLeftMs / 1000);
  if (!inMenu && phase === 'active' && secs >= 1 && secs <= 10) {
    if (secs !== lastTickSecond) { lastTickSecond = secs; if (GameAudio) GameAudio.tick(secs); }
  } else if (phase !== 'active') {
    lastTickSecond = -1;
  }

  const total = G.w * G.h;
  const rows = [];
  for (let s = 0; s < scores.length; s++) {
    const occupied = mySlot === s || [...remote.values()].some((r) => r.slot === s);
    if (scores[s] > 0 || occupied) rows.push({ slot: s, score: scores[s] });
  }
  rows.sort((a, b) => b.score - a.score);

  els.scoreboard.innerHTML = rows.map((row) => {
    const pct = ((row.score / total) * 100).toFixed(1);
    const meCls = row.slot === mySlot && !spectating ? ' me' : '';
    const name = slotNames[row.slot] || `P${row.slot + 1}`;
    return `<div class="score-row${meCls}">
      <span class="swatch" style="background:${palette[row.slot]}"></span>
      <span class="score-name">${escapeHtml(name)}</span>
      <span class="score-pct">${pct}%</span>
    </div>`;
  }).join('');
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
      <span>${pct}%</span>
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
function frame(t) {
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;
  nowMs = t;
  predict(dt);
  interpolateRemotes();
  paintTrails();   // accumulate smooth paint onto the persistent layer
  render();
  updateHUD();
  if (GameAudio && !inMenu) {
    const lvl = (me.has && !spectating && phase === 'active') ? me.speed / MAX_SPEED : 0;
    GameAudio.movement(lvl);
  }
  requestAnimationFrame(frame);
}

// ---- Layout (full-viewport canvas; 16:9 platform inset within it) ------------
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const iw = window.innerWidth, ih = window.innerHeight;
  // The board is inset by a matte big enough to (a) keep window/handle edges off
  // the board and (b) give brushes room to lean past the platform edge without
  // being clipped at the viewport boundary.
  const pad = Math.min(96, Math.max(40, Math.round(Math.min(iw, ih) * 0.06)));
  const availW = Math.max(160, iw - 2 * pad);
  const availH = Math.max(90, ih - 2 * pad);
  const aspect = G.worldW / G.worldH;
  let bw = availW, bh = bw / aspect;
  if (bh > availH) { bh = availH; bw = bh * aspect; }
  bw = Math.floor(bw); bh = Math.floor(bh);

  cam.boardW = bw;
  cam.boardH = bh;
  cam.boardX = Math.floor((iw - bw) / 2);
  cam.boardY = Math.floor((ih - bh) / 2);
  cam.zoom = bw / G.worldW;     // board is 16:9, world is 16:9 -> uniform scale
  cam.dpr = dpr;
  cam.cssW = iw;
  cam.cssH = ih;

  canvas.style.width = `${iw}px`;
  canvas.style.height = `${ih}px`;
  canvas.width = Math.round(iw * dpr);
  canvas.height = Math.round(ih * dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // HUD hugs the board (timer/leaderboard/minimap sit at the platform corners).
  els.hud.style.left = `${cam.boardX}px`;
  els.hud.style.top = `${cam.boardY}px`;
  els.hud.style.width = `${bw}px`;
  els.hud.style.height = `${bh}px`;

  // Size the minimap backing store for crisp DPR rendering.
  if (els.minimap) {
    const mw = els.minimap.clientWidth || 190;
    const mh = els.minimap.clientHeight || Math.round(mw * G.worldH / G.worldW);
    els.minimap.width = Math.round(mw * dpr);
    els.minimap.height = Math.round(mh * dpr);
  }
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
  const muted = GameAudio ? GameAudio.isMuted() : (Store ? Store.getAudio().muted : false);
  if (els.muteBtn) {
    els.muteBtn.textContent = muted ? '🔇' : '🔊';
    els.muteBtn.setAttribute('aria-pressed', String(muted));
  }
  if (els.soundToggle) els.soundToggle.textContent = `Sound: ${muted ? 'Off' : 'On'}`;
}

function toggleSound() {
  const muted = GameAudio ? !GameAudio.isMuted() : true;
  if (GameAudio) { GameAudio.unlock(); GameAudio.setMuted(muted); }
  if (Store) Store.setAudio({ muted });
  syncSoundUI();
}

// Hide the in-game HUD on the menu so the background is a clean attract-mode game.
function setHudVisible(v) { if (els.hud) els.hud.style.display = v ? '' : 'none'; }

function initMenu() {
  inMenu = true;
  if (Store && els.nameInput) {
    const saved = Store.getName();
    if (saved) els.nameInput.value = saved;
  }
  renderStats();
  syncSoundUI();
  setHudVisible(false);
  show(els.start);
  hide(els.spectate);
  hide(els.results);
  if (!ws) connect();   // open the spectator connection -> live bot game behind the menu
  setTimeout(() => { if (els.nameInput) els.nameInput.focus(); }, 60);
}

function startPlay() {
  myName = (els.nameInput ? els.nameInput.value : '').trim().slice(0, 16);
  if (Store) Store.setName(myName);
  inMenu = false;
  if (GameAudio) { GameAudio.unlock(); syncSoundUI(); }   // unlock within the click gesture
  setHudVisible(true);
  hide(els.start);
  send({ t: 'ready', name: myName });   // already connected as a spectator -> enter the game
}

function leaveToMenu() {
  inMenu = true;
  send({ t: 'unready' });               // back to spectating; stay connected for the background
  me.has = false;
  spectating = true;
  if (GameAudio) GameAudio.movement(0);
  initMenu();
}

if (els.startForm) els.startForm.addEventListener('submit', (e) => { e.preventDefault(); startPlay(); });
if (els.muteBtn) els.muteBtn.addEventListener('click', toggleSound);
if (els.soundToggle) els.soundToggle.addEventListener('click', toggleSound);
if (els.resultsMenuBtn) els.resultsMenuBtn.addEventListener('click', leaveToMenu);

// ---- Boot -------------------------------------------------------------------
resize();
requestAnimationFrame(frame);
initMenu();
