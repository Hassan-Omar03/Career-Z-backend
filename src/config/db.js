const mongoose = require('mongoose');
const env = require('./env');

let connectionPromise;
let memoryServer;

async function connectDB() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    mongoose.set('strictQuery', true);
    let uri = env.mongoUri;
    if (env.useMemoryDb) {
      if (env.nodeEnv === 'production') throw new Error('USE_MEMORY_DB must be false in production.');
      const { MongoMemoryServer } = require('mongodb-memory-server');
      if (!memoryServer) memoryServer = await MongoMemoryServer.create();
      uri = memoryServer.getUri();
    }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    return mongoose.connection;
  })();

  try {
    return await connectionPromise;
  } finally {
    // Reuse the connected pool; allow retry after failed or disconnected attempts.
    connectionPromise = null;
  }
}

module.exports = connectDB;
