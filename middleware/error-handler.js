// error-handler.js
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { handleDatabaseError } = require('./db-error-handler');
const { logHttpError } = require('./http-error-logger');

function classifyError(err, req) {
  // Default error info
  const errorInfo = {
    level: 'ERROR',
    statusCode: 500,
    tags: ['application'],
    severity: 'P2'
  };

  // Classify by error type
  if (err.type === 'entity.too.large') {
    errorInfo.message = `Payload too large: ${err.message}`;
    errorInfo.statusCode = 413;
    errorInfo.tags = ['payload-too-large'];
    errorInfo.severity = 'P3';
  } else if (err.type === 'session.store.error') {
    errorInfo.message = `Session store error: ${err.message}`;
    errorInfo.level = 'ERROR';
    errorInfo.tags = ['session', 'store'];
    errorInfo.severity = 'P2';
  } else if (err.code === 'EBADCSRFTOKEN') {
    errorInfo.message = `Invalid CSRF token: ${err.message}`;
    errorInfo.statusCode = 403;
    errorInfo.tags = ['csrf', 'invalid-token'];
    errorInfo.severity = 'P2';
  } else if (err.statusCode) {
    // HTTP errors (like from express-validator or custom errors)
    errorInfo.message = err.message || 'HTTP error';
    errorInfo.statusCode = err.statusCode;
    errorInfo.tags = ['http', `status-${Math.floor(err.statusCode/100)}xx`];
    errorInfo.level = err.statusCode >= 500 ? 'ERROR' : 'WARN';

    if (err.statusCode >= 500) {
      errorInfo.severity = 'P2';
    } else if (err.statusCode >= 400) {
      errorInfo.severity = 'P3';
    }
  } else if (err.isJoi) {
    // Joi validation errors
    errorInfo.message = `Validation error: ${err.details[0].message}`;
    errorInfo.statusCode = 400;
    errorInfo.tags = ['validation', 'joi'];
    errorInfo.level = 'WARN';
    errorInfo.severity = 'P3';
  }

  return errorInfo;
}

function errorHandler(err, req, res, next) {
  // Generate unique error ID for tracking
  const errorId = uuidv4();

  // If it's a database error, handle it using db-error-handler
  const isDatabaseError = 
    err.severity !== undefined || // pg
    (err.code && typeof err.code === 'string' && isNaN(Number(err.code))) || // pg error code
    (err.code && typeof err.code === 'number') || // mongo error code
    err.name === 'MongoError' || 
    err.name?.startsWith('Prisma');

  let errorInfo;

  if (isDatabaseError) {
    errorInfo = handleDatabaseError(err, `${req.method} ${req.path}`, {
      userId: req.user?.id,
      ip: req.ip
    });

    // Create structured log entry
    const logLevel = errorInfo.level || 'ERROR';
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      service: 'sewalokerbox-api',
      traceId: req.id || uuidv4(),
      errorId: errorId,
      message: errorInfo.message || err.message,
      error: {
        type: err.constructor.name,
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      },
      context: errorInfo.context,
      tags: errorInfo.tags,
      severity: errorInfo.severity
    };

    // Safely call logger method
    const logMethod = logLevel.toLowerCase();
    if (typeof logger[logMethod] === 'function') {
      logger[logMethod](logEntry);
    } else {
      logger.error(logEntry);
    }
  } else if (err.statusCode) {
    // It's a protocol/HTTP error (client or server)
    logHttpError(err, req, res);

    errorInfo = {
      statusCode: err.statusCode,
      level: err.statusCode >= 500 ? 'ERROR' : 'WARN',
      message: err.message
    };
  } else {
    // Default application error
    errorInfo = classifyError(err, req);

    const logLevel = errorInfo.level || 'ERROR';
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      service: 'sewalokerbox-api',
      traceId: req.id || uuidv4(),
      errorId: errorId,
      message: err.message || 'Unknown error',
      error: {
        type: err.constructor.name,
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      },
      context: {
        endpoint: req.path,
        method: req.method,
        userId: req.user?.id,
        requestId: req.id,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      },
      tags: errorInfo.tags,
      severity: errorInfo.severity
    };

    const logMethod = logLevel.toLowerCase();
    if (typeof logger[logMethod] === 'function') {
      logger[logMethod](logEntry);
    } else {
      logger.error(logEntry);
    }
  }

  // Send appropriate response to client
  const response = {
    success: false,
    error: {
      id: errorId,
      message: process.env.NODE_ENV === 'production'
        ? (errorInfo.statusCode >= 500 ? 'An unexpected error occurred' : err.message)
        : err.message || 'Unknown error',
      ...(process.env.NODE_ENV !== 'production' && {
        type: err.constructor.name,
        stack: err.stack
      })
    }
  };

  res.status(errorInfo.statusCode || 500).json(response);
}

module.exports = errorHandler;