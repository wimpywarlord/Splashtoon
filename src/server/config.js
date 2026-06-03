'use strict';

const PORT = process.env.PORT || 3015;

const GRID_W = 128;   // 16:9 arena -> 1280 x 720 world
const GRID_H = 72;
const CELL = 10;
const WORLD_W = GRID_W * CELL;
const WORLD_H = GRID_H * CELL;
const EMPTY = 255;

const MAX_PLAYERS = 8;

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
// A powerup within BOT_NOTICE_R of a bot becomes its top priority (grabbed after
// only the bot's reaction delay). COARSE_* is the resolution of the per-room
// "opportunity grid" bots use to steer toward open / contestable territory.
const BOT_NOTICE_R = 340;
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
const POWERUP_R = 18;
// Powerups spawn at a candidate point well away from the pack (open ground, fair
// race) but with NOISE: we sample many candidates, then pick randomly among the
// TOP_K most-open ones, so a lone player can't camp empty space for guaranteed
// pickups.
const POWERUP_SPAWN_TRIES = 56;
const POWERUP_SPAWN_TOPK = 12;
const BOOST_MS = POWERUP_EFFECT_MS;
const BOOST_MULT = 1.8;
const FREEZE_MS = POWERUP_EFFECT_MS;
const INKJAM_MS = POWERUP_EFFECT_MS;

const MISSILE_COUNT = 12;
const MISSILE_DELAY_MS = 200;
const MISSILE_INTERVAL_MS = Math.floor((POWERUP_EFFECT_MS - MISSILE_DELAY_MS) / (MISSILE_COUNT - 1));
const CRATER_R = 36;

const POWERUP_TYPES = ['speed', 'freeze', 'inkjam', 'missile'];

const PALETTE = [
  '#ff4d6d',
  '#4dd2ff',
  '#ffd23f',
  '#7c4dff',
  '#3ddc84',
  '#ff8c42',
  '#ff6fd8',
  '#5b8cff',
];

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
  POWERUP_SPAWN_TOPK,
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
};
