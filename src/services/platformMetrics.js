const samples = [];
const MAX_SAMPLES = 2000;

function metricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    samples.push({ method: req.method, path: req.route?.path || req.path, status: res.statusCode, durationMs, at: new Date() });
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  });
  next();
}

function snapshot(minutes = 60) {
  const since = Date.now() - Math.max(1, Math.min(1440, Number(minutes) || 60)) * 60000;
  const recent = samples.filter((sample) => sample.at.getTime() >= since);
  const durations = recent.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const percentile = (p) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] : 0;
  const errors = recent.filter((sample) => sample.status >= 500);
  const memory = process.memoryUsage();
  return {
    windowMinutes: Number(minutes) || 60,
    requests: recent.length,
    errors: errors.length,
    errorRate: recent.length ? Number((errors.length / recent.length * 100).toFixed(2)) : 0,
    latencyMs: { average: recent.length ? Number((durations.reduce((a, b) => a + b, 0) / recent.length).toFixed(2)) : 0, p50: Number(percentile(.5).toFixed(2)), p95: Number(percentile(.95).toFixed(2)) },
    statusCounts: recent.reduce((out, sample) => { out[sample.status] = (out[sample.status] || 0) + 1; return out; }, {}),
    slowest: [...recent].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    process: { uptimeSeconds: Math.round(process.uptime()), rssMB: Number((memory.rss / 1048576).toFixed(1)), heapUsedMB: Number((memory.heapUsed / 1048576).toFixed(1)), node: process.version }
  };
}

module.exports = { metricsMiddleware, snapshot };
