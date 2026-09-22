import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';

const app = createApp();

describe('GET /health', () => {
  it('returns 200 with the success envelope and the expected shape', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.meta).toBeNull();
    expect(response.body.data.status).toBe('ok');
    expect(typeof response.body.data.uptime).toBe('number');
    expect(response.body.data.uptime).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(response.body.data.timestamp))).toBe(false);
  });

  it('echoes a correlation id header', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-request-id']).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('GET /ready', () => {
  it('reports the status of every dependency', async () => {
    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const report = response.body.data;
    expect(report.status).toBe('ready');
    expect(report.dependencies.database).toMatchObject({ status: 'up', driver: 'mysql' });
    expect(report.dependencies.cache).toMatchObject({ status: 'up', driver: 'memory' });
    expect(typeof report.dependencies.database.latencyMs).toBe('number');
  });
});
