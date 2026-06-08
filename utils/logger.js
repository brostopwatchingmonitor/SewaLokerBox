// logger.js
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, json, errors, prettyPrint } = format;
const DailyRotateFile = require('winston-daily-rotate-file');

// Determine environment
const isDevelopment = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';

// Custom levels and colors
const customLevels = {
  levels: {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5
  },
  colors: {
    fatal: 'red',
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue',
    trace: 'gray'
  }
};

// Add custom colors to winston
require('winston').addColors(customLevels.colors);

// Common format
const logFormat = combine(
  errors({ stack: true }),
  timestamp(),
  json()
);

// Console format (pretty in dev)
const consoleFormat = combine(
  errors({ stack: true }),
  timestamp(),
  isDevelopment ? prettyPrint() : json()
);

// File rotation options for all application logs (info and above)
const fileRotateOptions = {
  filename: 'logs/application-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '10m',
  maxFiles: '14d' // Keep 2 weeks of logs
};

// Create logger instance
const logger = createLogger({
  levels: customLevels.levels,
  level: isDevelopment ? 'debug' : 'info',
  format: logFormat,
  defaultMeta: { service: 'sewalokerbox-api' },
  transports: [
    // Console transport
    new transports.Console({
      format: consoleFormat
    })
  ]
});

// Add file transport in production
if (isProduction) {
  logger.add(
    new DailyRotateFile(fileRotateOptions)
  );
}

// Add error transport for fatal and error logs (level <= error)
logger.add(
  new DailyRotateFile({
    filename: 'logs/errors-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    format: logFormat,
    zippedArchive: true,
    maxSize: '5m',
    maxFiles: '5d'
  })
);

module.exports = logger;