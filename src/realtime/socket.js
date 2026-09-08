const { Server } = require('socket.io');
const env = require('../config/env');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientUrl, credentials: true }
  });

  io.on('connection', (socket) => {
    const userId = socket.handshake.auth?.userId;
    if (userId) socket.join(`user:${userId}`);

    socket.on('disconnect', () => {});
  });

  return io;
}

// Push a live update to every tab a specific user has open.
function emitToUser(userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { initSocket, emitToUser };
