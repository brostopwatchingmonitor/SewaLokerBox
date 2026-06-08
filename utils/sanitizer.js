// sanitizer.js
function sanitizeForLogging(obj, options = {}) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const sanitized = Array.isArray(obj) ? [] : {};
  const sensitiveFields = new Set([
    'password', 'token', 'authorization', 'cookie', 'x-api-key',
    'credit_card', 'cvv', 'ssn', 'socialsecuritynumber',
    'email', 'phone', 'phonenumber', 'address',
    'jwt', 'sessionid', 'auth',
    'fcm_token', 'hashed_password', 'hashed_pin', 'pin',
    'security.password', 'security.pin'
  ]);

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    if (sensitiveFields.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeForLogging(value, options);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

module.exports = { sanitizeForLogging };