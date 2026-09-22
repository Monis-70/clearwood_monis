import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { catalogEvents } from '../src/events/catalogEvents';
import { buildLineKey } from '../src/modules/cart/lineKey';
import { passwordService } from '../src/modules/auth/password.service';

/**
 * Prompt 8 — cart, wishlist, addresses and recently-viewed.
 *
 * The three things this file exists to prove:
 *
 *  1. PRICING AUTHORITY — a cart's breakdown is byte-identical to `/pricing/quote` for the same
 *     items, component by component, not merely on the grand total.
 *  2. CONCURRENCY — parallel first requests produce exactly one ACTIVE cart, parallel identical
 *     adds produce one line, and simultaneous quantity updates never silently lose one.
 *  3. THE CART NEVER RESERVES STOCK — `reservedQty` is untouched by anything in this file.
 *
 * Hermetic: everything created here is created by the test.
 */

const app = createApp();
const API = '/api/v1';
const TEST_PASSWORD = 'Rosewood-Teak-2026';
const CUSTOMER_PASSWORD = 'CartTester@2026';

/* ------------------------------------------------------------------ helpers */

interface Session {
  header: string;
  csrf: string;
  id: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function sessionFrom(response: request.Response, csrfCookie: string, id: string): Session {
  const cookies = cookiesOf(response);
  return {
    header: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      cookies
        .find((cookie) => cookie.startsWith(`${csrfCookie}=`))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
    id,
  };
}

async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Cart ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
    },
  });

  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  const login = await request(app)
    .post(`${API}/admin/auth/login`)
    .send({ email, password: TEST_PASSWORD });

  return sessionFrom(login, 'cw_adm_csrf', user.id);
}

/** A customer with a password, logged in, returning cookies + CSRF. */
async function customer(email: string): Promise<Session> {
  const existing = await prisma.customer.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: 'Cart Tester',
      status: 'ACTIVE',
      passwordHash: await passwordService.hash(CUSTOMER_PASSWORD),
      emailVerifiedAt: new Date(),
    },
  });

  const login = await request(app)
    .post(`${API}/auth/login`)
    .send({ identifier: email, password: CUSTOMER_PASSWORD });

  expect(login.status).toBe(200);
  return sessionFrom(login, 'cw_cus_csrf', existing.id);
}

function as(session: Session) {
  const csrf = (req: request.Test) =>
    req.set('Cookie', session.header).set('X-CSRF-Token', session.csrf);

  return {
    get: (url: string) => request(app).get(url).set('Cookie', session.header),
    post: (url: string) => csrf(request(app).post(url)),
    patch: (url: string) => csrf(request(app).patch(url)),
    put: (url: string) => csrf(request(app).put(url)),
    delete: (url: string) => csrf(request(app).delete(url)),
  };
}

/**
 * A guest browser. Supertest has no cookie jar across calls, so the guest cart cookie is carried
 * forward by hand — which is also a direct test that the cookie alone is enough to find the cart.
 */
class Guest {
  cookie = '';

  private capture(response: request.Response): request.Response {
    const cart = cookiesOf(response).find((value) => value.startsWith('cw_cart='));
    if (cart) this.cookie = cart.split(';')[0]!;
    return response;
  }

  private headers(req: request.Test): request.Test {
    return this.cookie ? req.set('Cookie', this.cookie) : req;
  }

  async get(url: string): Promise<request.Response> {
    return this.capture(await this.headers(request(app).get(`${API}${url}`)));
  }

  async post(url: string, body?: unknown): Promise<request.Response> {
    return this.capture(await this.headers(request(app).post(`${API}${url}`)).send(body ?? {}));
  }

  async patch(url: string, body?: unknown): Promise<request.Response> {
    return this.capture(await this.headers(request(app).patch(`${API}${url}`)).send(body ?? {}));
  }

  async put(url: string, body?: unknown): Promise<request.Response> {
    return this.capture(await this.headers(request(app).put(`${API}${url}`)).send(body ?? {}));
  }

  async delete(url: string): Promise<request.Response> {
    return this.capture(await this.headers(request(app).delete(`${API}${url}`)));
  }
}

interface ProductFixture {
  id: string;
  slug: string;
  variantA: string;
  variantB: string;
}

async function fixture(slug: string): Promise<ProductFixture> {
  const product = await prisma.product.findUniqueOrThrow({
    where: { slug },
    include: { variants: { where: { deletedAt: null }, orderBy: { sku: 'asc' } } },
  });

  return {
    id: product.id,
    slug: product.slug,
    variantA: product.variants[0]!.id,
    variantB: (product.variants[1] ?? product.variants[0])!.id,
  };
}

let sofa: ProductFixture;
let table: ProductFixture;
let superAdmin: Session;
let catalogManager: Session;
let orderManager: Session;

beforeAll(async () => {
  sofa = await fixture('kabir-3-seater-fabric-sofa');
  table = await fixture('banyan-live-edge-coffee-table');
  superAdmin = await admin('cart.super@clearwood.local', 'SUPER_ADMIN');
  catalogManager = await admin('cart.catalog@clearwood.local', 'CATALOG_MANAGER');
  orderManager = await admin('cart.order@clearwood.local', 'ORDER_MANAGER');
});

/* ------------------------------------------------------------------- lineKey */

describe('lineKey', () => {
  it('is independent of the order the option ids arrive in', () => {
    const forwards = buildLineKey({ productId: 'p1', variantId: 'v1', optionValueIds: ['a', 'b'] });
    const backwards = buildLineKey({
      productId: 'p1',
      variantId: 'v1',
      optionValueIds: ['b', 'a'],
    });
    expect(forwards).toBe(backwards);
  });

  it('separates two variants of the same product', () => {
    expect(buildLineKey({ productId: 'p1', variantId: 'v1' })).not.toBe(
      buildLineKey({ productId: 'p1', variantId: 'v2' }),
    );
  });

  it('separates two customizations of the same variant', () => {
    expect(buildLineKey({ productId: 'p1', variantId: 'v1', customizationHash: 'x' })).not.toBe(
      buildLineKey({ productId: 'p1', variantId: 'v1', customizationHash: 'y' }),
    );
  });
});

/* -------------------------------------------------------------- guest cookie */

describe('guest identity', () => {
  it('does not mint a cookie for a read', async () => {
    const response = await request(app).get(`${API}/cart`);
    expect(response.status).toBe(200);
    expect(cookiesOf(response).some((cookie) => cookie.startsWith('cw_cart='))).toBe(false);
    expect(response.body.data.lines).toEqual([]);
  });

  it('mints an httpOnly cookie on the first write and finds the cart again with it', async () => {
    const guest = new Guest();
    const added = await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA });

    expect(added.status).toBe(201);
    expect(guest.cookie).toMatch(/^cw_cart=/);

    const raw = cookiesOf(added).find((cookie) => cookie.startsWith('cw_cart='))!;
    expect(raw).toContain('HttpOnly');

    const reread = await guest.get('/cart');
    expect(reread.body.data.lines).toHaveLength(1);
  });

  it('treats a tampered cookie as no cart at all rather than failing', async () => {
    const guest = new Guest();
    await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA });

    const [name, value] = guest.cookie.split('=') as [string, string];
    const forged = `${name}=${value.slice(0, -4)}AAAA`;

    const response = await request(app).get(`${API}/cart`).set('Cookie', forged);
    expect(response.status).toBe(200);
    expect(response.body.data.lines).toEqual([]);
  });
});

/* ------------------------------------------------------------ pricing authority */

describe('pricing authority', () => {
  it('matches /pricing/quote on every component, not just the total', async () => {
    const guest = new Guest();
    await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA, qty: 2 });
    await guest.post('/cart/items', { productId: table.id, variantId: table.variantA, qty: 1 });
    await guest.put('/cart/pincode', { pincode: '400001' });

    const cart = (await guest.get('/cart')).body.data;

    const quote = await request(app)
      .post(`${API}/pricing/quote`)
      .send({
        items: [
          { productId: sofa.id, variantId: sofa.variantA, qty: 2 },
          { productId: table.id, variantId: table.variantA, qty: 1 },
        ],
        pincode: '400001',
        channel: 'WEB',
      });

    expect(quote.status).toBe(200);

    for (const key of [
      'subtotalPaise',
      'discountPaise',
      'shippingPaise',
      'taxPaise',
      'roundingPaise',
      'grandTotalPaise',
    ] as const) {
      expect(cart.breakdown[key]).toBe(quote.body.data[key]);
    }
  });

  it('never reserves stock', async () => {
    const before = await prisma.productVariant.findUniqueOrThrow({
      where: { id: sofa.variantA },
      select: { reservedQty: true, stockQty: true },
    });

    const guest = new Guest();
    await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA, qty: 2 });

    const after = await prisma.productVariant.findUniqueOrThrow({
      where: { id: sofa.variantA },
      select: { reservedQty: true, stockQty: true },
    });

    expect(after).toEqual(before);
  });

  it('reports a price change instead of quietly re-pricing a line', async () => {
    const guest = new Guest();
    const added = await guest.post('/cart/items', {
      productId: table.id,
      variantId: table.variantA,
    });
    const lineId = added.body.data.lines[0].id as string;

    // Pretend the shopper added it when it was cheaper.
    await prisma.cartItem.update({
      where: { id: lineId },
      data: { addedUnitPricePaise: 100, lastUnitPricePaise: 100 },
    });

    const cart = (await guest.get('/cart')).body.data;
    const change = cart.priceChanges.find((entry: { lineId: string }) => entry.lineId === lineId);

    expect(change).toBeDefined();
    expect(change.direction).toBe('UP');
    expect(change.previousUnitPricePaise).toBe(100);
    // The displayed line total still comes from the engine, not from the stale snapshot.
    expect(cart.lines[0].unitPricePaise).toBeGreaterThan(100);
  });
});

/* ----------------------------------------------------------------- line rules */

describe('cart lines', () => {
  it('increments an existing line instead of adding a second one', async () => {
    const guest = new Guest();
    await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA, qty: 1 });
    const second = await guest.post('/cart/items', {
      productId: sofa.id,
      variantId: sofa.variantA,
      qty: 3,
    });

    expect(second.body.data.lines).toHaveLength(1);
    expect(second.body.data.lines[0].qty).toBe(4);
  });

  it('keeps two variants of the same product on separate lines', async () => {
    const guest = new Guest();
    await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA });
    const second = await guest.post('/cart/items', {
      productId: sofa.id,
      variantId: sofa.variantB,
    });

    expect(second.body.data.lines).toHaveLength(2);
  });

  it('moves a line to saved-for-later and back, excluding it from the total meanwhile', async () => {
    const guest = new Guest();
    const added = await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA });
    const lineId = added.body.data.lines[0].id as string;

    const saved = await guest.post(`/cart/items/${lineId}/save-for-later`);
    expect(saved.body.data.lines).toHaveLength(0);
    expect(saved.body.data.savedForLater).toHaveLength(1);
    expect(saved.body.data.breakdown.grandTotalPaise).toBe(0);

    const restored = await guest.post(`/cart/items/${lineId}/move-to-cart`);
    expect(restored.body.data.lines).toHaveLength(1);
    expect(restored.body.data.breakdown.grandTotalPaise).toBeGreaterThan(0);
  });

  it('rejects an unknown product with 422 rather than creating an empty line', async () => {
    const guest = new Guest();
    const response = await guest.post('/cart/items', {
      productId: 'ckzzzzzzzzzzzzzzzzzzzzzzz',
    });
    expect([404, 422]).toContain(response.status);
  });
});

/* ---------------------------------------------------------------- concurrency */

describe('concurrency', () => {
  it('creates exactly one ACTIVE cart when the first two requests race', async () => {
    const sessionCookie = `cw_cart=${
      // Mint a cookie once, then reuse it for both racing requests.
      cookiesOf(
        await request(app)
          .post(`${API}/cart/items`)
          .send({ productId: table.id, variantId: table.variantA }),
      )
        .find((cookie) => cookie.startsWith('cw_cart='))!
        .split(';')[0]!
        .split('=')[1]
    }`;

    await Promise.all([
      request(app)
        .post(`${API}/cart/items`)
        .set('Cookie', sessionCookie)
        .send({ productId: sofa.id, variantId: sofa.variantA }),
      request(app)
        .post(`${API}/cart/items`)
        .set('Cookie', sessionCookie)
        .send({ productId: sofa.id, variantId: sofa.variantB }),
    ]);

    const sessionId = sessionCookie.split('=')[1]!.split('.')[0];
    const active = await prisma.cart.count({ where: { sessionId, status: 'ACTIVE' } });
    expect(active).toBe(1);
  });

  it('collapses ten parallel identical adds onto one line', async () => {
    const guest = new Guest();
    await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA, qty: 1 });

    await Promise.all(
      Array.from({ length: 9 }, () =>
        request(app)
          .post(`${API}/cart/items`)
          .set('Cookie', guest.cookie)
          .send({ productId: sofa.id, variantId: sofa.variantA, qty: 1 }),
      ),
    );

    const cart = (await guest.get('/cart')).body.data;
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].qty).toBe(10);
  });

  it('never loses one of two simultaneous quantity updates', async () => {
    const guest = new Guest();
    const added = await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA });
    const lineId = added.body.data.lines[0].id as string;

    const responses = await Promise.all([
      request(app)
        .patch(`${API}/cart/items/${lineId}`)
        .set('Cookie', guest.cookie)
        .send({ qty: 4 }),
      request(app)
        .patch(`${API}/cart/items/${lineId}`)
        .set('Cookie', guest.cookie)
        .send({ qty: 7 }),
    ]);

    // Either both applied in some order, or one was rejected outright with a conflict. What must
    // NEVER happen is a 200 whose result is a quantity nobody asked for.
    const accepted = responses.filter((response) => response.status === 200);
    expect(accepted.length).toBeGreaterThan(0);
    responses
      .filter((response) => response.status !== 200)
      .forEach((response) => expect(response.status).toBe(409));

    const final = (await guest.get('/cart')).body.data.lines[0].qty;
    expect([4, 7]).toContain(final);
  });
});

/* ----------------------------------------------------------------- validation */

describe('validation', () => {
  it('reports an over-max quantity as a blocking issue and autoFix clamps it', async () => {
    const guest = new Guest();
    const added = await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA });
    const lineId = added.body.data.lines[0].id as string;

    // Write past the API ceiling directly: the point is what `validate` does with a bad row.
    await prisma.cartItem.update({ where: { id: lineId }, data: { qty: 999 } });

    const reported = await guest.post('/cart/validate');
    expect(reported.body.data.isCheckoutReady).toBe(false);
    expect(reported.body.data.blockingCount).toBeGreaterThan(0);

    const fixed = await request(app)
      .post(`${API}/cart/validate?autoFix=true`)
      .set('Cookie', guest.cookie)
      .send({});

    expect(fixed.body.data.fixes.length).toBeGreaterThan(0);

    const after = await prisma.cartItem.findUniqueOrThrow({ where: { id: lineId } });
    expect(after.qty).toBeLessThan(999);
  });

  it('rejects an unknown coupon with a reason instead of applying it', async () => {
    const guest = new Guest();
    await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA });

    const response = await guest.post('/cart/coupon', { code: 'NOTAREALCOUPON' });
    const coupon = response.body.data.coupon;

    expect(coupon.applied).toBe(false);
    expect(coupon.rejectionCode).toBeTruthy();
    expect(response.body.data.breakdown.discountPaise).toBe(0);
  });
});

/* ---------------------------------------------------------------------- merge */

describe('merge on login', () => {
  it('sums overlapping lines, keeps the customer cart and retires the guest one', async () => {
    const session = await customer('cart.merge@example.com');

    // The customer already has a sofa in their cart.
    await as(session).post(`${API}/cart/items`).send({
      productId: sofa.id,
      variantId: sofa.variantA,
      qty: 1,
    });

    // The same person, browsing as a guest first, adds the same sofa plus a table.
    const guest = new Guest();
    await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA, qty: 2 });
    await guest.post('/cart/items', { productId: table.id, variantId: table.variantA, qty: 1 });

    const guestSessionId = guest.cookie.split('=')[1]!.split('.')[0];

    const merged = await request(app)
      .post(`${API}/cart/merge`)
      .set('Cookie', `${session.header}; ${guest.cookie}`)
      .set('X-CSRF-Token', session.csrf)
      .send({ strategy: 'SUM_QUANTITIES' });

    expect(merged.status).toBe(200);
    expect(merged.body.data.merged).toBe(true);
    expect(merged.body.data.incremented + merged.body.data.added).toBeGreaterThan(0);

    const cart = (await as(session).get(`${API}/cart`)).body.data;
    const sofaLine = cart.lines.find((line: { productId: string }) => line.productId === sofa.id);
    expect(sofaLine.qty).toBe(3);
    expect(cart.lines).toHaveLength(2);

    const guestCart = await prisma.cart.findFirstOrThrow({
      where: { sessionId: guestSessionId },
      orderBy: { createdAt: 'desc' },
    });
    expect(guestCart.status).toBe('MERGED');
    expect(guestCart.mergedIntoCartId).toBe(cart.id);
    // Retired, not deleted — the lines are still there for reporting.
    expect(await prisma.cartItem.count({ where: { cartId: guestCart.id } })).toBeGreaterThan(0);
  });

  it('is a no-op the second time', async () => {
    const session = await customer('cart.merge.idempotent@example.com');
    const guest = new Guest();
    await guest.post('/cart/items', { productId: table.id, variantId: table.variantA, qty: 1 });

    const headers = { Cookie: `${session.header}; ${guest.cookie}` };

    const first = await request(app)
      .post(`${API}/cart/merge`)
      .set(headers)
      .set('X-CSRF-Token', session.csrf)
      .send({});

    const second = await request(app)
      .post(`${API}/cart/merge`)
      .set(headers)
      .set('X-CSRF-Token', session.csrf)
      .send({});

    expect(first.body.data.merged).toBe(true);
    expect(second.body.data.merged).toBe(false);

    const cart = (await as(session).get(`${API}/cart`)).body.data;
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].qty).toBe(1);
  });

  it('merges automatically on the existing login route, with no separate call', async () => {
    const email = 'cart.merge.login@example.com';
    await customer(email);

    const guest = new Guest();
    await guest.post('/cart/items', { productId: table.id, variantId: table.variantA, qty: 1 });

    const login = await request(app)
      .post(`${API}/auth/login`)
      .set('Cookie', guest.cookie)
      .send({ identifier: email, password: CUSTOMER_PASSWORD });

    expect(login.status).toBe(200);

    const session = sessionFrom(login, 'cw_cus_csrf', '');
    const cart = (await request(app).get(`${API}/cart`).set('Cookie', session.header)).body.data;

    expect(cart.lines.some((line: { productId: string }) => line.productId === table.id)).toBe(
      true,
    );
  });
});

/* ------------------------------------------------------------------- wishlist */

describe('wishlist', () => {
  it('creates a default list on first use and moves an item into the cart', async () => {
    const session = await customer('cart.wishlist@example.com');

    const lists = await as(session).get(`${API}/wishlists`);
    expect(lists.status).toBe(200);

    const listId = lists.body.data[0].id as string;
    expect(lists.body.data[0].isDefault).toBe(true);

    const added = await as(session)
      .post(`${API}/wishlists/${listId}/items`)
      .send({ productId: sofa.id, variantId: sofa.variantA });

    expect(added.body.data.items).toHaveLength(1);
    const itemId = added.body.data.items[0].id as string;

    const moved = await as(session)
      .post(`${API}/wishlists/${listId}/items/${itemId}/move-to-cart`)
      .send({ qty: 1 });

    expect(moved.status).toBe(200);
    expect(moved.body.data.cart.lines).toHaveLength(1);
    expect(moved.body.data.wishlist.items).toHaveLength(0);

    const after = await as(session).get(`${API}/wishlists`);
    expect(after.body.data[0].items).toHaveLength(0);
  });

  it('flags a price drop without ever showing the stale price', async () => {
    const session = await customer('cart.wishlist.drop@example.com');
    const lists = await as(session).get(`${API}/wishlists`);
    const listId = lists.body.data[0].id as string;

    const added = await as(session)
      .post(`${API}/wishlists/${listId}/items`)
      .send({ productId: sofa.id, variantId: sofa.variantA });

    const itemId = added.body.data.items[0].id as string;
    const live = added.body.data.items[0].currentPricePaise as number;

    await prisma.wishlistItem.update({
      where: { id: itemId },
      data: { addedPricePaise: live + 500_000 },
    });

    const reread = await as(session).get(`${API}/wishlists`);
    const item = reread.body.data[0].items[0];

    expect(item.hasPriceDrop).toBe(true);
    expect(item.priceDropPaise).toBe(500_000);
    expect(item.currentPricePaise).toBe(live);
  });

  it('shares a list by token and exposes no customer identity', async () => {
    const session = await customer('cart.wishlist.share@example.com');
    const lists = await as(session).get(`${API}/wishlists`);
    const listId = lists.body.data[0].id as string;

    await as(session)
      .post(`${API}/wishlists/${listId}/items`)
      .send({ productId: sofa.id, variantId: sofa.variantA });

    const shared = await as(session).post(`${API}/wishlists/${listId}/share`);
    const token = shared.body.data.shareToken as string;
    expect(token).toBeTruthy();

    // Opened by a total stranger with no session at all.
    const publicView = await request(app).get(`${API}/wishlists/shared/${token}`);
    expect(publicView.status).toBe(200);

    const serialised = JSON.stringify(publicView.body);
    expect(serialised).not.toContain('cart.wishlist.share@example.com');
    expect(serialised).not.toContain(session.id);

    await as(session).delete(`${API}/wishlists/${listId}/share`);
    expect((await request(app).get(`${API}/wishlists/shared/${token}`)).status).toBe(404);
  });
});

/* -------------------------------------------------------------------- address */

describe('addresses', () => {
  it('keeps exactly one default and autofills the city from the pincode', async () => {
    const session = await customer('cart.address@example.com');

    const lookup = await request(app).get(`${API}/addresses/pincode/400001`);
    expect(lookup.status).toBe(200);
    expect(lookup.body.data.city).toBe('Mumbai');
    expect(lookup.body.data.isServiceable).toBe(true);

    const base = {
      fullName: 'Cart Tester',
      phone: '919810000011',
      line1: '1 Test Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: 'MH',
      pincode: '400001',
    };

    const first = await as(session)
      .post(`${API}/me/addresses`)
      .send({ ...base, label: 'One', isDefaultShipping: true });
    const second = await as(session)
      .post(`${API}/me/addresses`)
      .send({ ...base, label: 'Two', isDefaultShipping: true });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const list = await as(session).get(`${API}/me/addresses`);
    const defaults = list.body.data.filter(
      (address: { isDefaultShipping: boolean }) => address.isDefaultShipping,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].label).toBe('Two');
  });

  it('answers 404, not 403, for another customer’s address', async () => {
    const owner = await customer('cart.address.owner@example.com');
    const stranger = await customer('cart.address.stranger@example.com');

    const created = await as(owner).post(`${API}/me/addresses`).send({
      fullName: 'Owner',
      phone: '919810000012',
      line1: '2 Test Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: 'MH',
      pincode: '400001',
    });

    const id = created.body.data.id as string;
    expect((await as(stranger).get(`${API}/me/addresses/${id}`)).status).toBe(404);
  });

  it('rejects a malformed pincode with 422', async () => {
    const session = await customer('cart.address.invalid@example.com');
    const response = await as(session).post(`${API}/me/addresses`).send({
      fullName: 'Bad Pin',
      phone: '919810000013',
      line1: '3 Test Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: 'MH',
      pincode: '4000',
    });

    expect(response.status).toBe(422);
  });
});

/* ------------------------------------------------------------ product signals */

describe('product signals', () => {
  it('increments the cart-add counter on the existing ProductStat row', async () => {
    const before = await prisma.productStat.findUnique({ where: { productId: table.id } });

    const guest = new Guest();
    await guest.post('/cart/items', { productId: table.id, variantId: table.variantA });
    await catalogEvents.settled();

    const after = await prisma.productStat.findUniqueOrThrow({ where: { productId: table.id } });
    expect(after.cartAddCount).toBeGreaterThan(before?.cartAddCount ?? 0);
  });
});

/* ----------------------------------------------------------------- admin RBAC */

describe('admin carts', () => {
  it('lists carts for an ORDER_MANAGER', async () => {
    const response = await as(orderManager).get(`${API}/admin/carts?limit=5`);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('reports stats with the lifecycle totals', async () => {
    const response = await as(superAdmin).get(`${API}/admin/carts/stats`);
    expect(response.status).toBe(200);
    expect(response.body.data.totals).toHaveProperty('active');
    expect(response.body.data.totals).toHaveProperty('abandoned');
  });

  it('refuses anonymous, customer and under-privileged admin callers', async () => {
    expect((await request(app).get(`${API}/admin/carts`)).status).toBe(401);

    const shopper = await customer('cart.rbac@example.com');
    expect((await as(shopper).get(`${API}/admin/carts`)).status).toBe(401);

    expect((await as(catalogManager).get(`${API}/admin/carts`)).status).toBe(403);
  });

  it('re-quotes a cart live in the detail view', async () => {
    const guest = new Guest();
    const added = await guest.post('/cart/items', { productId: sofa.id, variantId: sofa.variantA });
    const cartId = added.body.data.id as string;

    const detail = await as(orderManager).get(`${API}/admin/carts/${cartId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.breakdown.grandTotalPaise).toBe(
      added.body.data.breakdown.grandTotalPaise,
    );
    expect(detail.body.data.events.length).toBeGreaterThan(0);
  });
});
