// validation-error-logger.js
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

function logValidationError(error, req, validationDetails) {
  // Only log if it's suspicious or repeated
  const shouldLog = validationDetails.severity === 'high' ||
                   isRepeatedValidationFailure(req, validationDetails.field);

  if (shouldLog) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'WARN',
      service: 'sewalokerbox-api',
      traceId: req.id,
      message: `Validation failed: ${validationDetails.message}`,
      error: {
        type: 'ValidationError',
        message: validationDetails.message,
        field: validationDetails.field,
        value: JSON.stringify(validationDetails.value).substring(0, 100) // Truncate long values
      },
      context: {
        endpoint: req.path,
        method: req.method,
        userId: req.user?.id,
        requestId: req.id,
        ip: req.ip
      },
      tags: ['validation', `field-${validationDetails.field}`, validationDetails.rule],
      severity: validationDetails.severity
    };

    logger.warn(logEntry);
  }
}

// Helper function to track repeated validation failures
const validationFailureCache = new Map();

function isRepeatedValidationFailure(req, field) {
  const ip = req.ip;
  const key = `${ip}:${field}`;

  const now = Date.now();
  const windowSize = 60 * 1000; // 1 minute window

  // Clean old entries
  for (const [k, timestamp] of validationFailureCache.entries()) {
    if (now - timestamp > windowSize * 2) {
      validationFailureCache.delete(k);
    }
  }

  // Check if we've seen this failure recently
  const lastFailure = validationFailureCache.get(key);
  if (lastFailure && now - lastFailure < windowSize) {
    // Increment count
    validationFailureCache.set(key, now);
    return true;
  }

  // Record this failure
  validationFailureCache.set(key, now);
  return false;
}

module.exports = { logValidationError };