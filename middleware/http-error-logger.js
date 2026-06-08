// http-error-logger.js
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

function logHttpError(error, req, res) {
  const statusCode = error.statusCode || 500;
  const level = statusCode >= 500 ? 'ERROR' : 'WARN';
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level,
    service: 'sewalokerbox-api',
    traceId: req.id || uuidv4(),
    message: `HTTP ${error.type || 'Error'}: ${error.message}`,
    error: {
      type: error.constructor.name,
      message: error.message,
      statusCode: statusCode,
      exposed: error.exposed || false // Whether safe to show to client
    },
    context: {
      endpoint: req.path,
      method: req.method,
      userId: req.user?.id,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      referrer: req.get('Referrer'),
      contentLength: req.get('Content-Length'),
      // Don't log sensitive headers like Authorization
      safeHeaders: Object.fromEntries(
        Object.entries(req.headers || {})
          .filter(([key]) => !['authorization', 'cookie', 'x-api-key'].includes(key.toLowerCase()))
      )
    },
    tags: ['http', 'protocol-error', `status-${Math.floor(statusCode/100)}xx`],
    severity: statusCode >= 500 ? 'P2' : 'P3'
  };

  logger[level.toLowerCase()](logEntry);
}

module.exports = { logHttpError };