const mongoose = require('mongoose');
const env = require('./env');

async function connectDB() {
  mongoose.set('strictQuery', true);

  let uri = env.mongoUri;

  if (env.useMemoryDb) {
    // DEV-ONLY convenience path - see env.js. Requires mongodb-memory-server (devDependency).
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mem = await MongoMemoryServer.create();
    uri = mem.getUri();
    console.log('[DB] USE_MEMORY_DB=true -> using a temporary in-memory MongoDB for this run.');
    console.log('[DB] Data will NOT persist after the process stops. Set USE_MEMORY_DB=false and');
    console.log('[DB] provide a real MONGO_URI for production, per the Scope of Work.');
  }

  try {
    await mongoose.connect(uri);
    console.log(`[DB] Connected to MongoDB: ${mongoose.connection.name}`);
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
