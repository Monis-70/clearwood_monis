import { describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { cartService } from '../src/modules/cart/cart.service';

import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';

/**
 * One ACTIVE cart per owner, under real concurrent callers.
 *
 * This is the most-trafficked write in the application and, until now, nothing anywhere in the
 * suite mentioned `activeOwnerKey`. A guest opening two tabs, or a page issuing two requests before
 * the first cookie lands, is the ordinary case rather than the exotic one.
 *
 * `getOrCreate` is NOT the read-then-CAS shape the coupon and the inventory service used. It tries
 * an insert and lets the unique index arbitrate, re-reading after a collision, which is sound
 * because the index is the decision rather than a value the caller read earlier. These assertions
 * are here to verify that, not to presume it.
 */

const CONCURRENCY = 10;

describe('one ACTIVE cart per owner', () => {
  it('gives every concurrent caller the same cart, and creates exactly one row', async () => {
    const sessionId = `cart-race-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const owner = { sessionId, customerId: null, isNewSession: true };

    const result = await runConcurrently(CONCURRENCY, () => cartService.getOrCreate(owner));

    expectNoInfrastructureFailures(result);
    console.log(`[concurrency] cart getOrCreate: ${JSON.stringify(result.outcomes)}`);

    expect(result.ok, `rejected: ${result.reasons.join('; ')}`).toBe(CONCURRENCY);
    expect(result.contended, 'a caller got CART_CONFLICT instead of a cart').toBe(0);

    const ids = new Set(result.values.map((cart) => cart.id));

    // G1: ten callers, and an id that is a real cuid rather than an empty string.
    expect(result.values).toHaveLength(CONCURRENCY);
    expect([...ids][0]).toMatch(/^c[a-z0-9]{20,}$/);
    expect(ids.size, `callers received ${ids.size} different carts: ${[...ids].join(', ')}`).toBe(1);

    const rows = await prisma.cart.findMany({ where: { sessionId, status: 'ACTIVE' } });
    expect(rows, 'more than one ACTIVE cart survived the race').toHaveLength(1);
    expect(rows[0]!.id).toBe([...ids][0]);
  }, 120_000);

  it('keeps two different owners apart under the same pressure', async () => {
    const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const owners = [`cart-a-${tag}`, `cart-b-${tag}`];

    const result = await runConcurrently(CONCURRENCY, (index) =>
      cartService.getOrCreate({ sessionId: owners[index % 2]!, customerId: null, isNewSession: true }),
    );

    expectNoInfrastructureFailures(result);

    expect(result.ok).toBe(CONCURRENCY);
    expect(new Set(result.values.map((cart) => cart.id)).size, 'owners were merged').toBe(2);
  }, 120_000);
});
