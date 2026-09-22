const { Server } = require('socket.io');
const env = require('../config/env');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientUrl.split(',').map((origin) => origin.trim().replace(/\/+$/, '')), credentials: true }
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.accessToken;
      if (typeof token !== 'string') throw new Error('Missing access token');
      const payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] });
      const user = await User.findById(payload.sub).select('_id status');
      if (!user || user.status !== 'active') throw new Error('Inactive account');
      socket.data.userId = user._id.toString();
      socket.data.expiresAt = payload.exp * 1000;
      if (!Number.isFinite(socket.data.expiresAt)) throw new Error('Missing expiry');
      next();
    } catch {
      next(new Error('Authentication required.'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
    expiryTimer.unref?.();
    socket.on('disconnect', () => clearTimeout(expiryTimer));
  });

  return io;
}

// Push a live update to every tab a specific user has open.
function emitToUser(userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { initSocket, emitToUser };
