'use strict';

const PORT = process.env.PORT || 3015;

const GRID_W = 128;   // 16:9 arena -> 1280 x 720 world
const GRID_H = 72;
const CELL = 10;
const WORLD_W = GRID_W * CELL;
const WORLD_H = GRID_H * CELL;
const EMPTY = 255;

const MAX_PLAYERS = 6;

// Netcode: simulate physics fast for crisp motion/collisions, but only push a
// state snapshot to clients at the lower broadcast rate (clients interpolate
// remotes between snapshots). BROADCAST_EVERY sim ticks => one broadcast.
const SIM_HZ = 60;
const SIM_MS = 1000 / SIM_HZ;
const BROADCAST_HZ = 30;
const BROADCAST_EVERY = Math.round(SIM_HZ / BROADCAST_HZ);
// Back-compat aliases (some tooling/logs referenced the old single tick rate).
const TICK_HZ = BROADCAST_HZ;
const TICK_MS = SIM_MS;

// Multi-room: every room is kept topped up to MAX_PLAYERS with bots. Rooms with
// no humans are torn down after a grace window so abandoned bot games don't leak.
const MAX_ROOMS = 50;
const ROOM_EMPTY_GRACE_MS = 30_000;

// Bot AI tuning.
// Bots consider any powerup within BOT_NOTICE_R (kept large -- ~the whole arena --
// because powerups spawn far from the pack; the race/expiry assessment in
// worthChasing then decides who actually commits, so a far but uncontested
// powerup still gets chased while contested ones go to the closest). COARSE_* is
// the resolution of the per-room "opportunity grid" bots steer territory by.
const BOT_NOTICE_R = 1400;
const COARSE_ZW = 12;
const COARSE_ZH = 8;
const BOT_COARSE_MS = 400;   // how often a room rebuilds its opportunity grid

const MAX_SPEED = 230;
const ACCEL = 2000;
const DAMPING_PER_SEC = 4.0;

const BRUSH_R = 16;
const STAMP_STEP = BRUSH_R / 2;
const MIN_PAINT_MOVE2 = 0.4;

const ROUND_MS = 120_000;
const INTERMISSION_MS = 10_000;

const POWERUP_EFFECT_MS = 4_000;
const POWERUP_MAX = 2;
const POWERUP_SPAWN_MS = 13_000;
const POWERUP_TTL_MS = 6_000;
const POWERUP_R = 28;
// Powerups spawn at a uniformly RANDOM point -- NOT biased toward open ground,
// which a player could game by drifting away from the pack to farm the "far from
// everyone" pickups. Truly random by default (CLEAR_R = 0). Raising CLEAR_R rejects
// spots within that radius of a player (avoids a freebie spawned at someone's feet)
// but reintroduces a slight bias AWAY from clustered players, so keep it small or 0.
// TRIES caps the rejection-sampling attempts.
const POWERUP_SPAWN_TRIES = 56;
const POWERUP_SPAWN_CLEAR_R = 0;
const BOOST_MS = POWERUP_EFFECT_MS;
const BOOST_MULT = 1.8;
const SLOW_MS = POWERUP_EFFECT_MS;
const SLOW_MULT = 0.45;
const FREEZE_MS = POWERUP_EFFECT_MS;
const INKJAM_MS = POWERUP_EFFECT_MS;
const MEGA_BRUSH_MS = POWERUP_EFFECT_MS;
const MEGA_BRUSH_MULT = 1.55;
const TINY_BRUSH_MS = POWERUP_EFFECT_MS;
const TINY_BRUSH_MULT = 0.55;
const ERASE_MS = 3_000;
const ECHO_MS = 8_000;
const SELF_FREEZE_MS = 2_500;
const SELF_INKJAM_MS = 3_000;

const MISSILE_COUNT = 12;
const BAD_MISSILE_COUNT = 8;
const MISSILE_DELAY_MS = 200;
const MISSILE_INTERVAL_MS = Math.floor((POWERUP_EFFECT_MS - MISSILE_DELAY_MS) / (MISSILE_COUNT - 1));
const CRATER_R = 36;

const POWERUP_TYPES = [
  'speed',
  'freeze',
  'inkjam',
  'missile',
  'mega',
  'echo',
  'erase',
  'slow',
  'selfFreeze',
  'selfInkjam',
  'badMissile',
  'tiny',
];
// Good powers are intentionally more common than bad powers; bad powers exist to
// make shuffled pickups risky, not to make most races feel like punishment.
const POWERUP_SPAWN_POOL = [
  'speed', 'speed',
  'freeze', 'freeze',
  'inkjam', 'inkjam',
  'missile', 'missile',
  'mega', 'mega',
  'echo', 'echo',
  'erase', 'erase',
  'slow',
  'selfFreeze',
  'selfInkjam',
  'badMissile',
  'tiny',
];
// Every powerup cycles its type at least once (the "twist"): weights sum to 1, so
// changes:0 never comes up. Skewed toward more flips -- about half change twice or
// more, and a few are frantic 3-4x changers.
const POWERUP_SWITCH_CHANCES = [
  { changes: 1, weight: 0.50 },
  { changes: 2, weight: 0.30 },
  { changes: 3, weight: 0.15 },
  { changes: 4, weight: 0.05 },
];

// One color per slot (MAX_PLAYERS). These six are the most mutually distinct of
// the old set -- the dropped pink/blue read too close to red/purple at speed.
const PALETTE = [
  '#ff4d6d',   // red
  '#4dd2ff',   // cyan
  '#ffd23f',   // yellow
  '#7c4dff',   // purple
  '#3ddc84',   // green
  '#ff8c42',   // orange
];

// One spawn per slot (MAX_PLAYERS): an evenly spread 3x2 grid (top/bottom rows,
// left/center/right), ordered so consecutive slots start far apart.
const SPAWNS = [
  [WORLD_W * 0.15, WORLD_H * 0.2],    // top-left
  [WORLD_W * 0.85, WORLD_H * 0.8],    // bottom-right
  [WORLD_W * 0.85, WORLD_H * 0.2],    // top-right
  [WORLD_W * 0.15, WORLD_H * 0.8],    // bottom-left
  [WORLD_W * 0.5, WORLD_H * 0.15],    // top-center
  [WORLD_W * 0.5, WORLD_H * 0.85],    // bottom-center
];

module.exports = {
  PORT,
  GRID_W,
  GRID_H,
  CELL,
  WORLD_W,
  WORLD_H,
  EMPTY,
  MAX_PLAYERS,
  SIM_HZ,
  SIM_MS,
  BROADCAST_HZ,
  BROADCAST_EVERY,
  MAX_ROOMS,
  ROOM_EMPTY_GRACE_MS,
  BOT_NOTICE_R,
  COARSE_ZW,
  COARSE_ZH,
  BOT_COARSE_MS,
  TICK_HZ,
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
};
