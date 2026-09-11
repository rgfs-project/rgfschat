import { describe, expect, it } from 'vitest';
import { createLogger, redact } from './logger.ts';

function capture(level: Parameters<typeof createLogger>[0]['level'] = 'debug') {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(line),
    now: () => new Date('2026-09-11T00:00:00.000Z'),
  });
  /** Parses the nth emitted line. Throws if it wasn't written, which is the assertion we want. */
  const entry = (index = 0): Record<string, any> => {
    const line = lines[index];
    if (line === undefined) throw new Error(`No log line at index ${index}`);
    return JSON.parse(line) as Record<string, any>;
  };

  return { logger, lines, entry };
}

describe('logger', () => {
  it('emits structured JSON with level, time, and message', () => {
    const { logger, entry } = capture();

    logger.info('Server listening', { port: 3001 });

    expect(entry()).toEqual({
      level: 'info',
      time: '2026-09-11T00:00:00.000Z',
      message: 'Server listening',
      context: { port: 3001 },
    });
  });

  it('honours the level threshold', () => {
    const { logger, lines } = capture('warn');

    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');
    logger.error('kept');

    expect(lines).toHaveLength(2);
  });

  it('writes nothing at level silent', () => {
    const { logger, lines } = capture('silent');

    logger.error('still silent');

    expect(lines).toHaveLength(0);
  });

  it('redacts secret-like fields at any depth', () => {
    const { logger, entry } = capture();

    logger.info('request', {
      headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: 'application/json' },
      user: { name: 'ada', passwordHash: '$argon2id$v=19$...' },
      apiKey: 'sk-live-123',
    });

    const { context } = entry();
    expect(context.headers.authorization).toBe('[redacted]');
    expect(context.headers.cookie).toBe('[redacted]');
    expect(context.headers.accept).toBe('application/json');
    expect(context.user.passwordHash).toBe('[redacted]');
    expect(context.user.name).toBe('ada');
    expect(context.apiKey).toBe('[redacted]');
  });

  it('reduces Errors to name and message, never a stack', () => {
    const error = new Error('boom');

    expect(redact({ error })).toEqual({ error: { name: 'Error', message: 'boom' } });
  });

  it('survives circular structures', () => {
    const node: Record<string, unknown> = { id: 1 };
    node.self = node;

    expect(redact(node)).toEqual({ id: 1, self: '[circular]' });
  });
});
