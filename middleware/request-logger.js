// request-logger.js
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const startTime = Date.now();
  const requestId = uuidv4();

  // Add request ID to req for downstream use
  req.id = requestId;

  // Log incoming request (INFO level)
  logger.info({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    service: 'sewalokerbox-api',
    traceId: requestId,
    message: `Incoming ${req.method} ${req.path}`,
    context: {
      endpoint: req.path,
      method: req.method,
      userId: req.user?.id,
      requestId: requestId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      bodySize: req.body ? Buffer.byteLength(JSON.stringify(req.body)) : 0
    },
    tags: ['request', 'incoming']
  });

  // Log response when finished
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;

    const logLevel = res.statusCode >= 500 ? 'ERROR' :
                     res.statusCode >= 400 ? 'WARN' : 'INFO';

    logger[logLevel.toLowerCase()]({
      timestamp: new Date().toISOString(),
      level: logLevel,
      service: 'sewalokerbox-api',
      traceId: requestId,
      message: `Completed ${req.method} ${req.path} ${res.statusCode} in ${durationMs}ms`,
      context: {
        endpoint: req.path,
        method: req.method,
        statusCode: res.statusCode,
        userId: req.user?.id,
        requestId: requestId,
        durationMs: durationMs
      },
      tags: ['request', 'outgoing', `status-${Math.floor(res.statusCode/100)}xx`]
    });
  });

  next();
}

module.exports = requestLogger;