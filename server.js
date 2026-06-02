'use strict';

/*
 * Splashtoon — authoritative game server.
 *
 * Serves the static client from ./public and runs a 30Hz authoritative game
 * loop over a shared grid. Clients only send input; the server owns positions,
 * the grid, and scores. See cheerful-skipping-dongarra plan for design notes.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ----------------------------------------------------------------------------
// Tunables (everything balance-related lives here)
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3015;

const GRID_W = 120;
const GRID_H = 75;
const CELL = 10;                 // px per cell -> 1200x750 internal canvas
const WORLD_W = GRID_W * CELL;
const WORLD_H = GRID_H * CELL;
const EMPTY = 255;               // grid byte for an unpainted cell

const MAX_PLAYERS = 8;
const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;

// Movement (momentum / drift). Input applies acceleration along one cardinal
// axis; velocity is retained and damped each tick -> coast + arc-on-turn.
const MAX_SPEED = 230;           // px/s
const ACCEL = 2000;              // px/s^2
const DAMPING_PER_SEC = 4.0;     // higher = snappier stop, less drift

const BRUSH_R = 16;              // px paint radius
const STAMP_STEP = BRUSH_R / 2;  // segment stamp spacing to avoid gaps at speed

const ROUND_MS = 120_000;
const INTERMISSION_MS = 10_000;

// Powerups.
const POWERUP_MAX = 2;            // max simultaneous pickups on the board
const POWERUP_SPAWN_MS = 13_000;  // interval between spawn attempts
const POWERUP_TTL_MS = 6_000;     // unclaimed pickup lifetime
const POWERUP_R = 18;            // pickup half-size (px)
const BOOST_MS = 5_000;          // speed boost duration
const BOOST_MULT = 1.8;          // multiplier on MAX_SPEED and ACCEL while boosted
const FREEZE_MS = 1_800;         // how long rivals are frozen in place
const INKJAM_MS = 3_500;         // how long rivals can't lay paint

// Missile shower: grabbing it rains craters of YOUR paint at random spots.
const MISSILE_COUNT = 9;
const MISSILE_DELAY_MS = 250;    // delay before the first impact
const MISSILE_INTERVAL_MS = 110; // stagger between impacts
const CRATER_R = 36;             // crater paint radius (px)

// Battle Painters items (speed / freeze / inkjam) + a missile-shower extra.
const POWERUP_TYPES = ['speed', 'freeze', 'inkjam', 'missile'];

// 8 distinct, high-contrast brush colors indexed by slot.
const PALETTE = [
  '#ff4d6d', // red/pink
  '#4dd2ff', // cyan
  '#ffd23f', // yellow
  '#7c4dff', // violet
  '#3ddc84', // green
  '#ff8c42', // orange
  '#ff6fd8', // magenta
  '#5b8cff', // blue
];

// Spawn points spread across the world (used in order as slots fill).
const SPAWNS = [
  [WORLD_W * 0.15, WORLD_H * 0.2],
  [WORLD_W * 0.85, WORLD_H * 0.8],
  [WORLD_W * 0.85, WORLD_H * 0.2],
  [WORLD_W * 0.15, WORLD_H * 0.8],
  [WORLD_W * 0.5, WORLD_H * 0.15],
  [WORLD_W * 0.5, WORLD_H * 0.85],
  [WORLD_W * 0.15, WORLD_H * 0.5],
  [WORLD_W * 0.85, WORLD_H * 0.5],
];

// ----------------------------------------------------------------------------
// Game state
// ----------------------------------------------------------------------------
const grid = new Uint8Array(GRID_W * GRID_H).fill(EMPTY);
const scores = new Int32Array(MAX_PLAYERS); // cell count per slot

/** @type {Map<number, Player>} id -> player */
const players = new Map();
let nextId = 1;

const changed = new Set(); // cell indices changed since last broadcast

let phase = 'active';      // 'active' | 'intermission'
let phaseEndsAt = 0;       // server timestamp (ms) when phase ends
let lastWinnerSlot = -1;

let powerups = [];         // [{id, x, y, type}]
let nextPowerupId = 1;
let lastSpawnAt = 0;
let pendingImpacts = [];   // queued missile-shower craters: [{at, x, y, slot}]

class Player {
  constructor(id, ws) {
    this.id = id;
    this.ws = ws;
    this.slot = -1;        // -1 == spectator (no color, not painting)
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.mx = 0;           // held move vector (each axis -1/0/1; diagonals allowed)
    this.my = 0;
    this.boostUntil = 0;   // server-time (ms) the speed boost expires
    this.frozenUntil = 0;  // can't move while frozen (rival grabbed Freeze)
    this.noPaintUntil = 0; // can't paint while ink-jammed (rival grabbed Ink Jam)
    this.alive = true;
  }
  get spectating() {
    return this.slot < 0;
  }
}

// ----------------------------------------------------------------------------
// Slot / spawn management
// ----------------------------------------------------------------------------
function freeSlots() {
  const used = new Set();
  for (const p of players.values()) if (p.slot >= 0) used.add(p.slot);
  const free = [];
  for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) free.push(s);
  return free;
}

function activeCount() {
  let n = 0;
  for (const p of players.values()) if (p.slot >= 0) n++;
  return n;
}

function placeAtSpawn(p) {
  const [sx, sy] = SPAWNS[p.slot % SPAWNS.length];
  p.x = sx;
  p.y = sy;
  p.vx = 0;
  p.vy = 0;
  p.mx = 0;
  p.my = 0;
  p.boostUntil = 0;
  p.frozenUntil = 0;
  p.noPaintUntil = 0;
}

function assignSlot(p, slot) {
  p.slot = slot;
  placeAtSpawn(p);
}

// Spectators waiting for a slot get spawned in (called at round start).
function spawnWaitingSpectators() {
  const free = freeSlots();
  for (const p of players.values()) {
    if (p.slot < 0 && free.length) {
      assignSlot(p, free.shift());
    }
  }
}

// ----------------------------------------------------------------------------
// Painting
// ----------------------------------------------------------------------------
function paintCell(cx, cy, slot) {
  if (cx < 0 || cy < 0 || cx >= GRID_W || cy >= GRID_H) return;
  const idx = cy * GRID_W + cx;
  const prev = grid[idx];
  if (prev === slot) return;
  if (prev !== EMPTY) scores[prev]--;
  scores[slot]++;
  grid[idx] = slot;
  changed.add(idx);
}

// Paint a filled disc of cells (radius rPx) centered at world coords (wx, wy).
function fillDisc(wx, wy, rPx, slot) {
  const ccx = wx / CELL;
  const ccy = wy / CELL;
  const rc = rPx / CELL;
  const r2 = rc * rc;
  const minX = Math.floor(ccx - rc);
  const maxX = Math.ceil(ccx + rc);
  const minY = Math.floor(ccy - rc);
  const maxY = Math.ceil(ccy + rc);
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const dx = cx + 0.5 - ccx;
      const dy = cy + 0.5 - ccy;
      if (dx * dx + dy * dy <= r2) paintCell(cx, cy, slot);
    }
  }
}

// The brush stamps a disc of radius BRUSH_R as it moves.
function stampDisc(wx, wy, slot) {
  fillDisc(wx, wy, BRUSH_R, slot);
}

// Stamp along the segment prev->cur so fast movement leaves no gaps.
function paintPath(px, py, cx, cy, slot) {
  const dx = cx - px;
  const dy = cy - py;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / STAMP_STEP));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stampDisc(px + dx * t, py + dy * t, slot);
  }
}

// ----------------------------------------------------------------------------
// Physics
// ----------------------------------------------------------------------------
function stepPlayer(p, dt) {
  const t = now();
  if (t < p.frozenUntil) { p.vx = 0; p.vy = 0; return; }  // frozen: no move, no paint
  const boosted = t < p.boostUntil;
  const accel = boosted ? ACCEL * BOOST_MULT : ACCEL;
  const maxSpeed = boosted ? MAX_SPEED * BOOST_MULT : MAX_SPEED;

  // Acceleration along the held move vector. Normalize so a diagonal push
  // isn't sqrt(2) stronger than a straight one.
  if (p.mx || p.my) {
    const len = Math.hypot(p.mx, p.my);
    p.vx += (p.mx / len) * accel * dt;
    p.vy += (p.my / len) * accel * dt;
  }

  // Exponential damping -> smooth coast / stop.
  const damp = Math.exp(-DAMPING_PER_SEC * dt);
  p.vx *= damp;
  p.vy *= damp;

  // Clamp speed.
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > maxSpeed) {
    const k = maxSpeed / sp;
    p.vx *= k;
    p.vy *= k;
  }

  const px = p.x;
  const py = p.y;
  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // Walls: clamp and kill the velocity component going into the wall.
  if (p.x < BRUSH_R) { p.x = BRUSH_R; if (p.vx < 0) p.vx = 0; }
  if (p.x > WORLD_W - BRUSH_R) { p.x = WORLD_W - BRUSH_R; if (p.vx > 0) p.vx = 0; }
  if (p.y < BRUSH_R) { p.y = BRUSH_R; if (p.vy < 0) p.vy = 0; }
  if (p.y > WORLD_H - BRUSH_R) { p.y = WORLD_H - BRUSH_R; if (p.vy > 0) p.vy = 0; }

  if (t < p.noPaintUntil) return;   // ink-jammed: moves but lays no paint
  paintPath(px, py, p.x, p.y, p.slot);
}

// ----------------------------------------------------------------------------
// Powerups
// ----------------------------------------------------------------------------
function spawnPowerup() {
  const t = now();
  const margin = 90;
  const x = margin + Math.random() * (WORLD_W - 2 * margin);
  const y = margin + Math.random() * (WORLD_H - 2 * margin);
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  powerups.push({ id: nextPowerupId++, x: Math.round(x), y: Math.round(y), type, expiresAt: t + POWERUP_TTL_MS });
}

// Apply a grabbed powerup. Speed buffs the grabber; freeze/inkjam debuff rivals.
function applyPowerup(p, type, t) {
  if (type === 'speed') {
    p.boostUntil = t + BOOST_MS;
  } else if (type === 'freeze' || type === 'inkjam') {
    for (const o of players.values()) {
      if (o.slot < 0 || o === p) continue;
      if (type === 'freeze') o.frozenUntil = t + FREEZE_MS;
      else o.noPaintUntil = t + INKJAM_MS;
    }
  } else if (type === 'missile') {
    const m = 60;
    for (let i = 0; i < MISSILE_COUNT; i++) {
      pendingImpacts.push({
        at: t + MISSILE_DELAY_MS + i * MISSILE_INTERVAL_MS,
        x: Math.round(m + Math.random() * (WORLD_W - 2 * m)),
        y: Math.round(m + Math.random() * (WORLD_H - 2 * m)),
        slot: p.slot,
      });
    }
  }
}

// Land any missile craters whose time has come (paints + broadcasts each impact).
function processImpacts(t) {
  if (!pendingImpacts.length) return;
  const remain = [];
  for (const im of pendingImpacts) {
    if (t >= im.at) {
      fillDisc(im.x, im.y, CRATER_R, im.slot);
      broadcast({ t: 'impact', x: im.x, y: im.y, slot: im.slot, r: CRATER_R });
    } else {
      remain.push(im);
    }
  }
  pendingImpacts = remain;
}

function updatePowerups(t) {
  if (powerups.length) {
    powerups = powerups.filter((pu) => t < pu.expiresAt);
  }
  // Spawn up to the cap on a fixed cadence.
  if (powerups.length < POWERUP_MAX && t - lastSpawnAt >= POWERUP_SPAWN_MS) {
    spawnPowerup();
    lastSpawnAt = t;
  }
  // Pickups: an active player overlapping a powerup grabs it.
  const reach = POWERUP_R + BRUSH_R;
  for (const p of players.values()) {
    if (p.slot < 0) continue;
    for (let i = powerups.length - 1; i >= 0; i--) {
      const pu = powerups[i];
      if (Math.hypot(p.x - pu.x, p.y - pu.y) <= reach) {
        powerups.splice(i, 1);
        applyPowerup(p, pu.type, t);
        broadcast({ t: 'pickup', id: p.id, slot: p.slot, type: pu.type, x: pu.x, y: pu.y });
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Round lifecycle
// ----------------------------------------------------------------------------
function startRound() {
  grid.fill(EMPTY);
  scores.fill(0);
  changed.clear();
  powerups = [];
  pendingImpacts = [];
  lastSpawnAt = now();
  spawnWaitingSpectators();
  for (const p of players.values()) {
    if (p.slot >= 0) placeAtSpawn(p);
  }
  phase = 'active';
  phaseEndsAt = now() + ROUND_MS;
  broadcast(roundStartMsg());
}

function endRound() {
  // Winner = highest score among slots that scored. Tie -> -1.
  let best = -1;
  let bestScore = 0;
  let tie = false;
  for (let s = 0; s < MAX_PLAYERS; s++) {
    if (scores[s] > bestScore) {
      bestScore = scores[s];
      best = s;
      tie = false;
    } else if (scores[s] === bestScore && bestScore > 0) {
      tie = true;
    }
  }
  lastWinnerSlot = tie ? -1 : best;
  phase = 'intermission';
  phaseEndsAt = now() + INTERMISSION_MS;
  broadcast({
    t: 'roundover',
    scores: scoreArray(),
    winnerSlot: lastWinnerSlot,
    tie,
    intermissionMs: INTERMISSION_MS,
  });
}

// ----------------------------------------------------------------------------
// Tick loop
// ----------------------------------------------------------------------------
let lastTick = now();

function tick() {
  const t = now();
  const dt = Math.min(0.1, (t - lastTick) / 1000);
  lastTick = t;

  if (phase === 'active') {
    for (const p of players.values()) {
      if (p.slot >= 0) stepPlayer(p, dt);
    }
    updatePowerups(t);
    processImpacts(t);
    if (t >= phaseEndsAt) {
      endRound();
    } else {
      broadcastState(Math.max(0, phaseEndsAt - t));
    }
  } else if (phase === 'intermission') {
    // Frozen board; just tell clients the countdown, then restart.
    broadcastState(0);
    if (t >= phaseEndsAt) startRound();
  }
}

// ----------------------------------------------------------------------------
// Messaging
// ----------------------------------------------------------------------------
function now() {
  return Date.now();
}

function gridB64() {
  return Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength).toString('base64');
}

function scoreArray() {
  const out = [];
  for (let s = 0; s < MAX_PLAYERS; s++) out.push(scores[s]);
  return out;
}

function playerList() {
  const out = [];
  const t = now();
  for (const p of players.values()) {
    if (p.slot >= 0) {
      out.push({
        id: p.id,
        slot: p.slot,
        x: Math.round(p.x),
        y: Math.round(p.y),
        boost: t < p.boostUntil,
        frozen: t < p.frozenUntil,
        noPaint: t < p.noPaintUntil,
      });
    }
  }
  return out;
}

function timeLeftMs() {
  return Math.max(0, phaseEndsAt - now());
}

function roundStartMsg() {
  return {
    t: 'roundstart',
    cells: gridB64(),
    players: playerList(),
    scores: scoreArray(),
    powerups,
    timeLeftMs: timeLeftMs(),
    phase,
  };
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

function broadcastState(tLeft) {
  // Flatten changed cells into [idx, slot, idx, slot, ...].
  let deltas = null;
  if (changed.size) {
    deltas = new Array(changed.size * 2);
    let i = 0;
    for (const idx of changed) {
      deltas[i++] = idx;
      deltas[i++] = grid[idx];
    }
    changed.clear();
  }
  const msg = {
    t: 'state',
    players: playerList(),
    scores: scoreArray(),
    powerups,
    timeLeftMs: Math.round(tLeft),
    phase,
  };
  if (deltas) msg.deltas = deltas;
  broadcast(msg);
}

// ----------------------------------------------------------------------------
// HTTP static server
// ----------------------------------------------------------------------------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent path traversal.
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ----------------------------------------------------------------------------
// WebSocket server
// ----------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = nextId++;
  const p = new Player(id, ws);
  players.set(id, p);

  // New connections are spectators until the next round (per design). If a
  // slot is free AND we're between rounds, they'll be spawned at startRound.
  // During an active round they always spectate until it ends.
  // Send init FIRST so the client builds its paint layer before any board
  // snapshot (a startRound() below would otherwise broadcast roundstart early).
  send(ws, {
    t: 'init',
    id,
    grid: { w: GRID_W, h: GRID_H, cell: CELL },
    palette: PALETTE,
    phase,
    timeLeftMs: timeLeftMs(),
    you: { slot: p.slot, spectating: p.spectating },
  });

  const free = freeSlots();
  if (phase === 'intermission' && free.length) {
    assignSlot(p, free[0]);
  } else if (phase === 'active' && activeCount() === 0) {
    // Empty/idle board (e.g. fresh boot or everyone left): no live game to be
    // fair to, so give the newcomer a fresh full round instead of a 90s wait.
    startRound();
  } else if (free.length === 0) {
    console.log(`[join] id=${id} no free slot (max ${MAX_PLAYERS}); spectating`);
  }

  // Give the newcomer the current board (with their slot reflected if spawned).
  send(ws, roundStartMsg());

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'input') {
      const ok = (n) => n === -1 || n === 0 || n === 1;
      if (ok(msg.mx) && ok(msg.my)) {
        p.mx = msg.mx;
        p.my = msg.my;
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    // Their painted territory stays on the board until overpainted.
    console.log(`[leave] id=${id} slot=${p.slot} (${players.size} connected)`);
  });

  ws.on('error', () => {});
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Splashtoon running at http://localhost:${PORT}`);
  console.log(`Grid ${GRID_W}x${GRID_H} @ ${CELL}px  |  ${TICK_HZ}Hz  |  round ${ROUND_MS / 1000}s`);
});

// Kick off the first round and the loop.
startRound();
setInterval(tick, TICK_MS);
