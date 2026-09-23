const AdminAuditLog = require('../models/AdminAuditLog');

function adminAudit(req, res, next) {
  if (req.method === 'GET') return next();
  res.on('finish', () => {
    AdminAuditLog.create({
      actor: req.user?._id || null,
      action: `${req.method} ${req.baseUrl}${req.route?.path || req.path}`,
      method: req.method,
      path: req.originalUrl,
      targetType: req.body?.type || '',
      targetId: req.params?.id || '',
      statusCode: res.statusCode,
      ip: req.ip,
      metadata: { fields: Object.keys(req.body || {}).filter((key) => !/password|token|secret|key/i.test(key)) }
    }).catch(() => {});
  });
  next();
}

module.exports = adminAudit;
