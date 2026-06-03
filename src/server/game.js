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
  const wss = new WebSocketServer({ server });
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
    room.startRound();              // always running a bot game (the landing-page background)
    return room;
  }

  function destroyRoom(room) {
    rooms.delete(room.id);
  }

  // Cluster people together: prefer the room with the most ready players that can
  // still seat one more, then the most spectators. Spectators don't take slots,
  // so many can share a room; a new room is only made when none can seat a player.
  function pickRoom() {
    let best = null;
    for (const room of rooms.values()) {
      if (room.readyCount() >= MAX_PLAYERS) continue;
      if (!best) { best = room; continue; }
      if (room.readyCount() > best.readyCount() ||
          (room.readyCount() === best.readyCount() && room.humanCount() > best.humanCount())) {
        best = room;
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
    } catch { /* keep empty -> name arrives with the Play 'ready' message */ }

    let room = pickRoom();
    if (!room) {
      if (rooms.size < MAX_ROOMS) {
        room = createRoom();
      } else {
        // At room cap: spectate the fullest room (they'll get a slot when one frees).
        for (const r of rooms.values()) {
          if (!room || r.humanCount() > room.humanCount()) room = r;
        }
        if (!room) room = createRoom();
      }
    }

    const p = new Player(manager.allocId(), ws);
    if (name) p.name = name;        // usually empty; the real name comes with 'ready'
    room.addHuman(p);
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
