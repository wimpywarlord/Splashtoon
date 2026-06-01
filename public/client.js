'use strict';

// ---------------------------------------------------------------------------
// Splashtoon client: render the authoritative grid, predict own movement,
// interpolate others, send 8-direction input, draw animated sprites + powerups.
// ---------------------------------------------------------------------------

// Physics constants MUST mirror server.js for clean prediction.
const MAX_SPEED = 230;
const ACCEL = 2000;
const DAMPING_PER_SEC = 4.0;
const BRUSH_R = 16;
const MOVE_EPS = 14;          // speed (px/s) above which the brush plays its run cycle
const FACE_EPS = 18;          // |vx| needed to flip left/right facing (hysteresis -> no flicker)
const EMOTE_MS = 650;         // pickup celebration duration

// Animated brush-pet spritesheet: 8 cols x 9 rows, 192x208 cells; each row is one
// animation state. The pink "paint" is recolored to each player's color at load.
const PET = {
  cellW: 192, cellH: 208,
  states: {
    'idle':          { row: 0, frames: 6, rate: 150 },
    'running-right': { row: 1, frames: 8, rate: 70 },
    'running-left':  { row: 2, frames: 8, rate: 70 },
    'waving':        { row: 3, frames: 4, rate: 110 },
    'jumping':       { row: 4, frames: 5, rate: 85 },
    'failed':        { row: 5, frames: 8, rate: 90 },
    'waiting':       { row: 6, frames: 6, rate: 150 },
    'running':       { row: 7, frames: 6, rate: 75 },
    'review':        { row: 8, frames: 6, rate: 120 },
  },
};
const PET_DRAW_H = 62;         // on-screen cell height (px) — smaller brush
const PET_ANCHOR_Y = 0.62;     // fraction of the cell aligned to the brush's floor point
const TRAIL_W = 26;            // smooth paint-ribbon width (px)
const petSheet = new Image();
let petReady = false;
petSheet.onload = () => { petReady = true; };
petSheet.src = '/assets/brush-pet.webp';
const tintedSheets = {};       // slot -> recolored <canvas>

// Solid paint stamps (bold, clean ribbons like Battle Painters), one per color.
const STAMP_PX = 32;
let stamps = [];

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
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
};

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

// Other players: id -> render/target state.
const remote = new Map();

// Own predicted brush.
const me = { x: 0, y: 0, vx: 0, vy: 0, has: false, face: 1, speed: 0, boost: false, emoteUntil: 0 };

// Active powerups on the board, and a monotonic clock used for animation/emotes.
let powerups = [];
let nowMs = 0;

// Paint layer at grid resolution (1px per cell), scaled up on draw.
let paintLayer = null;
let paintCtx = null;

// ---- WebSocket --------------------------------------------------------------
let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connect, 1000);
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
      spectating = msg.you.spectating;
      phase = msg.phase;
      timeLeftMs = msg.timeLeftMs;
      initPaintLayer();
      makeStamps();
      resize();
      break;
    }
    case 'roundstart': {
      phase = msg.phase || 'active';
      timeLeftMs = msg.timeLeftMs;
      scores = msg.scores;
      powerups = msg.powerups || [];
      applySnapshot(msg.cells);
      applyPlayers(msg.players, true);
      hide(els.results);
      refreshOverlays();
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
      // Pickup celebration (wiggle + sparkles) for whoever grabbed a powerup.
      const target = msg.id === myId ? me : remote.get(msg.id);
      if (target) target.emoteUntil = nowMs + EMOTE_MS;
      break;
    }
    case 'roundover': {
      phase = 'intermission';
      scores = msg.scores;
      showResults(msg);
      break;
    }
  }
}

// ---- Players ----------------------------------------------------------------
function applyPlayers(list, snap) {
  const seen = new Set();
  let foundMe = false;

  for (const pl of list) {
    seen.add(pl.id);
    if (pl.id === myId) {
      foundMe = true;
      mySlot = pl.slot;
      me.boost = !!pl.boost;
      if (!me.has) {            // first authoritative position -> adopt it
        me.x = pl.x; me.y = pl.y; me.vx = 0; me.vy = 0; me.has = true; me.lastPaintX = undefined;
      } else if (snap) {        // round reset -> snap to spawn
        me.x = pl.x; me.y = pl.y; me.vx = 0; me.vy = 0; me.lastPaintX = undefined;
      }
      me.serverX = pl.x; me.serverY = pl.y;
      continue;
    }
    let r = remote.get(pl.id);
    if (!r) {
      r = { slot: pl.slot, rx: pl.x, ry: pl.y, tx: pl.x, ty: pl.y,
            face: 1, speed: 0, boost: false, emoteUntil: 0 };
      remote.set(pl.id, r);
    }
    r.slot = pl.slot;
    r.boost = !!pl.boost;
    // Estimate speed + left/right facing from server position deltas.
    const dx = pl.x - r.tx, dy = pl.y - r.ty;
    r.speed = snap ? 0 : Math.hypot(dx, dy) * 30;   // ~px/s at the 30Hz tick
    if (dx > 0.4) r.face = 1; else if (dx < -0.4) r.face = -1;
    r.tx = pl.x; r.ty = pl.y;
    if (snap) { r.rx = pl.x; r.ry = pl.y; r.lastPaintX = undefined; }
  }

  // Drop players no longer present.
  for (const id of remote.keys()) if (!seen.has(id)) remote.delete(id);

  // If I'm not in the active player list, I'm a spectator.
  spectating = !foundMe;
  if (spectating) me.has = false;
}

// ---- Paint layer (soft, splashy splats decoupled from the scoring grid) -----
function initPaintLayer() {
  paintLayer = document.createElement('canvas');
  paintLayer.width = G.worldW;     // world resolution -> soft edges, no upscaling blocks
  paintLayer.height = G.worldH;
  paintCtx = paintLayer.getContext('2d');
  paintCtx.imageSmoothingEnabled = true;
}

// Pre-render one SOLID, clean-edged paint stamp per palette color. Overlapping
// stamps along a brush path union into bold rounded ribbons (Battle Painters look).
function makeStamps() {
  stamps = palette.map((hex) => {
    const c = document.createElement('canvas');
    c.width = c.height = STAMP_PX;
    const g = c.getContext('2d');
    const m = STAMP_PX / 2;
    g.fillStyle = hex;
    g.beginPath(); g.arc(m, m, m - 1, 0, Math.PI * 2); g.fill();
    return c;
  });
}

function stampCell(slot, idx) {
  const img = stamps[slot];
  if (!img) return;
  const cx = idx % G.w;
  const cy = (idx - cx) / G.w;
  const wx = cx * G.cell + G.cell / 2;
  const wy = cy * G.cell + G.cell / 2;
  paintCtx.drawImage(img, wx - STAMP_PX / 2, wy - STAMP_PX / 2);
}

function applySnapshot(b64) {
  if (!paintCtx) initPaintLayer();
  if (!stamps.length) makeStamps();
  const bytes = b64ToBytes(b64);
  paintCtx.clearRect(0, 0, G.worldW, G.worldH);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 255) stampCell(bytes[i], i);
  }
}

// Paint a smooth ribbon segment under each brush, from its last painted point to
// its CURRENT on-screen position. Same position as the sprite -> always in unison,
// never leading, and continuous round-capped strokes read as flowing paint.
function paintTrails() {
  if (!paintCtx) return;
  paintCtx.lineCap = 'round';
  paintCtx.lineJoin = 'round';
  if (me.has && !spectating) strokeSeg(me, mySlot, me.x, me.y);
  for (const r of remote.values()) strokeSeg(r, r.slot, r.rx, r.ry);
}

function strokeSeg(b, slot, cx, cy) {
  if (b.lastPaintX === undefined) { b.lastPaintX = cx; b.lastPaintY = cy; return; }
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

window.addEventListener('keydown', (e) => {
  const d = KEYMAP[e.code];
  if (d === undefined) return;
  e.preventDefault();
  if (e.repeat) return;
  held.add(d);
  pushInput();
});

window.addEventListener('keyup', (e) => {
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
  const { mx, my } = currentInput();
  if (mx || my) {
    const len = Math.hypot(mx, my);   // normalize so diagonals aren't faster
    me.vx += (mx / len) * ACCEL * dt;
    me.vy += (my / len) * ACCEL * dt;
  }
  const damp = Math.exp(-DAMPING_PER_SEC * dt);
  me.vx *= damp; me.vy *= damp;
  const sp = Math.hypot(me.vx, me.vy);
  if (sp > MAX_SPEED) { const k = MAX_SPEED / sp; me.vx *= k; me.vy *= k; }

  me.x += me.vx * dt;
  me.y += me.vy * dt;
  if (me.x < BRUSH_R) { me.x = BRUSH_R; if (me.vx < 0) me.vx = 0; }
  if (me.x > G.worldW - BRUSH_R) { me.x = G.worldW - BRUSH_R; if (me.vx > 0) me.vx = 0; }
  if (me.y < BRUSH_R) { me.y = BRUSH_R; if (me.vy < 0) me.vy = 0; }
  if (me.y > G.worldH - BRUSH_R) { me.y = G.worldH - BRUSH_R; if (me.vy > 0) me.vy = 0; }

  // Gently reconcile toward the server's authoritative position.
  if (me.serverX !== undefined) {
    me.x += (me.serverX - me.x) * 0.12;
    me.y += (me.serverY - me.y) * 0.12;
  }

  me.speed = Math.hypot(me.vx, me.vy);
  if (me.vx > FACE_EPS) me.face = 1;
  else if (me.vx < -FACE_EPS) me.face = -1;
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
  const targetHue = rgbToHsl(paletteRGB[slot][0], paletteRGB[slot][1], paletteRGB[slot][2])[0];
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
      const [nr, ng, nb] = hslToRgb(targetHue, s, l);
      d[i] = nr; d[i + 1] = ng; d[i + 2] = nb;
    }
  }
  g.putImageData(img, 0, 0);
  tintedSheets[slot] = c;
  return c;
}

function petState(speed, face, emoteT) {
  if (nowMs < emoteT) return 'jumping';
  if (speed > MOVE_EPS) return face >= 0 ? 'running-right' : 'running-left';
  return 'idle';
}

// Draw an animated brush-pet sprite, recolored to the player, with glow + FX.
function drawBrushSprite(x, y, slot, face, speed, isMe, boost, emoteT) {
  const col = palette[slot] || '#fff';

  // Boost aura.
  if (boost) {
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 60);
    ctx.save();
    ctx.globalAlpha = 0.22 + 0.2 * pulse; ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(x, y + 4, 26 * (0.85 + 0.2 * pulse), 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // Colored ground glow (identity) + "you" ring.
  ctx.save();
  ctx.globalAlpha = 0.5; ctx.fillStyle = col;
  ctx.beginPath(); ctx.ellipse(x, y + 5, 17, 6.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (isMe) {
    ctx.save();
    ctx.globalAlpha = 0.95; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(x, y + 5, 19, 7.5, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  const ts = getTintedSheet(slot);
  if (!ts) {                       // still loading -> simple colored disc
    ctx.save(); ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y - 6, 12, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    return;
  }

  const st = PET.states[petState(speed, face, emoteT)];
  const frame = Math.floor(nowMs / st.rate) % st.frames;
  const sx = frame * PET.cellW, sy = st.row * PET.cellH;
  const scale = PET_DRAW_H / PET.cellH;
  let pop = 1;
  if (nowMs < emoteT) pop = 1 + 0.12 * ((emoteT - nowMs) / EMOTE_MS);
  const dw = PET.cellW * scale * pop, dh = PET.cellH * scale * pop;
  // "Painting" wobble: rock the brush around its bristle/floor point so the
  // bristles sweep side-to-side like real brushing (faster while moving).
  const amp = speed > MOVE_EPS ? 0.16 : 0.06;
  const wobble = Math.sin(nowMs / 80 + slot * 1.7) * amp;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(wobble);
  ctx.drawImage(ts, sx, sy, PET.cellW, PET.cellH, -dw / 2, -dh * PET_ANCHOR_Y, dw, dh);
  ctx.restore();

  // Pickup sparkles.
  if (nowMs < emoteT) {
    const k = (emoteT - nowMs) / EMOTE_MS;
    ctx.save(); ctx.fillStyle = '#fff';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + nowMs / 280;
      const rr = 18 + (1 - k) * 18;
      ctx.globalAlpha = k;
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * rr, y - 6 + Math.sin(a) * rr, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

function drawPowerup(pu) {
  const { x, y } = pu;
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 180);
  const r = 13 + pulse * 3;
  ctx.save();
  ctx.globalAlpha = 0.3 + 0.25 * pulse;     // glow
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.arc(x, y, r + 11, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.fillStyle = '#ffe066';                // coin
  ctx.strokeStyle = '#7a5b00'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  const s = r * 0.95;                        // lightning bolt
  ctx.fillStyle = '#4a3500';
  ctx.beginPath();
  ctx.moveTo(x + s * 0.12, y - s * 0.62);
  ctx.lineTo(x - s * 0.36, y + s * 0.08);
  ctx.lineTo(x - s * 0.02, y + s * 0.08);
  ctx.lineTo(x - s * 0.14, y + s * 0.62);
  ctx.lineTo(x + s * 0.38, y - s * 0.14);
  ctx.lineTo(x + s * 0.02, y - s * 0.14);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, G.worldW, G.worldH);
  ctx.fillStyle = '#14171f';
  ctx.fillRect(0, 0, G.worldW, G.worldH);

  if (paintLayer) ctx.drawImage(paintLayer, 0, 0);  // 1:1, world-resolution

  for (const pu of powerups) drawPowerup(pu);

  // Collect actors and depth-sort by y (lower draws on top).
  const actors = [];
  for (const r of remote.values()) {
    actors.push({ x: r.rx, y: r.ry, slot: r.slot, face: r.face, speed: r.speed, isMe: false, boost: r.boost, emoteT: r.emoteUntil });
  }
  if (me.has && !spectating) {
    actors.push({ x: me.x, y: me.y, slot: mySlot, face: me.face, speed: me.speed, isMe: true, boost: me.boost, emoteT: me.emoteUntil });
  }
  actors.sort((a, b) => a.y - b.y);
  for (const a of actors) drawBrushSprite(a.x, a.y, a.slot, a.face, a.speed, a.isMe, a.boost, a.emoteT);
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
    const name = row.slot === mySlot && !spectating ? 'You' : `P${row.slot + 1}`;
    return `<div class="score-row${meCls}">
      <span class="swatch" style="background:${palette[row.slot]}"></span>
      <span class="score-name">${name}</span>
      <span class="score-pct">${pct}%</span>
    </div>`;
  }).join('');
}

function refreshOverlays() {
  if (phase === 'active' && spectating) show(els.spectate);
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
    els.resultTitle.textContent = `P${msg.winnerSlot + 1} WINS`;
  } else {
    els.resultTitle.textContent = 'ROUND OVER';
  }

  const rows = msg.scores
    .map((score, slot) => ({ slot, score }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  els.resultList.innerHTML = rows.map((r) => {
    const pct = ((r.score / total) * 100).toFixed(1);
    const name = r.slot === mySlot && !spectating ? 'You' : `P${r.slot + 1}`;
    return `<div class="result-row">
      <span class="swatch" style="background:${palette[r.slot]}"></span>
      <span class="score-name" style="flex:1">${name}</span>
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
  requestAnimationFrame(frame);
}

// ---- Layout (letterbox) -----------------------------------------------------
function resize() {
  // Preserve aspect ratio (never squish); fit the board in the viewport, centered.
  // Shrinking the window scales the whole board down uniformly.
  const aspect = G.worldW / G.worldH;
  const vw = window.innerWidth, vh = window.innerHeight;
  let dw = vw, dh = vw / aspect;
  if (dh > vh) { dh = vh; dw = vh * aspect; }
  dw = Math.floor(dw); dh = Math.floor(dh);
  canvas.style.width = `${dw}px`;
  canvas.style.height = `${dh}px`;
  // Render at the physical pixel resolution so sprites stay crisp on retina /
  // large windows instead of being upscaled from a fixed 1200x750 buffer.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(dw * dpr);
  canvas.height = Math.round(dh * dpr);
  ctx.setTransform(canvas.width / G.worldW, 0, 0, canvas.height / G.worldH, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Anchor the HUD to the board rect so the timer/leaderboard hug the canvas.
  requestAnimationFrame(() => {
    const r = canvas.getBoundingClientRect();
    els.hud.style.left = `${r.left}px`;
    els.hud.style.top = `${r.top}px`;
    els.hud.style.width = `${r.width}px`;
    els.hud.style.height = `${r.height}px`;
  });
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

// ---- Boot -------------------------------------------------------------------
resize();
connect();
requestAnimationFrame(frame);
