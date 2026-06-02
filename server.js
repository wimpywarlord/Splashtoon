'use strict';

const http = require('http');
const path = require('path');
const { createStaticHandler } = require('./src/server/static-server');
const { createGameServer } = require('./src/server/game');
const { PORT, GRID_W, GRID_H, CELL, SIM_HZ, BROADCAST_HZ, ROUND_MS } = require('./src/server/config');

const publicDir = path.join(__dirname, 'public');
const server = http.createServer(createStaticHandler(publicDir));
const game = createGameServer(server);

server.listen(PORT, () => {
  console.log(`Splashtoon running at http://localhost:${PORT}`);
  console.log(`Grid ${GRID_W}x${GRID_H} @ ${CELL}px  |  sim ${SIM_HZ}Hz / net ${BROADCAST_HZ}Hz  |  round ${ROUND_MS / 1000}s  |  multi-room + bot backfill`);
});

game.start();

module.exports = { server, game };
