import type { LogLevel } from './config.ts';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * Field and header names whose values are replaced with `[redacted]`.
 *
 * Matching is case-insensitive and substring-based, so `x-api-key`,
 * `authorization`, and `passwordHash` are all caught. Nothing in this list
 * exists yet in Phase 1; it is established now so later phases inherit it
 * rather than retrofitting redaction after a leak.
 */
const REDACT_PATTERNS = [
  'authorization',
  'cookie',
  'password',
  'passwordhash',
  'secret',
  'token',
  'apikey',
  'api_key',
  'credential',
  'session',
  'csrf',
];

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

function shouldRedact(key: string): boolean {
  const lowered = key.toLowerCase();
  return REDACT_PATTERNS.some((pattern) => lowered.includes(pattern));
}

/** Deep-copies a value, replacing secret-like fields. Cycles become `[circular]`. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = shouldRedact(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Injectable sink, so tests capture output instead of writing to stdout. */
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * Structured JSON logger. Message content and secrets never appear at default
 * level; callers pass structured context, which is redacted before emission.
 */
export function createLogger({
  level,
  write = (line) => process.stdout.write(`${line}\n`),
  now = () => new Date(),
}: LoggerOptions): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const log = (entryLevel: Exclude<LogLevel, 'silent'>) => {
    return (message: string, context?: Record<string, unknown>): void => {
      if (LEVEL_WEIGHT[entryLevel] < threshold) return;

      const entry: Record<string, unknown> = {
        level: entryLevel,
        time: now().toISOString(),
        message,
      };
      if (context !== undefined) {
        entry['context'] = redact(context);
      }
      write(JSON.stringify(entry));
    };
  };

  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}
