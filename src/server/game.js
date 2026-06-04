'use strict';

// ---------------------------------------------------------------------------
// RoomManager: owns the WebSocket server and a pool of Rooms. Every human is
// routed into a room with a free human slot (or a fresh room); each room is
// always topped up to MAX_PLAYERS with bots so it feels full. A single timer
// steps every room at the sim rate and gates the lower-rate state broadcast.
//
// (This file used to BE the single game. The per-game state + rules now live in
// room.js; this is just the multiplexer in front of many rooms.)
// ---------------------------------------------------------------------------

const { WebSocketServer } = require('ws');
const { Player } = require('./player');
const { Room, sanitizeName } = require('./room');
const {
  MAX_PLAYERS,
  SIM_MS,
  BROADCAST_EVERY,
  MAX_ROOMS,
  ROOM_EMPTY_GRACE_MS,
} = require('./config');

function createGameServer(server) {
  // maxPayload: every legit client->server message (input/chat/rename/ping/
  // resync) is well under 1 KiB of JSON; 4 KiB leaves headroom while a
  // scripted multi-megabyte frame is rejected at the protocol layer (1009 close)
  // before it is ever buffered into a string or parsed.
  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  const rooms = new Map();        // roomId -> Room
  let nextRoomId = 1;
  let idCounter = 1;              // globally-unique player ids across all rooms
  let tickTimer = null;
  let tickCount = 0;
  let lastTick = Date.now();

  // Rooms reach back for globally-unique ids when minting bots.
  const manager = { allocId: () => idCounter++ };

  function createRoom() {
    const id = nextRoomId++;
    const room = new Room(id, manager);
    rooms.set(id, room);
    return room;
  }

  function destroyRoom(room) {
    rooms.delete(room.id);
  }

  // Prefer the fullest room that still has a free human slot, so humans cluster
  // together instead of scattering one-per-room among bots.
  function pickRoomForHuman() {
    let best = null;
    for (const room of rooms.values()) {
      if (room.humanCount() < MAX_PLAYERS) {
        if (!best || room.humanCount() > best.humanCount()) best = room;
      }
    }
    return best;
  }

  function handleConnection(ws, req) {
    if (ws._socket && typeof ws._socket.setNoDelay === 'function') {
      ws._socket.setNoDelay(true);
    }

    let name = '';
    try {
      const url = new URL(req.url, 'http://localhost');
      name = sanitizeName(url.searchParams.get('name') || '');
    } catch { /* keep empty -> room assigns a fallback name */ }

    let room = pickRoomForHuman();
    let founding = false;
    if (!room) {
      if (rooms.size < MAX_ROOMS) {
        room = createRoom();
        founding = true;            // brand-new room: seat + start immediately
      } else {
        // At room cap: drop them into the emptiest room as a spectator.
        for (const r of rooms.values()) {
          if (!room || r.humanCount() < room.humanCount()) room = r;
        }
        if (!room) { room = createRoom(); founding = true; }
      }
    } else if (room.humanCount() === 0) {
      founding = true;              // claim an idle (bot-only) room for instant play
    }

    const p = new Player(manager.allocId(), ws);
    p.name = name;                  // may be '' -> Room.addHuman fills a fallback
    room.addHuman(p, founding);
  }

  function tick() {
    const t = Date.now();
    const dt = Math.min(0.1, (t - lastTick) / 1000);
    lastTick = t;
    const doBroadcast = (tickCount++ % BROADCAST_EVERY) === 0;

    for (const room of rooms.values()) {
      room.tick(dt, doBroadcast);
    }

    // Reap rooms abandoned by all humans past the grace window.
    for (const room of rooms.values()) {
      if (room.humanCount() === 0 && room.emptyAt && t - room.emptyAt > ROOM_EMPTY_GRACE_MS) {
        destroyRoom(room);
      }
    }
  }

  function start() {
    if (tickTimer) return;
    wss.on('connection', handleConnection);
    tickTimer = setInterval(tick, SIM_MS);
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
    rooms,
    getSnapshot: () => ({
      rooms: rooms.size,
      humans: [...rooms.values()].reduce((n, r) => n + r.humanCount(), 0),
    }),
  };
}

module.exports = { createGameServer };
