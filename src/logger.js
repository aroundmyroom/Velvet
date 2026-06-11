import winston from 'winston';
import 'winston-daily-rotate-file';
import os from 'node:os';
import fs from 'node:fs';

let fileTransport;

const myFormat = winston.format.printf(info => {
  const msg = `${info.timestamp} ${info.level}: ${info.message}`;
  if (!info.stack) { return msg; }

  const stackStr = typeof info.stack === 'string' ?
    { stack: info.stack } :
    JSON.parse(JSON.stringify(info.stack, Object.getOwnPropertyNames(info.stack)));

  return msg + os.EOL + stackStr.stack;
});

winston.configure({
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        myFormat
      )
    })
  ],
  exitOnError: false
});

// Valid retention values (must stay in sync with config.js validation + admin UI)
export const VALID_RETENTIONS = ['1d', '3d', '7d', '14d', '30d'];
export const DEFAULT_RETENTION = '14d';

export function addFileLogger(filepath, maxFiles = DEFAULT_RETENTION) {
  if (fileTransport) {
    reset();
  }

  try {
    fs.mkdirSync(filepath, { recursive: true });
  } catch (err) {
    winston.warn(`[logger] File logging disabled: cannot create log directory ${filepath} (${err?.message || err})`);
    return;
  }

  const rotatingTransport = new (winston.transports.DailyRotateFile)({
    filename: 'velvet-%DATE%',
    dirname: filepath,
    extension: '.log',
    datePattern: 'YYYY-MM-DD-HH',
    maxSize: '20m',
    maxFiles: VALID_RETENTIONS.includes(maxFiles) ? maxFiles : DEFAULT_RETENTION,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
  });

  let disabled = false;
  rotatingTransport.on('error', (err) => {
    if (disabled) return;
    disabled = true;
    if (fileTransport === rotatingTransport) {
      winston.remove(rotatingTransport);
      fileTransport = undefined;
    }
    winston.warn(`[logger] File logging disabled: ${err?.message || err}`);
  });

  fileTransport = rotatingTransport;

  try {
    winston.add(fileTransport);
  } catch (err) {
    fileTransport = undefined;
    winston.warn(`[logger] File logging disabled: ${err?.message || err}`);
  }
}

export function reset() {
  if (fileTransport) {
    winston.remove(fileTransport);
  }

  fileTransport = undefined;
}
