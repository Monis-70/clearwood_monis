import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * Prompt B2 Task 3 — the development-only query counter.
 *
 * Every `src/` import here is dynamic and every test sets DEBUG_QUERY_COUNT first, because
 * config/env.ts resolves the flag once at module load: a hoisted import would read it before the
 * test could set it. The production rule is asserted against the decision function rather than by
 * booting as production, which would demand a full set of production secrets and prove no more.
 */

async function appWithCounter() {
  process.env.DEBUG_QUERY_COUNT = 'true';

  const { createApp } = await import('../src/app');
  return createApp();
}

describe('DEBUG_QUERY_COUNT', () => {
  it('defaults on in development, off elsewhere, and is refused outright in production', async () => {
    const { resolveQueryCountDebug } = await import('../src/config/env');

    expect(resolveQueryCountDebug('development', undefined)).toBe(true);
    expect(resolveQueryCountDebug('test', undefined)).toBe(false);
    expect(resolveQueryCountDebug('production', undefined)).toBe(false);

    expect(resolveQueryCountDebug('development', 'false')).toBe(false);
    expect(resolveQueryCountDebug('test', 'true')).toBe(true);

    // The one that matters: an operator cannot switch it on in production by setting the variable.
    expect(resolveQueryCountDebug('production', 'true')).toBe(false);
  });

  it('reports the query count and database time for the request that just ran', async () => {
    const app = await appWithCounter();

    const response = await request(app).get('/api/v1/catalog/products?limit=6');
    expect(response.status).toBe(200);

    const count = Number(response.headers['x-query-count']);
    const ms = Number(response.headers['x-query-ms']);

    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThan(0);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('attributes queries to the request that issued them, not to whatever ran before', async () => {
    const app = await appWithCounter();

    const listing = await request(app).get('/api/v1/catalog/products?limit=6');
    const health = await request(app).get('/health');

    const listingCount = Number(listing.headers['x-query-count'] ?? 0);
    const healthCount = Number(health.headers['x-query-count'] ?? 0);

    expect(listingCount).toBeGreaterThan(0);
    expect(listingCount).toBeGreaterThan(healthCount);
  }, 60_000);
});
