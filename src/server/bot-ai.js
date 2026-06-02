'use strict';

// ---------------------------------------------------------------------------
// Bot AI: filler players that feel like fierce, competitive humans.
//
// The simulation reads intent as (mx,my) and NORMALIZES it (see stepPlayer), so
// only DIRECTION matters. Bots write a CONTINUOUS unit vector (cos/sin of an aim
// angle) turned at a capped slew rate -> smooth analog turning, indistinguishable
// from a remote human once the client estimates heading from position deltas.
//
// Decision priority each tick:
//   1. Hesitation   - rare, personality-driven coast (human imperfection).
//   2. Powerup grab - a powerup in the bot's vicinity becomes top priority after
//                     only its reaction delay (~human reaction time). Grabbing
//                     denies it to rivals and (freeze/inkjam/missile) weaponizes
//                     it against them.
//   3. Territory    - steer toward the best ZONE in the room's coarse opportunity
//                     grid. Painting over an enemy cell is a 2-point swing
//                     (they -1, you +1) vs +1 for blank, so enemy turf is valued
//                     ~2x blank, and when behind the bot gangs the LEADER's turf.
//
// Rubber-banding keys off the score leader: a losing bot reacts faster, hesitates
// less, and contests harder; a runaway leader eases off. So the better the human
// plays, the harder the field pushes back.
// ---------------------------------------------------------------------------

const {
  GRID_W,
  GRID_H,
  CELL,
  WORLD_W,
  WORLD_H,
  EMPTY,
  BRUSH_R,
  MAX_PLAYERS,
  BOT_NOTICE_R,
  COARSE_ZW,
  COARSE_ZH,
} = require('./config');

const TWO_PI = Math.PI * 2;
const TOTAL_CELLS = GRID_W * GRID_H;
const ZONE_CELLS = (GRID_W / COARSE_ZW) * (GRID_H / COARSE_ZH);
const ZONE_W_PX = WORLD_W / COARSE_ZW;
const ZONE_H_PX = WORLD_H / COARSE_ZH;

const NAME_POOL = [
  'Riley', 'Kai', 'Mara', 'Devon', 'Sora', 'Nova', 'Pip', 'Jules', 'Remy', 'Ash',
  'Wren', 'Theo', 'Luca', 'Indi', 'Zane', 'Quin', 'Maya', 'Otis', 'Cleo', 'Finn',
  'Iris', 'Beck', 'Yuki', 'Dex', 'Lola', 'Nico', 'Sage', 'Tovi', 'Ezra', 'Juno',
  'Koa', 'Vera', 'Milo', 'Rue', 'Bex', 'Hana', 'Cy', 'Wade', 'Pax', 'Lux',
  'Nori', 'Tam', 'Odette', 'Bo', 'Suri', 'Vik', 'Echo', 'Fawn', 'Gus', 'Hex',
  'Isa', 'Jett', 'Kit', 'Lior', 'Moss', 'Nyx', 'Onyx', 'Posy', 'Rio', 'Skye',
];

// Personality archetypes. Ranges [min,max] are sampled per bot. Tuned sharper
// than a casual filler so the field is genuinely competitive.
const PERSONALITIES = {
  aggressive: {
    reactMs: [80, 150], aimError: 0.06, turnRate: 7.5,
    thinkProb: 0.02, thinkMs: [100, 250], retargetMs: [450, 800],
    greed: 0.85, contest: 0.6, wanderAmp: 0.04, wanderFreq: 1.4,
  },
  balanced: {
    reactMs: [120, 220], aimError: 0.12, turnRate: 5.6,
    thinkProb: 0.06, thinkMs: [180, 380], retargetMs: [600, 1100],
    greed: 0.6, contest: 0.4, wanderAmp: 0.07, wanderFreq: 1.1,
  },
  casual: {
    reactMs: [200, 330], aimError: 0.20, turnRate: 4.1,
    thinkProb: 0.12, thinkMs: [260, 560], retargetMs: [1000, 1700],
    greed: 0.42, contest: 0.22, wanderAmp: 0.12, wanderFreq: 0.95,
  },
  wanderer: {
    reactMs: [180, 300], aimError: 0.30, turnRate: 3.4,
    thinkProb: 0.18, thinkMs: [280, 650], retargetMs: [1300, 2200],
    greed: 0.30, contest: 0.12, wanderAmp: 0.18, wanderFreq: 0.8,
  },
};
// Weighted draw: a fierce field with a little character.
const PERSONALITY_WEIGHTS = [
  ['aggressive', 0.40],
  ['balanced', 0.40],
  ['casual', 0.15],
  ['wanderer', 0.05],
];

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
// Approx standard normal (std ~1, bounded ~±3) for smooth, non-spiky noise.
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

function pickName(taken) {
  const free = NAME_POOL.filter((n) => !taken || !taken.has(n));
  if (free.length) return free[randInt(0, free.length - 1)];
  return `${NAME_POOL[randInt(0, NAME_POOL.length - 1)]}${randInt(2, 99)}`;
}

function createBotAI() {
  const kind = pickPersonalityName();
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
    wanderAmp: t.wanderAmp,
    wanderFreq: t.wanderFreq,
    noticeR: BOT_NOTICE_R * (0.7 + 0.6 * t.greed),   // greedier bots spot powerups farther
    // scratch
    aimAngle: rand(0, TWO_PI),
    aimBias: gauss() * t.aimError,
    wanderPhase: rand(0, TWO_PI),
    targetX: undefined,
    targetY: undefined,
    retargetAt: 0,
    thinkUntil: 0,
    puId: null,
    puReactAt: 0,
  };
}

// How far behind the leader this bot is, in [-1, 1]. >0 = losing (push), <0 = leading.
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

function nearestPowerup(room, p, noticeR) {
  let best = null;
  let bestD = noticeR;
  for (const pu of room.powerups) {
    const d = Math.hypot(pu.x - p.x, pu.y - p.y);
    if (d < bestD) { bestD = d; best = pu; }
  }
  return best;
}

// Choose a territory goal from the room's coarse opportunity grid. Enemy turf is
// worth ~2x blank (the 2-point overpaint swing); the leader's turf is worth even
// more when behind; a crowding penalty spreads bots out (no spawn clumping).
function chooseTerritoryTarget(p, room, ai, band) {
  const blank = room.coarseBlank;
  const own = room.coarseOwn;
  if (!blank) {                          // grid not built yet -> head to center
    ai.targetX = WORLD_W * 0.5 + gauss() * 220;
    ai.targetY = WORLD_H * 0.5 + gauss() * 160;
    return;
  }
  const ZW = COARSE_ZW, ZH = COARSE_ZH;
  const behind = Math.max(0, band);
  const leader = leaderSlotOf(room);
  // Endgame: once blank space is scarce, the only way to score is overpainting,
  // and the leader's cells are the juiciest. Everyone escalates contesting and
  // piles onto the leader as the canvas fills, regardless of their own standing.
  let painted = 0;
  for (let s = 0; s < MAX_PLAYERS; s++) painted += room.scores[s];
  const endgame = clamp(1 - (1 - painted / TOTAL_CELLS) / 0.25, 0, 1);
  const enemyW = 1.6 + ai.contest + 0.6 * behind + 1.4 * endgame;     // overpaint rivals (>= 2x blank)
  const leaderW = (leader >= 0 && leader !== p.slot) ? (0.4 + 1.0 * behind + 1.3 * endgame) : 0;

  // Player occupancy per zone -> crowding penalty so bots fan out.
  const occ = new Int8Array(ZW * ZH);
  for (const o of room.players.values()) {
    if (o.slot < 0) continue;
    const zx = Math.min(ZW - 1, (o.x / ZONE_W_PX) | 0);
    const zy = Math.min(ZH - 1, (o.y / ZONE_H_PX) | 0);
    occ[zy * ZW + zx]++;
  }
  const myZX = Math.min(ZW - 1, (p.x / ZONE_W_PX) | 0);
  const myZY = Math.min(ZH - 1, (p.y / ZONE_H_PX) | 0);

  // Track the top 3 zones; pick among them for human-like variety.
  let b1 = -Infinity, b2 = -Infinity, b3 = -Infinity;
  let x1 = p.x, y1 = p.y, x2 = p.x, y2 = p.y, x3 = p.x, y3 = p.y;
  for (let zy = 0; zy < ZH; zy++) {
    for (let zx = 0; zx < ZW; zx++) {
      const z = zy * ZW + zx;
      const b = blank[z];
      const ownC = own[z * MAX_PLAYERS + p.slot];
      const enemy = ZONE_CELLS - b - ownC;
      let value = b + enemy * enemyW - ownC * 0.7;
      // Border zones tend to get left for last (everything is farther from them);
      // a blank bonus there counteracts the central bias so edges/corners fill in.
      if (zx === 0 || zx === ZW - 1 || zy === 0 || zy === ZH - 1) value += b * 0.18;
      if (leaderW) value += own[z * MAX_PLAYERS + leader] * leaderW;
      const cxp = (zx + 0.5) * ZONE_W_PX;
      const cyp = (zy + 0.5) * ZONE_H_PX;
      const dist = Math.hypot(cxp - p.x, cyp - p.y);
      const crowd = Math.max(0, occ[z] - (zx === myZX && zy === myZY ? 1 : 0));
      // Gentler distance falloff -> bots commit to farther targets (longer, straighter
      // sweeps that also reach the edges) instead of short curving hops near the middle.
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

// Keep bots off the very boundary WITHOUT pulling them away from the edges (we
// want edges painted). Only nudge when a bot is close to a wall AND heading
// further into it; the nudge cancels the into-wall component, leaving motion
// tangential -> the bot paints ALONG the edge instead of grinding or fleeing.
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

// Local "where should I paint next" gradient: probe the fine grid in 8 directions
// and pull toward paintable cells. enemyVal weights overpainting rivals; early
// (lots of blank) it stays low so bots claim fresh space (which sticks) rather
// than fighting over contested cells, and it rises into the endgame to attack.
// This is what fills gaps: after laying a stripe, the un-painted side scores
// higher, so the bot curls back to cover it instead of streaking off.
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
      if (c === EMPTY) val += 1;                 // fresh ground: pure gain
      else if (c === p.slot) val -= 0.4;         // own paint: re-covering = zero gain, steer away
      else val += enemyVal;                      // rival paint: overpaint swing (scales late/behind)
    }
    if (n) { const w = val / n; vx += dx * w; vy += dy * w; }
  }
  return { vx, vy };
}

// Push away from nearby rivals so bots keep spacing while claiming territory
// (paint too close to a rival and they just overpaint it back).
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

function updateBot(p, room, dt, t) {
  const ai = p.ai;
  if (!ai) { p.mx = 0; p.my = 0; return; }

  // 1. Hesitation: coast (zero input -> damping eases to a stop).
  if (t < ai.thinkUntil) { p.mx = 0; p.my = 0; return; }

  const band = rubberBand(room, p);

  // 2. Powerup priority: a powerup in range is grabbed after the reaction delay.
  let urgent = false;
  const pu = nearestPowerup(room, p, ai.noticeR);
  if (pu) {
    if (ai.puId !== pu.id) { ai.puId = pu.id; ai.puReactAt = t + rand(ai.reactMs[0], ai.reactMs[1]); }
    if (t >= ai.puReactAt) { ai.targetX = pu.x; ai.targetY = pu.y; urgent = true; }
  } else if (ai.puId !== null) {
    ai.puId = null;            // it was taken / expired -> resume territory now
    ai.retargetAt = 0;
  }

  // 3. Territory (only when not chasing a powerup).
  if (!urgent) {
    if (ai.targetX === undefined || t >= ai.retargetAt) {
      let interval = rand(ai.retargetMs[0], ai.retargetMs[1]);
      if (band > 0) interval *= (1 - 0.45 * band);            // losing -> re-plan sooner
      else interval *= (1 + 0.4 * -band);                     // leading -> dawdle
      ai.retargetAt = t + interval;
      const pauseProb = ai.thinkProb * (1 - 0.7 * Math.max(0, band));
      if (Math.random() < pauseProb) ai.thinkUntil = t + rand(ai.thinkMs[0], ai.thinkMs[1]);
      chooseTerritoryTarget(p, room, ai, band);
    }
    // Reached the goal -> re-plan promptly so the bot keeps sweeping, not idling.
    const dx0 = ai.targetX - p.x, dy0 = ai.targetY - p.y;
    if (dx0 * dx0 + dy0 * dy0 < (BRUSH_R * 2.5) * (BRUSH_R * 2.5)) {
      ai.retargetAt = Math.min(ai.retargetAt, t + 100);
    }
  }

  // 4. Steer (slew-limited -> always human-smooth).
  ai.wanderPhase += dt * ai.wanderFreq;
  let desired;
  if (urgent) {
    desired = Math.atan2(ai.targetY - p.y, ai.targetX - p.x) + Math.sin(ai.wanderPhase) * (ai.wanderAmp * 0.25);
  } else {
    // Blend global zone target + local paint-field + momentum + rival spacing.
    let painted = 0;
    for (let s = 0; s < MAX_PLAYERS; s++) painted += room.scores[s];
    const attack = clamp(1 - (1 - painted / TOTAL_CELLS) / 0.25, 0, 1);   // endgame ramp
    const enemyVal = 0.15 + 1.9 * Math.max(attack, 0.6 * Math.max(0, band));
    const field = paintField(room, p, enemyVal);
    const tAng = Math.atan2(ai.targetY - p.y, ai.targetX - p.x);
    let dvx = Math.cos(tAng) * 0.45 + field.vx * 1.2 + Math.cos(ai.aimAngle) * 0.55;
    let dvy = Math.sin(tAng) * 0.45 + field.vy * 1.2 + Math.sin(ai.aimAngle) * 0.55;
    // Spacing from rivals while claiming; fades out as the game turns to attack.
    const spaceW = 0.9 * (1 - attack) * (1 - 0.5 * Math.max(0, band));
    if (spaceW > 0.05) {
      const rep = rivalRepel(room, p);
      dvx += rep.vx * spaceW;
      dvy += rep.vy * spaceW;
    }
    desired = Math.atan2(dvy, dvx) + Math.sin(ai.wanderPhase) * ai.wanderAmp + ai.aimBias;
  }
  desired = avoidEdges(p, desired);

  const turn = ai.turnRate * (urgent ? 1.5 : 1) * (1 + 0.3 * Math.max(0, band));
  ai.aimAngle = stepAngle(ai.aimAngle, desired, turn * dt);
  p.mx = Math.cos(ai.aimAngle);
  p.my = Math.sin(ai.aimAngle);
}

module.exports = { createBotAI, updateBot, pickName, NAME_POOL };
