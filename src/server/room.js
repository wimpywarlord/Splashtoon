'use strict';

// ---------------------------------------------------------------------------
// Room: one self-contained game instance (arena grid, players, power-ups, round
// lifecycle). The RoomManager (game.js) owns many of these and ticks them all
// from a single loop. Every room is kept topped up to MAX_PLAYERS with bots, so
// it always feels full; humans replace bots cleanly at round boundaries.
//
// This is the former createGameServer() closure, lifted into a class so it can
// be instantiated per room. Behaviour for a single human in a single room is
// identical to the old single-game server.
// ---------------------------------------------------------------------------

const { Player } = require('./player');
const { createBotAI, updateBot, pickName } = require('./bot-ai');
const {
  GRID_W,
  GRID_H,
  CELL,
  WORLD_W,
  WORLD_H,
  EMPTY,
  MAX_PLAYERS,
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
  POWERUP_SPAWN_TRIES,
  POWERUP_SPAWN_CLEAR_R,
  BOOST_MS,
  BOOST_MULT,
  SLOW_MS,
  SLOW_MULT,
  FREEZE_MS,
  INKJAM_MS,
  MEGA_BRUSH_MS,
  MEGA_BRUSH_MULT,
  TINY_BRUSH_MS,
  TINY_BRUSH_MULT,
  ERASE_MS,
  ECHO_MS,
  SELF_FREEZE_MS,
  SELF_INKJAM_MS,
  MISSILE_COUNT,
  BAD_MISSILE_COUNT,
  MISSILE_DELAY_MS,
  MISSILE_INTERVAL_MS,
  CRATER_R,
  POWERUP_TYPES,
  POWERUP_SPAWN_POOL,
  POWERUP_SWITCH_CHANCES,
  PALETTE,
  SPAWNS,
  COARSE_ZW,
  COARSE_ZH,
  BOT_COARSE_MS,
} = require('./config');

function now() {
  return Date.now();
}

// Visual paint events (for join-in-progress replay) are coalesced by distance,
// not per tick, so snapshot size is independent of the sim rate.
const VIS_STROKE_MIN = BRUSH_R * 0.75;
const VIS_STROKE_MIN2 = VIS_STROKE_MIN * VIS_STROKE_MIN;
const VIS_TRAIL_W_PER_R = 26 / BRUSH_R;

function pickWeightedPowerupType(exclude = null) {
  let type = exclude;
  for (let guard = 0; guard < 8 && type === exclude; guard++) {
    type = POWERUP_SPAWN_POOL[Math.floor(Math.random() * POWERUP_SPAWN_POOL.length)];
  }
  if (type === exclude) {
    const alts = POWERUP_TYPES.filter((t) => t !== exclude);
    type = alts[Math.floor(Math.random() * alts.length)] || exclude;
  }
  return type;
}

function pickPowerupSwitchCount() {
  let r = Math.random();
  for (const entry of POWERUP_SWITCH_CHANCES) {
    if (r < entry.weight) return entry.changes;
    r -= entry.weight;
  }
  return 0;
}

function makePowerupSwitches(spawnedAt, count) {
  if (!count) return [];
  // The type flips at random moments across the powerup's visible life rather than
  // at fixed, evenly-spaced points -- you can't anticipate the twist. Stay clear of
  // the spawn strike (early) and the expiry (late), and keep flips far enough apart
  // that each one still reads distinctly.
  const minT = 500;                        // after the spawn lightning settles
  const maxT = POWERUP_TTL_MS - 550;       // before it expires
  const minGap = 600;                      // visible separation between flips
  const times = [];
  for (let attempt = 0; attempt < 40 && times.length < count; attempt++) {
    const cand = minT + Math.random() * (maxT - minT);
    if (times.every((u) => Math.abs(u - cand) >= minGap)) times.push(cand);
  }
  while (times.length < count) {           // rare: window too tight -> space the rest out
    times.push(minT + (maxT - minT) * ((times.length + 1) / (count + 1)));
  }
  times.sort((a, b) => a - b);
  return times.map((u) => Math.round(spawnedAt + u));
}

function closestPointDist2(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0.0001) {
    const x = px - bx;
    const y = py - by;
    return x * x + y * y;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  const x = px - cx;
  const y = py - cy;
  return x * x + y * y;
}

// Clean a client-supplied display name: bound length, drop control chars and
// markup so it is safe to render and can't be confused with structure.
function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').trim();
  if (s.length > 16) s = s.slice(0, 16).trim();
  return s;
}

class Room {
  constructor(id, manager) {
    this.id = id;
    this.manager = manager;        // provides allocId()
    this.grid = new Uint8Array(GRID_W * GRID_H).fill(EMPTY);
    this.scores = new Int32Array(MAX_PLAYERS);
    this.players = new Map();
    this.changed = new Set();
    this.phase = 'intermission';   // becomes 'active' on the first startRound()
    this.phaseEndsAt = 0;
    this.lastWinnerSlot = -1;
    this.powerups = [];
    this.nextPowerupId = 1;
    this.lastSpawnAt = 0;
    this.pendingImpacts = [];
    this.visualPaintEvents = [];
    this.echoIds = new Set();
    this.emptyAt = 0;              // when the last human left (for reaping)
    // Coarse "opportunity grid" the bots steer by (rebuilt on an interval).
    this.coarseBlank = null;      // Int16Array[zones]: unpainted cells per zone
    this.coarseOwn = null;        // Int16Array[zones*MAX_PLAYERS]: owned per slot
    this.lastCoarseAt = 0;
  }

  // Summarize the grid into COARSE_ZW x COARSE_ZH zones so bots can cheaply find
  // open / contestable territory without each scanning 9000 cells. One O(grid)
  // pass per room on an interval, shared by all of the room's bots.
  recomputeCoarse() {
    const ZW = COARSE_ZW, ZH = COARSE_ZH;
    const nz = ZW * ZH;
    if (!this.coarseBlank) {
      this.coarseBlank = new Int16Array(nz);
      this.coarseOwn = new Int16Array(nz * MAX_PLAYERS);
    } else {
      this.coarseBlank.fill(0);
      this.coarseOwn.fill(0);
    }
    const zcw = GRID_W / ZW, zch = GRID_H / ZH;
    const grid = this.grid;
    for (let cy = 0; cy < GRID_H; cy++) {
      const zRow = Math.min(ZH - 1, (cy / zch) | 0) * ZW;
      const base = cy * GRID_W;
      for (let cx = 0; cx < GRID_W; cx++) {
        const v = grid[base + cx];
        const z = zRow + Math.min(ZW - 1, (cx / zcw) | 0);
        if (v === EMPTY) this.coarseBlank[z]++;
        else this.coarseOwn[z * MAX_PLAYERS + v]++;
      }
    }
  }

  // ---- population -----------------------------------------------------------
  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  freeSlots() {
    const used = new Set();
    for (const p of this.players.values()) if (p.slot >= 0) used.add(p.slot);
    const free = [];
    for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) free.push(s);
    return free;
  }

  activeCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.slot >= 0) n++;
    return n;
  }

  // Add/remove bots so (humans + bots) == MAX_PLAYERS. Called at round start so
  // a joining human's slot is freed by a bot exactly at the clean boundary.
  maintainPopulation() {
    const humans = this.humanCount();
    const bots = [];
    for (const p of this.players.values()) if (p.isBot) bots.push(p);
    const botsNeeded = Math.max(0, MAX_PLAYERS - humans);

    if (bots.length > botsNeeded) {
      const remove = bots.length - botsNeeded;
      for (let i = 0; i < remove; i++) this.players.delete(bots[i].id);
    } else if (bots.length < botsNeeded) {
      const taken = new Set();
      for (const p of this.players.values()) if (p.name) taken.add(p.name);
      for (let i = bots.length; i < botsNeeded; i++) {
        const id = this.manager.allocId();
        const b = new Player(id, null);
        b.isBot = true;
        b.name = pickName(taken);
        taken.add(b.name);
        b.ai = createBotAI();
        this.players.set(id, b);
      }
    }
  }

  placeAtSpawn(p) {
    const [sx, sy] = SPAWNS[p.slot % SPAWNS.length];
    p.x = sx;
    p.y = sy;
    p.vx = 0;
    p.vy = 0;
    p.mx = 0;
    p.my = 0;
    p.boostUntil = 0;
    p.slowUntil = 0;
    p.frozenUntil = 0;
    p.noPaintUntil = 0;
    p.erasingUntil = 0;
    p.brushScaleUntil = 0;
    p.brushScale = 1;
    p.castType = null;
    p.castUntil = 0;
    p.prevX = p.x;
    p.prevY = p.y;
    p.visAnchorX = undefined;
    p.visAnchorY = undefined;
  }

  assignSlot(p, slot) {
    p.slot = slot;
    this.placeAtSpawn(p);
  }

  spawnWaitingSpectators() {
    const free = this.freeSlots();
    if (!free.length) return;
    const waiting = [];
    for (const p of this.players.values()) if (p.slot < 0) waiting.push(p);
    waiting.sort((a, b) => (a.isBot ? 1 : 0) - (b.isBot ? 1 : 0));   // humans first
    for (const p of waiting) {
      if (!free.length) break;
      this.assignSlot(p, free.shift());
    }
  }

  // ---- painting -------------------------------------------------------------
  paintCell(cx, cy, slot) {
    if (cx < 0 || cy < 0 || cx >= GRID_W || cy >= GRID_H) return;
    const idx = cy * GRID_W + cx;
    const prev = this.grid[idx];
    if (prev === slot) return;
    if (prev !== EMPTY) this.scores[prev]--;
    this.scores[slot]++;
    this.grid[idx] = slot;
    this.changed.add(idx);
  }

  clearCell(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= GRID_W || cy >= GRID_H) return;
    const idx = cy * GRID_W + cx;
    const prev = this.grid[idx];
    if (prev === EMPTY) return;
    this.scores[prev]--;
    this.grid[idx] = EMPTY;
    this.changed.add(idx);
  }

  fillDisc(wx, wy, rPx, slot) {
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
        if (dx * dx + dy * dy <= r2) this.paintCell(cx, cy, slot);
      }
    }
  }

  clearDisc(wx, wy, rPx) {
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
        if (dx * dx + dy * dy <= r2) this.clearCell(cx, cy);
      }
    }
  }

  stampDisc(wx, wy, slot, rPx = BRUSH_R) {
    this.fillDisc(wx, wy, rPx, slot);
  }

  paintPath(px, py, cx, cy, slot, rPx = BRUSH_R) {
    const dx = cx - px;
    const dy = cy - py;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / Math.max(4, rPx / 2, STAMP_STEP)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.stampDisc(px + dx * t, py + dy * t, slot, rPx);
    }
  }

  erasePath(px, py, cx, cy, rPx = BRUSH_R) {
    const dx = cx - px;
    const dy = cy - py;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / Math.max(4, rPx / 2, STAMP_STEP)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.clearDisc(px + dx * t, py + dy * t, rPx);
    }
  }

  recordPaintStroke(px, py, cx, cy, slot, rPx = BRUSH_R, erase = false) {
    const dx = cx - px;
    const dy = cy - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < MIN_PAINT_MOVE2 || d2 >= 90 * 90) return;
    this.visualPaintEvents.push({
      t: 'stroke',
      slot,
      x1: Math.round(px),
      y1: Math.round(py),
      x2: Math.round(cx),
      y2: Math.round(cy),
      w: Math.round(rPx * VIS_TRAIL_W_PER_R),
      erase,
    });
  }

  makePaintSplatter(x, y, rPx) {
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

  fillSplatter(blobs, slot) {
    for (const b of blobs) this.fillDisc(b.x, b.y, b.r, slot);
  }

  recordPaintSplatter(blobs, slot) {
    this.visualPaintEvents.push({ t: 'splatter', slot, blobs });
  }

  // ---- simulation -----------------------------------------------------------
  brushRadius(p, t) {
    const scale = (t < p.brushScaleUntil && p.brushScale > 0) ? p.brushScale : 1;
    return BRUSH_R * scale;
  }

  brushScale(p, t) {
    return this.brushRadius(p, t) / BRUSH_R;
  }

  stepPlayer(p, dt) {
    const t = now();
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

    if (t < p.noPaintUntil) {
      p.visAnchorX = p.x;
      p.visAnchorY = p.y;
      return;
    }
    const pdx = p.x - px;
    const pdy = p.y - py;
    if (pdx * pdx + pdy * pdy < MIN_PAINT_MOVE2) return;

    // Grid paint every step (authoritative coverage). Visual replay strokes are
    // coalesced by distance so their count doesn't scale with the sim rate.
    const brushR = this.brushRadius(p, t);
    const erasing = t < p.erasingUntil;
    if (erasing) this.erasePath(px, py, p.x, p.y, brushR);
    else this.paintPath(px, py, p.x, p.y, p.slot, brushR);
    if (p.visAnchorX === undefined) { p.visAnchorX = px; p.visAnchorY = py; }
    const vdx = p.x - p.visAnchorX;
    const vdy = p.y - p.visAnchorY;
    if (vdx * vdx + vdy * vdy >= VIS_STROKE_MIN2) {
      this.recordPaintStroke(p.visAnchorX, p.visAnchorY, p.x, p.y, p.slot, brushR, erasing);
      p.visAnchorX = p.x;
      p.visAnchorY = p.y;
    }
  }

  spawnPowerup() {
    const t = now();
    const margin = 90;
    // Uniformly RANDOM spawn -- not biased toward open ground (which a player could
    // game by drifting away from the pack to farm "far from everyone" pickups). We
    // only reject spots within POWERUP_SPAWN_CLEAR_R of a player so nobody gets a
    // freebie spawned at their feet; beyond that it's pure chance, fair regardless
    // of position.
    const actives = [];
    for (const p of this.players.values()) if (p.slot >= 0) actives.push(p);
    const clearR2 = POWERUP_SPAWN_CLEAR_R * POWERUP_SPAWN_CLEAR_R;
    let px = 0, py = 0;
    for (let i = 0; i < POWERUP_SPAWN_TRIES; i++) {
      px = margin + Math.random() * (WORLD_W - 2 * margin);
      py = margin + Math.random() * (WORLD_H - 2 * margin);
      let clear = true;
      for (const p of actives) {
        const dx = p.x - px, dy = p.y - py;
        if (dx * dx + dy * dy < clearR2) { clear = false; break; }
      }
      if (clear) break;   // accept first spot clear of everyone (else keep last sampled)
    }
    const changes = pickPowerupSwitchCount();
    const type = pickWeightedPowerupType();
    this.powerups.push({
      id: this.nextPowerupId++,
      x: Math.round(px),
      y: Math.round(py),
      type,
      expiresAt: t + POWERUP_TTL_MS,
      switches: makePowerupSwitches(t, changes),
      switchIndex: 0,
    });
  }

  updatePowerupSwitches(t) {
    for (const pu of this.powerups) {
      while (pu.switches && pu.switchIndex < pu.switches.length && t >= pu.switches[pu.switchIndex]) {
        pu.type = pickWeightedPowerupType(pu.type);
        pu.switchIndex++;
      }
    }
  }

  publicPowerups() {
    return this.powerups.map((pu) => ({
      id: pu.id,
      x: pu.x,
      y: pu.y,
      type: pu.type,
      expiresAt: pu.expiresAt,
    }));
  }

  powerupHit(p, pu, reach) {
    const ax = Number.isFinite(p.prevX) ? p.prevX : p.x;
    const ay = Number.isFinite(p.prevY) ? p.prevY : p.y;
    return closestPointDist2(ax, ay, p.x, p.y, pu.x, pu.y) <= reach * reach;
  }

  opponentSlots(slot) {
    const slots = [];
    const seen = new Set();
    for (const p of this.players.values()) {
      if (p.slot < 0 || p.slot === slot || seen.has(p.slot)) continue;
      seen.add(p.slot);
      slots.push(p.slot);
    }
    return slots;
  }

  scheduleMissiles(slot, t, count = MISSILE_COUNT, around = null) {
    const m = 60;
    for (let i = 0; i < count; i++) {
      let x;
      let y;
      if (around) {
        const a = Math.random() * Math.PI * 2;
        const d = 35 + Math.random() * 210;
        x = Math.max(m, Math.min(WORLD_W - m, around.x + Math.cos(a) * d));
        y = Math.max(m, Math.min(WORLD_H - m, around.y + Math.sin(a) * d));
      } else {
        x = m + Math.random() * (WORLD_W - 2 * m);
        y = m + Math.random() * (WORLD_H - 2 * m);
      }
      this.pendingImpacts.push({
        at: t + MISSILE_DELAY_MS + i * MISSILE_INTERVAL_MS,
        x: Math.round(x),
        y: Math.round(y),
        slot,
      });
    }
  }

  spawnEcho(owner, t) {
    const margin = BRUSH_R * 4;
    const echo = new Player(this.manager.allocId(), null);
    echo.isBot = true;
    echo.isEcho = true;
    echo.ownerId = owner.id;
    echo.name = owner.name;
    echo.slot = owner.slot;
    echo.ai = createBotAI();
    echo.echoExpiresAt = t + ECHO_MS;

    let best = null;
    for (let i = 0; i < 24; i++) {
      const x = margin + Math.random() * (WORLD_W - 2 * margin);
      const y = margin + Math.random() * (WORLD_H - 2 * margin);
      const dOwner = Math.hypot(x - owner.x, y - owner.y);
      if (!best || dOwner > best.dOwner) best = { x, y, dOwner };
    }

    echo.x = Math.round(best.x);
    echo.y = Math.round(best.y);
    echo.prevX = echo.x;
    echo.prevY = echo.y;
    this.players.set(echo.id, echo);
    this.echoIds.add(echo.id);
  }

  removeExpiredEchoes(t) {
    if (!this.echoIds.size) return;
    for (const id of [...this.echoIds]) {
      const p = this.players.get(id);
      if (!p || t >= p.echoExpiresAt || p.slot < 0) {
        this.players.delete(id);
        this.echoIds.delete(id);
      }
    }
  }

  removeAllEchoes() {
    for (const id of this.echoIds) this.players.delete(id);
    this.echoIds.clear();
  }

  applyPowerup(p, type, t) {
    if (type === 'speed') {
      p.boostUntil = t + BOOST_MS;
    } else if (type === 'slow') {
      p.slowUntil = t + SLOW_MS;
    } else if (type === 'freeze') {
      p.castType = type;
      p.castUntil = t + POWERUP_EFFECT_MS;
      for (const o of this.players.values()) {
        if (o.slot < 0 || o.slot === p.slot) continue;
        o.frozenUntil = t + FREEZE_MS;
      }
    } else if (type === 'selfFreeze') {
      p.frozenUntil = t + SELF_FREEZE_MS;
    } else if (type === 'inkjam') {
      for (const o of this.players.values()) {
        if (o.slot < 0 || o.slot === p.slot) continue;
        o.noPaintUntil = t + INKJAM_MS;
      }
    } else if (type === 'selfInkjam') {
      p.noPaintUntil = t + SELF_INKJAM_MS;
    } else if (type === 'missile') {
      p.castType = type;
      p.castUntil = t + POWERUP_EFFECT_MS;
      this.scheduleMissiles(p.slot, t, MISSILE_COUNT);
    } else if (type === 'badMissile') {
      const slots = this.opponentSlots(p.slot);
      if (slots.length) {
        for (let i = 0; i < BAD_MISSILE_COUNT; i++) {
          this.scheduleMissiles(slots[i % slots.length], t + i * 35, 1, { x: p.x, y: p.y });
        }
      }
    } else if (type === 'mega') {
      p.brushScale = MEGA_BRUSH_MULT;
      p.brushScaleUntil = t + MEGA_BRUSH_MS;
    } else if (type === 'tiny') {
      p.brushScale = TINY_BRUSH_MULT;
      p.brushScaleUntil = t + TINY_BRUSH_MS;
    } else if (type === 'echo') {
      this.spawnEcho(p, t);
    } else if (type === 'erase') {
      p.castType = type;
      p.castUntil = t + ERASE_MS;
      for (const o of this.players.values()) {
        if (o.slot < 0 || o.slot === p.slot) continue;
        o.erasingUntil = t + ERASE_MS;
      }
    }
  }

  processImpacts(t) {
    if (!this.pendingImpacts.length) return;
    const remain = [];
    for (const im of this.pendingImpacts) {
      if (t >= im.at) {
        const blobs = this.makePaintSplatter(im.x, im.y, CRATER_R);
        this.fillSplatter(blobs, im.slot);
        this.recordPaintSplatter(blobs, im.slot);
        this.broadcast({ t: 'impact', x: im.x, y: im.y, slot: im.slot, r: CRATER_R, blobs });
      } else {
        remain.push(im);
      }
    }
    this.pendingImpacts = remain;
  }

  updatePowerups(t) {
    this.updatePowerupSwitches(t);
    if (this.powerups.length) {
      this.powerups = this.powerups.filter((pu) => t < pu.expiresAt);
    }
    if (this.powerups.length < POWERUP_MAX && t - this.lastSpawnAt >= POWERUP_SPAWN_MS) {
      this.spawnPowerup();
      this.lastSpawnAt = t;
    }
    const reach = POWERUP_R + BRUSH_R;
    for (const p of this.players.values()) {
      if (p.slot < 0 || p.isEcho) continue;
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const pu = this.powerups[i];
        if (this.powerupHit(p, pu, reach)) {
          this.powerups.splice(i, 1);
          this.applyPowerup(p, pu.type, t);
          this.broadcast({ t: 'pickup', id: p.id, slot: p.slot, type: pu.type, x: pu.x, y: pu.y });
        }
      }
    }
  }

  // ---- round lifecycle ------------------------------------------------------
  startRound() {
    this.removeAllEchoes();
    this.grid.fill(EMPTY);
    this.scores.fill(0);
    this.changed.clear();
    this.powerups = [];
    this.pendingImpacts = [];
    this.visualPaintEvents = [];
    this.lastSpawnAt = now();
    this.recomputeCoarse();           // fresh (all-blank) grid for round-start targeting
    this.lastCoarseAt = now();
    this.maintainPopulation();        // top up / release bots to hit MAX_PLAYERS
    this.spawnWaitingSpectators();    // seat humans first, then bots
    for (const p of this.players.values()) {
      if (p.slot >= 0) this.placeAtSpawn(p);
    }
    this.phase = 'active';
    this.phaseEndsAt = now() + ROUND_MS;
    this.broadcast(this.roundStartMsg());
  }

  endRound() {
    this.removeAllEchoes();
    let best = -1;
    let bestScore = 0;
    let tie = false;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (this.scores[s] > bestScore) {
        bestScore = this.scores[s];
        best = s;
        tie = false;
      } else if (this.scores[s] === bestScore && bestScore > 0) {
        tie = true;
      }
    }
    this.lastWinnerSlot = tie ? -1 : best;
    let winnerName = null;
    if (this.lastWinnerSlot >= 0) {
      for (const p of this.players.values()) {
        if (p.slot === this.lastWinnerSlot) { winnerName = p.name; break; }
      }
    }
    this.phase = 'intermission';
    this.phaseEndsAt = now() + INTERMISSION_MS;
    this.broadcast({
      t: 'roundover',
      scores: this.scoreArray(),
      winnerSlot: this.lastWinnerSlot,
      winnerName,
      tie,
      intermissionMs: INTERMISSION_MS,
    });
  }

  // Advance one sim step. doBroadcast gates the (lower-rate) state snapshot;
  // discrete events (impact/pickup/roundstart/roundover) always fire.
  tick(dt, doBroadcast) {
    const t = now();
    if (this.phase === 'active') {
      this.removeExpiredEchoes(t);
      if (t - this.lastCoarseAt >= BOT_COARSE_MS) { this.recomputeCoarse(); this.lastCoarseAt = t; }
      for (const p of this.players.values()) {
        if (p.slot < 0) continue;
        if (p.isBot) updateBot(p, this, dt, t);
        this.stepPlayer(p, dt);
      }
      this.updatePowerups(t);
      this.processImpacts(t);
      if (t >= this.phaseEndsAt) {
        this.endRound();
      } else if (doBroadcast) {
        this.broadcastState(Math.max(0, this.phaseEndsAt - t));
      }
    } else if (this.phase === 'intermission') {
      if (doBroadcast) this.broadcastState(0);
      if (t >= this.phaseEndsAt) this.startRound();
    }
  }

  // ---- serialization --------------------------------------------------------
  gridB64() {
    return Buffer.from(this.grid.buffer, this.grid.byteOffset, this.grid.byteLength).toString('base64');
  }

  scoreArray() {
    const out = [];
    for (let s = 0; s < MAX_PLAYERS; s++) out.push(this.scores[s]);
    return out;
  }

  playerList() {
    const out = [];
    const t = now();
    for (const p of this.players.values()) {
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
          name: p.name,                 // humans + bots look identical here
          x: Math.round(p.x),
          y: Math.round(p.y),
          boost: t < p.boostUntil,
          slow: t < p.slowUntil,
          frozen: t < p.frozenUntil,
          noPaint: t < p.noPaintUntil,
          erasing: t < p.erasingUntil,
          paintScale: this.brushScale(p, t),
          castType,
          inputActive: !!(p.mx || p.my),
        });
      }
    }
    return out;
  }

  timeLeftMs() {
    return Math.max(0, this.phaseEndsAt - now());
  }

  initMsg(p) {
    return {
      t: 'init',
      id: p.id,
      roomId: this.id,
      grid: { w: GRID_W, h: GRID_H, cell: CELL },
      palette: PALETTE,
      phase: this.phase,
      timeLeftMs: this.timeLeftMs(),
      you: { slot: p.slot, spectating: p.spectating, name: p.name },
    };
  }

  roundStartMsg() {
    return {
      t: 'roundstart',
      cells: this.gridB64(),
      players: this.playerList(),
      paintEvents: this.visualPaintEvents,
      scores: this.scoreArray(),
      powerups: this.publicPowerups(),
      timeLeftMs: this.timeLeftMs(),
      phase: this.phase,
    };
  }

  // Same payload as round start, re-tagged so the client rehydrates the paint
  // layer WITHOUT the round-reset side effects. Served on demand to a client whose
  // render loop resumed after a stall and missed the paint laid down while paused.
  paintSyncMsg() {
    const m = this.roundStartMsg();
    m.t = 'paintsync';
    return m;
  }

  // ---- messaging (bots have no socket -> never sent to) ----------------------
  send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (!p.ws) continue;
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    }
  }

  broadcastState(tLeft) {
    let deltas = null;
    if (this.changed.size) {
      deltas = new Array(this.changed.size * 2);
      let i = 0;
      for (const idx of this.changed) {
        deltas[i++] = idx;
        deltas[i++] = this.grid[idx];
      }
      this.changed.clear();
    }
    const msg = {
      t: 'state',
      players: this.playerList(),
      scores: this.scoreArray(),
      powerups: this.publicPowerups(),
      timeLeftMs: Math.round(tLeft),
      phase: this.phase,
    };
    if (deltas) msg.deltas = deltas;
    this.broadcast(msg);
  }

  // ---- connection (humans only) ---------------------------------------------
  // founding: this room was just created/claimed for this human -> seat them and
  // start a fresh round immediately (instant play). Otherwise they spectate the
  // current round and spawn next round (a bot yields a slot at the boundary).
  addHuman(p, founding) {
    this.players.set(p.id, p);
    this.emptyAt = 0;
    if (!p.name) {
      const taken = new Set();
      for (const o of this.players.values()) if (o.name) taken.add(o.name);
      p.name = pickName(taken);
    }
    const ws = p.ws;
    this.send(ws, this.initMsg(p));
    if (founding) {
      this.startRound();                    // broadcast reaches this human
    } else {
      this.send(ws, this.roundStartMsg());  // live snapshot; promoted next round
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'input') {
        const ok = (n) => n === -1 || n === 0 || n === 1;
        if (ok(msg.mx) && ok(msg.my)) {
          p.mx = msg.mx;
          p.my = msg.my;
        }
      } else if (msg.t === 'rename') {
        const nm = sanitizeName(msg.name);
        if (nm) p.name = nm;
      } else if (msg.t === 'resync') {
        // Client's render loop resumed after a stall and lost the paint laid down
        // while it was paused. Replay the authoritative visual log. Throttled per
        // player so a wedged client can't spam the (round-sized) payload.
        const t = now();
        if (t - (p.lastResyncAt || 0) < 500) return;
        p.lastResyncAt = t;
        this.send(p.ws, this.paintSyncMsg());
      }
    });

    ws.on('close', () => { this.removeHuman(p.id); });
    ws.on('error', () => {});
  }

  removeHuman(id) {
    this.players.delete(id);
    if (this.humanCount() === 0) this.emptyAt = now();
  }
}

module.exports = { Room, sanitizeName };
