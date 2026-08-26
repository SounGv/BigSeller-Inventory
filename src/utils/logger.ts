import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

type Level = 'info' | 'warn' | 'error';

const LOG_DIR = process.env.LOG_DIR ?? './logs';

async function writeLine(level: Level, message: string) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  // eslint-disable-next-line no-console
  console[level === 'info' ? 'log' : level](line);

  await mkdir(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  await appendFile(file, line + '\n', 'utf8');
}

export const logger = {
  info: (message: string) => writeLine('info', message),
  warn: (message: string) => writeLine('warn', message),
  error: (message: string) => writeLine('error', message),
};
