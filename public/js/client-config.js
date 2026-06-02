(function attachSplashtoonConfig(global) {
  global.Splashtoon = global.Splashtoon || {};

  global.Splashtoon.config = {
    MAX_SPEED: 230,
    ACCEL: 2000,
    BOOST_MULT: 1.8,
    DAMPING_PER_SEC: 4.0,
    BRUSH_R: 16,
    MOVE_EPS: 14,
    DRIFT_EPS: 3.5,
    FACE_EPS: 18,
    RECONCILE_SOFT_DIST: 28,
    RECONCILE_HARD_DIST: 140,
    RECONCILE_SOFT_GAIN: 0.035,

    PET: {
      cellW: 192,
      cellH: 208,
      states: {
        'idle': { row: 0, frames: 6, rate: 170 },
        'running-right': { row: 1, frames: 7, rate: 70 },
        'running-left': { row: 2, frames: 7, rate: 70 },
        'speed': { row: 3, frames: 4, rate: 190 },
        'drift': { row: 0, frames: 6, rate: 150 },
        'freeze-cast': { row: 4, frames: 6, rate: 90 },
        'frozen-disabled': { row: 5, frames: 6, rate: 120 },
        'missile-cast': { row: 7, frames: 6, rate: 75 },
        'inkjam-disabled': { row: 8, frames: 6, rate: 120 },
      },
    },
    PET_DRAW_H: 78,
    PET_IDLE_DRAW_H: 66,
    PET_DRIFT_DRAW_H: 69,
    PET_ANCHOR_Y: 0.62,
    TRAIL_W: 26,
    SNAPSHOT_STAMP_PX: 16,

    POWERUP_SHEET: {
      cellW: 362,
      cellH: 362,
      cols: { speed: 0, freeze: 1, inkjam: 2, missile: 3 },
      rows: { active: 0 },
    },
    POWERUP_FADE_MS: 850,
  };
})(window);
