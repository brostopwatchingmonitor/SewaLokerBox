// iot-error-logger.js
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Stateful tracking of IoT failures
const consecutiveFailures = new Map();
const lastHeartbeats = new Map();

function logIotError(error, lockerId, operation) {
  // Track consecutive failures
  const currentFailures = (consecutiveFailures.get(lockerId) || 0) + 1;
  consecutiveFailures.set(lockerId, currentFailures);

  const severity = currentFailures >= 3 ? 'P2' : 'P3';
  const level = currentFailures >= 3 ? 'ERROR' : 'WARN'; // Warn for single timeouts, Error for consecutive ones

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level,
    service: 'sewalokerbox-iot',
    traceId: uuidv4(),
    message: `IoT communication error for locker ${lockerId}: ${error.message}`,
    error: {
      type: error.constructor.name,
      message: error.message,
      code: error.code,
      operation: operation,
      timeout: error.timeout
    },
    context: {
      lockerId: lockerId,
      operation: operation, // e.g., 'register', 'heartbeat', 'unlock'
      lastSuccessfulHeartbeat: lastHeartbeats.get(lockerId) || null,
      consecutiveFailures: currentFailures
    },
    tags: ['iot', 'communication', `locker-${lockerId}`],
    severity: severity
  };

  logger[level.toLowerCase()](logEntry);
}

function recordIotSuccess(lockerId) {
  consecutiveFailures.set(lockerId, 0);
  lastHeartbeats.set(lockerId, new Date());
}

module.exports = { logIotError, recordIotSuccess };