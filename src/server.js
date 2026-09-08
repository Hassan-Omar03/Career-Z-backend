const http = require('http');
const app = require('./app');
const connectDB = require('./config/db');
const env = require('./config/env');
const { runSeedData } = require('./seed/seed');
const { initSocket } = require('./realtime/socket');

(async () => {
  await connectDB();

  // In-memory dev DB is empty on every process start, so seed it automatically.
  // Against a real database (USE_MEMORY_DB=false) this is skipped; run `npm run seed` once instead.
  if (env.useMemoryDb) {
    await runSeedData();
  }

  const httpServer = http.createServer(app);
  initSocket(httpServer);

  httpServer.listen(env.port, () => {
    console.log(`[SERVER] CareerZ API listening on http://localhost:${env.port}`);
    console.log(`[SERVER] Realtime (Socket.IO) attached on the same port.`);
    console.log(`[SERVER] Environment: ${env.nodeEnv}`);
  });
})();
