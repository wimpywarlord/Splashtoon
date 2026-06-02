'use strict';

const { WebSocketServer } = require('ws');
const { Player } = require('./player');
const {
  GRID_W,
  GRID_H,
  CELL,
  WORLD_W,
  WORLD_H,
  EMPTY,
  MAX_PLAYERS,
  TICK_MS,
  MAX_SPEED,
  ACCEL,
  DAMPING_PER_SEC,
  BRUSH_R,
  STAMP_STEP,
  MIN_PAINT_MOVE2,
  ROUND_MS,
  INTERMISSION_MS,
  POWERUP_EFFECT_MS,
  POWERUP_MAX,
  POWERUP_SPAWN_MS,
  POWERUP_TTL_MS,
  POWERUP_R,
  BOOST_MS,
  BOOST_MULT,
  FREEZE_MS,
  INKJAM_MS,
  MISSILE_COUNT,
  MISSILE_DELAY_MS,
  MISSILE_INTERVAL_MS,
  CRATER_R,
  POWERUP_TYPES,
  PALETTE,
  SPAWNS,
} = require('./config');

function createGameServer(server) {
  const grid = new Uint8Array(GRID_W * GRID_H).fill(EMPTY);
  const scores = new Int32Array(MAX_PLAYERS);
  const players = new Map();
  const changed = new Set();
  const wss = new WebSocketServer({ server });

  let nextId = 1;
  let phase = 'active';
  let phaseEndsAt = 0;
  let lastWinnerSlot = -1;
  let powerups = [];
  let nextPowerupId = 1;
  let lastSpawnAt = 0;
  let pendingImpacts = [];
  let visualPaintEvents = [];
  let lastTick = now();
  let tickTimer = null;

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
    p.castType = null;
    p.castUntil = 0;
  }

  function assignSlot(p, slot) {
    p.slot = slot;
    placeAtSpawn(p);
  }

  function spawnWaitingSpectators() {
    const free = freeSlots();
    for (const p of players.values()) {
      if (p.slot < 0 && free.length) {
        assignSlot(p, free.shift());
      }
    }
  }

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

  function stampDisc(wx, wy, slot) {
    fillDisc(wx, wy, BRUSH_R, slot);
  }

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

  function recordPaintStroke(px, py, cx, cy, slot) {
    const dx = cx - px;
    const dy = cy - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < MIN_PAINT_MOVE2 || d2 >= 90 * 90) return;
    visualPaintEvents.push({
      t: 'stroke',
      slot,
      x1: Math.round(px),
      y1: Math.round(py),
      x2: Math.round(cx),
      y2: Math.round(cy),
    });
  }

  function makePaintSplatter(x, y, rPx) {
    const blobs = [{
      x: Math.round(x),
      y: Math.round(y),
      r: Math.round(rPx * 0.56),
    }];
    const droplets = 10 + Math.floor(Math.random() * 5);
    for (let i = 0; i < droplets; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = rPx * (0.18 + Math.random() * 0.95);
      const br = rPx * (0.08 + Math.random() * 0.19);
      blobs.push({
        x: Math.round(x + Math.cos(a) * d),
        y: Math.round(y + Math.sin(a) * d),
        r: Math.max(4, Math.round(br)),
      });
    }
    const streaks = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < streaks; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = rPx * (0.85 + Math.random() * 0.75);
      blobs.push({
        x: Math.round(x + Math.cos(a) * d),
        y: Math.round(y + Math.sin(a) * d),
        r: Math.max(3, Math.round(rPx * (0.05 + Math.random() * 0.08))),
      });
    }
    return blobs;
  }

  function fillSplatter(blobs, slot) {
    for (const b of blobs) fillDisc(b.x, b.y, b.r, slot);
  }

  function recordPaintSplatter(blobs, slot) {
    visualPaintEvents.push({ t: 'splatter', slot, blobs });
  }

  function stepPlayer(p, dt) {
    const t = now();
    if (t < p.frozenUntil) {
      p.vx = 0;
      p.vy = 0;
      return;
    }
    const boosted = t < p.boostUntil;
    const accel = boosted ? ACCEL * BOOST_MULT : ACCEL;
    const maxSpeed = boosted ? MAX_SPEED * BOOST_MULT : MAX_SPEED;

    if (p.mx || p.my) {
      const len = Math.hypot(p.mx, p.my);
      p.vx += (p.mx / len) * accel * dt;
      p.vy += (p.my / len) * accel * dt;
    }

    const damp = Math.exp(-DAMPING_PER_SEC * dt);
    p.vx *= damp;
    p.vy *= damp;

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

    if (p.x < BRUSH_R) { p.x = BRUSH_R; if (p.vx < 0) p.vx = 0; }
    if (p.x > WORLD_W - BRUSH_R) { p.x = WORLD_W - BRUSH_R; if (p.vx > 0) p.vx = 0; }
    if (p.y < BRUSH_R) { p.y = BRUSH_R; if (p.vy < 0) p.vy = 0; }
    if (p.y > WORLD_H - BRUSH_R) { p.y = WORLD_H - BRUSH_R; if (p.vy > 0) p.vy = 0; }

    if (t < p.noPaintUntil) return;
    const pdx = p.x - px;
    const pdy = p.y - py;
    if (pdx * pdx + pdy * pdy < MIN_PAINT_MOVE2) return;
    recordPaintStroke(px, py, p.x, p.y, p.slot);
    paintPath(px, py, p.x, p.y, p.slot);
  }

  function spawnPowerup() {
    const t = now();
    const margin = 90;
    const x = margin + Math.random() * (WORLD_W - 2 * margin);
    const y = margin + Math.random() * (WORLD_H - 2 * margin);
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    powerups.push({ id: nextPowerupId++, x: Math.round(x), y: Math.round(y), type, expiresAt: t + POWERUP_TTL_MS });
  }

  function applyPowerup(p, type, t) {
    if (type === 'speed') {
      p.boostUntil = t + BOOST_MS;
    } else if (type === 'freeze') {
      p.castType = type;
      p.castUntil = t + POWERUP_EFFECT_MS;
      for (const o of players.values()) {
        if (o.slot < 0 || o === p) continue;
        o.frozenUntil = t + FREEZE_MS;
      }
    } else if (type === 'inkjam') {
      for (const o of players.values()) {
        if (o.slot < 0 || o === p) continue;
        o.noPaintUntil = t + INKJAM_MS;
      }
    } else if (type === 'missile') {
      p.castType = type;
      p.castUntil = t + POWERUP_EFFECT_MS;
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

  function processImpacts(t) {
    if (!pendingImpacts.length) return;
    const remain = [];
    for (const im of pendingImpacts) {
      if (t >= im.at) {
        const blobs = makePaintSplatter(im.x, im.y, CRATER_R);
        fillSplatter(blobs, im.slot);
        recordPaintSplatter(blobs, im.slot);
        broadcast({ t: 'impact', x: im.x, y: im.y, slot: im.slot, r: CRATER_R, blobs });
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
    if (powerups.length < POWERUP_MAX && t - lastSpawnAt >= POWERUP_SPAWN_MS) {
      spawnPowerup();
      lastSpawnAt = t;
    }
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

  function startRound() {
    grid.fill(EMPTY);
    scores.fill(0);
    changed.clear();
    powerups = [];
    pendingImpacts = [];
    visualPaintEvents = [];
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
      broadcastState(0);
      if (t >= phaseEndsAt) startRound();
    }
  }

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
        let castType = null;
        if (t < p.castUntil) {
          castType = p.castType;
        } else if (p.castType) {
          p.castType = null;
          p.castUntil = 0;
        }
        out.push({
          id: p.id,
          slot: p.slot,
          x: Math.round(p.x),
          y: Math.round(p.y),
          boost: t < p.boostUntil,
          frozen: t < p.frozenUntil,
          noPaint: t < p.noPaintUntil,
          castType,
          inputActive: !!(p.mx || p.my),
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
      paintEvents: visualPaintEvents,
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

  function handleConnection(ws) {
    if (ws._socket && typeof ws._socket.setNoDelay === 'function') {
      ws._socket.setNoDelay(true);
    }

    const id = nextId++;
    const p = new Player(id, ws);
    players.set(id, p);

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
      startRound();
    } else if (free.length === 0) {
      console.log(`[join] id=${id} no free slot (max ${MAX_PLAYERS}); spectating`);
    }

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
      console.log(`[leave] id=${id} slot=${p.slot} (${players.size} connected)`);
    });

    ws.on('error', () => {});
  }

  function start() {
    if (tickTimer) return;
    wss.on('connection', handleConnection);
    startRound();
    tickTimer = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    wss.removeListener('connection', handleConnection);
    wss.close();
  }

  return {
    start,
    stop,
    wss,
    getSnapshot: () => ({
      phase,
      players: playerList(),
      scores: scoreArray(),
      powerups,
      timeLeftMs: timeLeftMs(),
    }),
  };
}

module.exports = { createGameServer };
