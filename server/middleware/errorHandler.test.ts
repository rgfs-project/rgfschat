import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@shared/errors.ts';
import { createApp } from '../app.ts';
import { createTestApp } from '../http/testApp.ts';
import { createLogger } from '../logger.ts';

/** Every error response must match the canonical contract and nothing else. */
function expectCanonicalError(body: unknown, code: string) {
  expect(Object.keys(body as object)).toEqual(['error']);

  const { error } = body as { error: Record<string, unknown> };
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe('string');
  expect((error.message as string).length).toBeGreaterThan(0);
  expect(Object.keys(error).every((key) => ['code', 'message', 'details'].includes(key))).toBe(
    true
  );
  expect(ERROR_CODES).toContain(error.code);
}

describe('error contract', () => {
  it('INV-01: unknown routes return a canonical 404', async () => {
    const app = createApp({ logger: createLogger({ level: 'silent', write: () => {} }) });

    const response = await request(app).get('/api/nope');

    expect(response.status).toBe(404);
    expectCanonicalError(response.body, 'NOT_FOUND');
  });

  it('INV-01: a thrown error becomes INTERNAL without exposing internals', async () => {
    const response = await request(createTestApp()).get('/test/boom');

    expect(response.status).toBe(500);
    expectCanonicalError(response.body, 'INTERNAL');

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('/etc/passwd');
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('Secret internal detail');
    expect(serialized).not.toMatch(/\bat\s+\w+\s+\(/); // no stack frames
  });

  it('INV-01: a rejected async handler is caught by Express 5 natively', async () => {
    const response = await request(createTestApp()).get('/test/async-boom');

    expect(response.status).toBe(500);
    expectCanonicalError(response.body, 'INTERNAL');
    expect(JSON.stringify(response.body)).not.toContain('key.pem');
  });

  it('INV-01: malformed JSON is a VALIDATION error, not a crash', async () => {
    const response = await request(createTestApp())
      .post('/test/echo')
      .set('Content-Type', 'application/json')
      .send('{"name": ');

    expect(response.status).toBe(400);
    expectCanonicalError(response.body, 'VALIDATION');
  });

  it('maps an oversized body to PAYLOAD_TOO_LARGE', async () => {
    const oversized = { name: 'x'.repeat(200_000) };

    const response = await request(createTestApp())
      .post('/test/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(oversized));

    expect(response.status).toBe(413);
    expectCanonicalError(response.body, 'PAYLOAD_TOO_LARGE');
  });
});
