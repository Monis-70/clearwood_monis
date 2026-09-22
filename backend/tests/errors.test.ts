import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';

const app = createApp();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('error envelope (R3 / R4)', () => {
  it('returns the 404 envelope for an unknown route', async () => {
    const response = await request(app).get('/api/v1/this-route-does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toStrictEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: expect.stringContaining('/api/v1/this-route-does-not-exist'),
        details: null,
        traceId: expect.stringMatching(UUID),
      },
    });
  });

  it('returns 422 with per-issue details for an invalid query (R2)', async () => {
    const response = await request(app)
      .get('/api/v1/settings/public')
      .query({ group: 'NOT a valid group' });

    expect(response.status).toBe(422);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(response.body.error.details)).toBe(true);
    expect(response.body.error.details[0]).toMatchObject({ location: 'query', path: 'group' });
  });

  it('returns 400 for a malformed JSON body', async () => {
    const response = await request(app)
      .post('/api/v1/settings/public')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });

  it('puts a traceId on every error response', async () => {
    const responses = await Promise.all([
      request(app).get('/nope'),
      request(app).get('/api/v1/nope'),
      request(app).get('/api/v1/settings/public').query({ group: '!!!' }),
    ]);

    for (const response of responses) {
      expect(response.body.success).toBe(false);
      expect(response.body.error.traceId).toMatch(UUID);
      expect(response.body.error).toHaveProperty('details');
      expect(response.headers['x-request-id']).toBe(response.body.error.traceId);
    }
  });

  it('reuses a caller-supplied x-request-id as the traceId', async () => {
    const supplied = 'trace-from-the-storefront-1234';
    const response = await request(app).get('/nope').set('x-request-id', supplied);

    expect(response.body.error.traceId).toBe(supplied);
    expect(response.headers['x-request-id']).toBe(supplied);
  });

  it('never leaks a stack trace', async () => {
    const response = await request(app).get('/api/v1/nope');
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });
});
