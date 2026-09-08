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
    const production = env.nodeEnv === 'production' || Boolean(process.env.VERCEL);
    if (production && !process.env.MONGO_URI?.trim()) {
      throw Object.assign(new Error('Database configuration missing'), { code: 'DB_URI_MISSING' });
    }
    if (production && env.useMemoryDb) {
      throw Object.assign(new Error('Temporary database enabled in production'), { code: 'DB_MEMORY_ENABLED' });
    }
    if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) {
      throw Object.assign(new Error('Database URI format invalid'), { code: 'DB_URI_INVALID' });
    }
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
  } catch (error) {
    // Log categories only: never expose credentials or the connection string.
    const reason = ['DB_URI_MISSING', 'DB_MEMORY_ENABLED', 'DB_URI_INVALID'].includes(error.code)
      ? error.code
      : error.code === 18 || /authentication failed|bad auth/i.test(error.message || '') ? 'DB_AUTH_FAILED'
      : /ENOTFOUND|querySrv|EAI_AGAIN/i.test(error.message || '') ? 'DB_DNS_FAILED'
      : /serverselection/i.test(error.name || '') ? 'DB_NETWORK_UNREACHABLE'
      : 'DB_CONNECTION_FAILED';
    console.error('[DB]', reason);
    throw error;
  } finally {
    // Reuse the connected pool; allow retry after failed or disconnected attempts.
    connectionPromise = null;
  }
}

module.exports = connectDB;
