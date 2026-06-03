'use strict';

class Player {
  constructor(id, ws) {
    this.id = id;
    this.ws = ws || null;   // null for bots (no socket -> never broadcast to)
    this.name = '';         // display name (human-chosen or bot name pool)
    this.isBot = false;     // SERVER-ONLY: must never be serialized to clients
    this.ready = false;     // SERVER-ONLY: human has clicked Play (vs just watching)
    this.ai = null;         // bot steering/personality state (see bot-ai.js)
    this.slot = -1;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.mx = 0;
    this.my = 0;
    this.boostUntil = 0;
    this.frozenUntil = 0;
    this.noPaintUntil = 0;
    this.castType = null;
    this.castUntil = 0;
    this.alive = true;
  }

  get spectating() {
    return this.slot < 0;
  }
}

module.exports = { Player };
