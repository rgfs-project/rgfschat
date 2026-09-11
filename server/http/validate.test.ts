import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './testApp.ts';

describe('request validation', () => {
  it('accepts a valid body and returns an explicit DTO', async () => {
    const response = await request(createTestApp())
      .post('/test/echo')
      .send({ name: 'ada', count: 3 });

    expect(response.status).toBe(200);
    // INV-03: `count` was accepted but is not part of the response DTO.
    expect(response.body).toEqual({ name: 'ada' });
  });

  it('INV-02: rejects unknown fields instead of ignoring them', async () => {
    const response = await request(createTestApp())
      .post('/test/echo')
      .send({ name: 'ada', role: 'admin' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(JSON.stringify(response.body.error.details)).toContain('role');
  });

  it('INV-02: rejects a missing required field', async () => {
    const response = await request(createTestApp()).post('/test/echo').send({ count: 1 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
  });

  it('INV-02: rejects a field of the wrong type', async () => {
    const response = await request(createTestApp()).post('/test/echo').send({ name: 42 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
  });

  it('INV-03: validation details carry only field paths and messages', async () => {
    const response = await request(createTestApp()).post('/test/echo').send({ name: 42 });

    const { issues } = response.body.error.details;
    expect(Array.isArray(issues)).toBe(true);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
    }
  });
});
