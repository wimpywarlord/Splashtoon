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
const COUNTDOWN_MS = 3_000;   // pre-round 3-2-1 freeze so the whole field starts together

const POWERUP_EFFECT_MS = 4_000;
const POWERUP_MAX = 2;
const POWERUP_SPAWN_MS = 13_000;
const POWERUP_TTL_MS = 6_000;
const POWERUP_R = 28;
// A spawned powerup first opens as an oval PORTAL for POWERUP_TELEGRAPH_MS, then a
// lightning bolt strikes through it and it becomes grabbable. The short warning lets the
// nearby contesters -- not just whoever happened to be closest -- get a fair start on the
// race. Bots take a human-like beat to react, and some miss the tell entirely (see
// bot-ai), so it doesn't just hand the pickup to a reflex-perfect AI.
const POWERUP_TELEGRAPH_MS = 500;
// Endgame quiets down: a powerup that can't arm + be grabbed in time never spawns, and
// in the last POWERUP_LATE_NO_SPAWN_MS only POWERUP_LATE_SPAWN_CHANCE of slots fire --
// so a late pickup rarely decides the match.
const POWERUP_LATE_NO_SPAWN_MS = 10_000;
const POWERUP_LATE_SPAWN_CHANCE = 0.10;
// Powerups spawn at a RANDOM spot that's genuinely contestable: at least
// POWERUP_SPAWN_CONTEST_MIN players within POWERUP_SPAWN_CONTEST_R can race for it, but
// none inside POWERUP_SPAWN_CLEAR_R (no freebie dropped at someone's feet). This inverts
// the old "furthest from everyone" bias -- you can't farm pickups by drifting off alone,
// since your empty area has no contesters and won't be chosen; spawns follow the scrum.
// Degrades to a 2-player race, then any feet-clear spot, if a bigger scrum isn't
// reachable. TRIES caps the sampling attempts.
const POWERUP_SPAWN_TRIES = 56;
const POWERUP_SPAWN_CLEAR_R = 160;
const POWERUP_SPAWN_CONTEST_R = 380;
const POWERUP_SPAWN_CONTEST_MIN = 3;
const BOOST_MS = POWERUP_EFFECT_MS;
const BOOST_MULT = 2.0;
const SLOW_MS = 4_000;
const SLOW_MULT = 0.45;
const FREEZE_MS = 3_500;
const INKJAM_MS = 3_500;
const MEGA_BRUSH_MS = POWERUP_EFFECT_MS;
const MEGA_BRUSH_MULT = 1.55;
const TINY_BRUSH_MS = 5_000;
const TINY_BRUSH_MULT = 0.55;
const TINY_SPEED_MULT = 1.25;
const ERASE_MS = 5_000;
const ECHO_MS = 5_500;   // "clone"/ghost-twin window -- trimmed a bit from 7s
const SELF_FREEZE_MS = 3_000;
const SELF_INKJAM_MS = 3_000;

const MISSILE_COUNT = 12;
const BAD_MISSILE_COUNT = 12;
const MISSILE_DELAY_MS = 200;
const MISSILE_INTERVAL_MS = Math.floor((POWERUP_EFFECT_MS - MISSILE_DELAY_MS) / (MISSILE_COUNT - 1));
const CRATER_R = 36;
// "Mortar": an erasing missile shower -- reuses the missile barrage (MISSILE_COUNT strikes
// + missile timing) but the craters WIPE paint instead of laying it, with a bigger radius
// so the erase reads. Scattered board-wide, so it strips whoever owns the most (the leader).
const MORTAR_CRATER_R = 46;

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
  'mortar',
  'snap',
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
  'mortar',             // strong board-wide erase shower -> kept rare: single entry
  'snap', 'snap',       // random half-wipe: a chaotic gamble, so normal frequency
  'slow',
  'selfFreeze',
  'selfInkjam',
  'badMissile',
  'tiny',
];
// Most powerups cycle their type (the "twist") 1-3 times across their life; flips cap at
// 3 (4+ read as too frantic). 15% never flip at all, so betting on a bad icon changing
// before you reach it stays a gamble, never a certainty.
const POWERUP_SWITCH_CHANCES = [
  { changes: 0, weight: 0.15 },
  { changes: 1, weight: 0.39 },
  { changes: 2, weight: 0.32 },
  { changes: 3, weight: 0.14 },
];
// On a flip, the type re-rolls to a 50/50 coin toss between a BOON (good for the
// grabber) and a HAZARD (self-harm), so betting on a bad icon flipping -- or a good
// one souring -- is a genuine gamble. 'mortar' (kept deliberately rare) and 'snap'
// (a board-wide wildcard, not a personal good/bad) are spawn-only, never flip targets.
const FLIP_BOON_POOL = ['speed', 'freeze', 'inkjam', 'missile', 'mega', 'echo', 'erase'];
const FLIP_HAZARD_POOL = ['slow', 'selfFreeze', 'selfInkjam', 'badMissile', 'tiny'];

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

// Fixed round-start positions around the central 3-2-1 countdown. The room
// shuffles this ring each round before assigning players, so the formation stays
// readable without letting any slot own a permanent start location.
const COUNTDOWN_SPAWNS = [
  [WORLD_W * 0.50, WORLD_H * 0.18],   // top
  [WORLD_W * 0.25, WORLD_H * 0.34],   // upper-left
  [WORLD_W * 0.75, WORLD_H * 0.34],   // upper-right
  [WORLD_W * 0.25, WORLD_H * 0.66],   // lower-left
  [WORLD_W * 0.75, WORLD_H * 0.66],   // lower-right
  [WORLD_W * 0.50, WORLD_H * 0.82],   // bottom
];

// Display-name length cap, in code points. Shared by the server sanitizer and the
// client input so the limit is the same everywhere.
const MAX_NAME_LEN = 16;

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
  COUNTDOWN_MS,
  POWERUP_EFFECT_MS,
  POWERUP_MAX,
  POWERUP_SPAWN_MS,
  POWERUP_TTL_MS,
  POWERUP_R,
  POWERUP_TELEGRAPH_MS,
  POWERUP_LATE_NO_SPAWN_MS,
  POWERUP_LATE_SPAWN_CHANCE,
  POWERUP_SPAWN_TRIES,
  POWERUP_SPAWN_CLEAR_R,
  POWERUP_SPAWN_CONTEST_R,
  POWERUP_SPAWN_CONTEST_MIN,
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
  TINY_SPEED_MULT,
  ERASE_MS,
  ECHO_MS,
  SELF_FREEZE_MS,
  SELF_INKJAM_MS,
  MISSILE_COUNT,
  BAD_MISSILE_COUNT,
  MISSILE_DELAY_MS,
  MISSILE_INTERVAL_MS,
  CRATER_R,
  MORTAR_CRATER_R,
  POWERUP_TYPES,
  POWERUP_SPAWN_POOL,
  POWERUP_SWITCH_CHANCES,
  FLIP_BOON_POOL,
  FLIP_HAZARD_POOL,
  PALETTE,
  COUNTDOWN_SPAWNS,
  MAX_NAME_LEN,
};
