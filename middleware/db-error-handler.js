// db-error-handler.js
function handleDatabaseError(error, operation, context) {
  let errorInfo = {
    level: 'ERROR',
    tags: ['database'],
    severity: 'P2'
  };

  // MongoDB and PostgreSQL specific error handling
  if (error.code) {
    const codeStr = String(error.code);
    
    // Check if it's PostgreSQL error code (alphanumeric / non-numeric)
    if (isNaN(error.code)) {
      switch (codeStr) {
        case '23505': // Duplicate key / Unique violation in Postgres
          errorInfo.message = `Duplicate key error: ${error.detail || error.message}`;
          errorInfo.tags.push('duplicate-key', 'postgres');
          errorInfo.severity = 'P3'; // Often recoverable
          break;
        case '08000':
        case '08003':
        case '08006': // Connection failed
          errorInfo.message = `Database connection failed: ${error.message}`;
          errorInfo.tags.push('connection-failed', 'postgres');
          errorInfo.level = 'FATAL';
          errorInfo.severity = 'P1';
          break;
        case '28P01': // Authentication failed
          errorInfo.message = `Database authentication failed`;
          errorInfo.tags.push('auth-failed', 'postgres');
          errorInfo.level = 'FATAL';
          errorInfo.severity = 'P1';
          break;
        case '57014': // Query timeout
          errorInfo.message = `Database operation timeout: ${error.message}`;
          errorInfo.tags.push('timeout', 'postgres');
          errorInfo.severity = 'P2';
          break;
        case '57P01': // Shutdown in progress
          errorInfo.message = `Database shutting down`;
          errorInfo.tags.push('shutdown', 'postgres');
          errorInfo.level = 'WARN';
          errorInfo.severity = 'P3';
          break;
        default:
          errorInfo.message = `Database error [${error.code}]: ${error.message}`;
          errorInfo.tags.push(`db-error-${error.code}`, 'postgres');
      }
    } else {
      // MongoDB codes (numeric)
      const codeNum = Number(error.code);
      switch (codeNum) {
        case 11000: // Duplicate key
          errorInfo.message = `Duplicate key error: ${error.message}`;
          errorInfo.tags.push('duplicate-key', 'mongodb');
          errorInfo.severity = 'P3'; // Often recoverable
          break;
        case 12: // Connection failed
          errorInfo.message = `Database connection failed: ${error.message}`;
          errorInfo.tags.push('connection-failed', 'mongodb');
          errorInfo.level = 'FATAL';
          errorInfo.severity = 'P1';
          break;
        case 13: // Authentication failed
          errorInfo.message = `Database authentication failed`;
          errorInfo.tags.push('auth-failed', 'mongodb');
          errorInfo.level = 'FATAL';
          errorInfo.severity = 'P1';
          break;
        case 89: // Network timeout
          errorInfo.message = `Database operation timeout: ${error.message}`;
          errorInfo.tags.push('timeout', 'mongodb');
          errorInfo.severity = 'P2';
          break;
        case 91: // Shutdown in progress
          errorInfo.message = `Database shutting down`;
          errorInfo.tags.push('shutdown', 'mongodb');
          errorInfo.level = 'WARN';
          errorInfo.severity = 'P3';
          break;
        default:
          errorInfo.message = `Database error [${error.code}]: ${error.message}`;
          errorInfo.tags.push(`db-error-${error.code}`, 'mongodb');
      }
    }
  } else {
    // Generic database error
    errorInfo.message = `Database error: ${error.message}`;
    errorInfo.tags.push('database-error');
  }

  errorInfo.context = {
    operation: operation,
    ...context
  };

  return errorInfo;
}

module.exports = { handleDatabaseError };