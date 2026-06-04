'use strict';

class Player {
  constructor(id, ws) {
    this.id = id;
    this.ws = ws || null;   // null for bots (no socket -> never broadcast to)
    this.name = '';         // display name (human-chosen or bot name pool)
    this.isBot = false;     // SERVER-ONLY: must never be serialized to clients
    this.ai = null;         // bot steering/personality state (see bot-ai.js)
    this.slot = -1;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.mx = 0;
    this.my = 0;
    this.boostUntil = 0;
    this.slowUntil = 0;
    this.frozenUntil = 0;
    this.noPaintUntil = 0;
    this.erasingUntil = 0;
    this.brushScaleUntil = 0;
    this.brushScale = 1;
    // "Recruit"/convert: while active, this brush PAINTS AS paintSlotOverride
    // (the caster's slot) instead of its own -- its strokes score for the caster.
    this.paintSlotOverride = -1;
    this.paintSlotOverrideUntil = 0;
    this.castType = null;
    this.castUntil = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.isEcho = false;
    this.ownerId = 0;
    this.echoExpiresAt = 0;
    this.alive = true;
  }

  get spectating() {
    return this.slot < 0;
  }
}

module.exports = { Player };
