'use strict';

// ---------------------------------------------------------------------------
// Bot AI: make filler players feel like humans, not robots.
//
// The simulation reads each player's intent as (mx,my) and NORMALIZES it
// (see stepPlayer), so only the DIRECTION matters. Humans send {-1,0,1} per
// axis; bots instead write a CONTINUOUS unit vector (cos/sin of an aim angle),
// which we turn with a capped slew rate. That single fact buys us smooth analog
// turning a human keyboard player roughly has via SOCD + momentum, and makes
// bot motion indistinguishable from a remote human after the client estimates
// heading from position deltas.
//
// Layered on top: reaction latency (notice opportunities late), a slowly
// drifting aim bias + gentle wander (imperfect, non-jittery aim), occasional
// "thinking" pauses (coast to a stop), softmax-ish target choice (not greedy),
// edge avoidance (no wall-grinding tell), and rubber-banding to the score
// leader (try harder when losing, ease off when running away with it).
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
} = require('./config');

const TWO_PI = Math.PI * 2;
const TOTAL_CELLS = GRID_W * GRID_H;

// Human-ish handles. Bots draw a name not already taken in their room; the
// client renders these identically to human names, with no bot marker.
const NAME_POOL = [
  'Riley', 'Kai', 'Mara', 'Devon', 'Sora', 'Nova', 'Pip', 'Jules', 'Remy', 'Ash',
  'Wren', 'Theo', 'Luca', 'Indi', 'Zane', 'Quin', 'Maya', 'Otis', 'Cleo', 'Finn',
  'Iris', 'Beck', 'Yuki', 'Dex', 'Lola', 'Nico', 'Sage', 'Tovi', 'Ezra', 'Juno',
  'Koa', 'Vera', 'Milo', 'Rue', 'Bex', 'Hana', 'Cy', 'Wade', 'Pax', 'Lux',
  'Nori', 'Tam', 'Odette', 'Bo', 'Suri', 'Vik', 'Echo', 'Fawn', 'Gus', 'Hex',
  'Isa', 'Jett', 'Kit', 'Lior', 'Moss', 'Nyx', 'Onyx', 'Posy', 'Rio', 'Skye',
];

// Personality archetypes. Ranges are [min,max] sampled per bot. These shape the
// FEEL: aggressive bots react fast, aim true, turn sharp, rarely pause; casual /
// wanderer bots are slower, sloppier, and meander.
const PERSONALITIES = {
  aggressive: {
    reactMs: [90, 170], aimError: 0.08, turnRate: 7.0,
    thinkProb: 0.05, thinkMs: [120, 300], retargetMs: [500, 950],
    greed: 0.70, contest: 0.40, wanderAmp: 0.10, wanderFreq: 1.6,
  },
  balanced: {
    reactMs: [140, 250], aimError: 0.15, turnRate: 5.2,
    thinkProb: 0.12, thinkMs: [200, 450], retargetMs: [800, 1500],
    greed: 0.50, contest: 0.24, wanderAmp: 0.16, wanderFreq: 1.2,
  },
  casual: {
    reactMs: [230, 380], aimError: 0.26, turnRate: 3.6,
    thinkProb: 0.20, thinkMs: [300, 700], retargetMs: [1200, 2200],
    greed: 0.35, contest: 0.14, wanderAmp: 0.24, wanderFreq: 0.9,
  },
  wanderer: {
    reactMs: [200, 340], aimError: 0.38, turnRate: 3.0,
    thinkProb: 0.28, thinkMs: [300, 800], retargetMs: [1500, 2800],
    greed: 0.25, contest: 0.08, wanderAmp: 0.34, wanderFreq: 0.7,
  },
};
// Weighted draw: mostly competent, a few drifters for variety/character.
const PERSONALITY_WEIGHTS = [
  ['aggressive', 0.30],
  ['balanced', 0.40],
  ['casual', 0.20],
  ['wanderer', 0.10],
];

function rand(min, max) {
  return min + Math.random() * (max - min);
}
function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}
// Approx standard normal (std ~1), bounded ~±3 — used for smooth, non-spiky noise.
function gauss() {
  return ((Math.random() - 0.5) + (Math.random() - 0.5) + (Math.random() - 0.5)) * 2;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
// Rotate `cur` toward `target` by at most `maxStep`, taking the shortest arc.
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

// Pick a human-looking name not present in `taken` (a Set of in-use names).
function pickName(taken) {
  const free = NAME_POOL.filter((n) => !taken || !taken.has(n));
  if (free.length) return free[randInt(0, free.length - 1)];
  // Pool exhausted (would need >60 players): disambiguate with a suffix.
  const base = NAME_POOL[randInt(0, NAME_POOL.length - 1)];
  return `${base}${randInt(2, 99)}`;
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
    // scratch state
    aimAngle: rand(0, TWO_PI),
    aimBias: gauss() * t.aimError,
    wanderPhase: rand(0, TWO_PI),
    targetX: undefined,
    targetY: undefined,
    pendingX: undefined,
    pendingY: undefined,
    retargetAt: 0,        // retarget on first tick
    reactUntil: 0,
    thinkUntil: 0,
  };
}

// How far behind the leader this bot is, in [-1, 1]. >0 = losing (push harder),
// <0 = leading (ease off so humans stay in it).
function rubberBand(room, p) {
  let leader = 0;
  for (let s = 0; s < MAX_PLAYERS; s++) {
    if (room.scores[s] > leader) leader = room.scores[s];
  }
  const mine = room.scores[p.slot] || 0;
  return clamp((leader - mine) / (0.15 * TOTAL_CELLS), -1, 1);
}

// Choose a fresh goal: weigh powerups and a coarse sample of grid cells, then
// pick by weighted random (not argmax) so bots are purposeful but fallible.
function chooseTarget(p, room, ai, t, band) {
  const candidates = [];
  const behind = Math.max(0, band);

  for (const pu of room.powerups) {
    const d = Math.hypot(pu.x - p.x, pu.y - p.y);
    let w = (ai.greed + 0.3 * behind) * (260 / (d + 70));
    if (pu.type === 'speed' || pu.type === 'missile') w *= 1.4;
    candidates.push({ x: pu.x, y: pu.y, w });
  }

  const SAMPLES = 26;
  const grid = room.grid;
  for (let i = 0; i < SAMPLES; i++) {
    const cx = randInt(0, GRID_W - 1);
    const cy = randInt(0, GRID_H - 1);
    const owner = grid[cy * GRID_W + cx];
    let value;
    if (owner === EMPTY) value = 1.0;
    else if (owner === p.slot) value = 0.04;
    else value = 0.35 + ai.contest + 0.45 * behind;   // enemy turf: contest harder when losing
    const wx = cx * CELL + CELL * 0.5;
    const wy = cy * CELL + CELL * 0.5;
    const d = Math.hypot(wx - p.x, wy - p.y);
    candidates.push({ x: wx, y: wy, w: value * (320 / (d + 130)) });
  }

  let sum = 0;
  for (const c of candidates) sum += c.w;
  let pick = candidates[candidates.length - 1];
  if (sum > 0) {
    let r = Math.random() * sum;
    for (const c of candidates) {
      r -= c.w;
      if (r <= 0) { pick = c; break; }
    }
  }

  const jx = clamp(pick.x + gauss() * 40, BRUSH_R, WORLD_W - BRUSH_R);
  const jy = clamp(pick.y + gauss() * 40, BRUSH_R, WORLD_H - BRUSH_R);

  // First target commits immediately; later ones arrive after a reaction delay.
  if (ai.targetX === undefined) {
    ai.targetX = jx; ai.targetY = jy;
  } else {
    ai.pendingX = jx; ai.pendingY = jy;
  }
  ai.reactUntil = t + rand(ai.reactMs[0], ai.reactMs[1]);
  ai.aimBias = gauss() * ai.aimError;   // resample steady-state aim error
}

// Blend a wall-repulsion term into the desired heading near the arena edges so
// bots peel away instead of grinding the boundary (a dead giveaway).
function avoidEdges(p, desired) {
  const margin = BRUSH_R * 4;
  let rx = 0, ry = 0;
  if (p.x < margin) rx += (margin - p.x) / margin;
  else if (p.x > WORLD_W - margin) rx -= (margin - (WORLD_W - p.x)) / margin;
  if (p.y < margin) ry += (margin - p.y) / margin;
  else if (p.y > WORLD_H - margin) ry -= (margin - (WORLD_H - p.y)) / margin;
  if (rx === 0 && ry === 0) return desired;
  const dvx = Math.cos(desired) + rx * 1.2;
  const dvy = Math.sin(desired) + ry * 1.2;
  return Math.atan2(dvy, dvx);
}

// Per-tick: set p.mx / p.my. dt is the sim step (~1/60s); t is now() in ms.
function updateBot(p, room, dt, t) {
  const ai = p.ai;
  if (!ai) { p.mx = 0; p.my = 0; return; }

  // Hesitation: zero input so damping eases the brush to a stop. (Reducing the
  // vector magnitude would be pointless — the sim normalizes it away.)
  if (t < ai.thinkUntil) { p.mx = 0; p.my = 0; return; }

  const band = rubberBand(room, p);

  if (t >= ai.retargetAt) {
    let interval = rand(ai.retargetMs[0], ai.retargetMs[1]);
    if (band > 0) interval *= (1 - 0.4 * band);          // losing -> re-plan sooner
    else interval *= (1 + 0.5 * -band);                  // leading -> dawdle
    ai.retargetAt = t + interval;
    const pauseProb = ai.thinkProb * (1 - 0.6 * Math.max(0, band));
    if (Math.random() < pauseProb) {
      ai.thinkUntil = t + rand(ai.thinkMs[0], ai.thinkMs[1]);
    }
    chooseTarget(p, room, ai, t, band);
  }

  // Commit a pending target once the reaction delay elapses.
  if (ai.pendingX !== undefined && t >= ai.reactUntil) {
    ai.targetX = ai.pendingX; ai.targetY = ai.pendingY;
    ai.pendingX = undefined; ai.pendingY = undefined;
  }

  let desired = Math.atan2(ai.targetY - p.y, ai.targetX - p.x);
  ai.wanderPhase += dt * ai.wanderFreq;
  desired += Math.sin(ai.wanderPhase) * ai.wanderAmp + ai.aimBias;
  desired = avoidEdges(p, desired);

  // Slew-limit toward the desired heading: the bot can't snap, only turn at a
  // capped rate, exactly like a player easing the stick/keys around.
  let turn = ai.turnRate;
  if (band > 0) turn *= (1 + 0.25 * band);   // a touch sharper when chasing
  ai.aimAngle = stepAngle(ai.aimAngle, desired, turn * dt);

  p.mx = Math.cos(ai.aimAngle);
  p.my = Math.sin(ai.aimAngle);
}

module.exports = { createBotAI, updateBot, pickName, NAME_POOL };
