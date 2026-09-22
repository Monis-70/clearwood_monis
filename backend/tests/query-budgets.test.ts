import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { cache } from '../src/container';
import { CATALOG_CACHE_PREFIXES } from '../src/modules/catalog-admin/catalogCache.service';
import { pageRendererService } from '../src/modules/cms/pageRenderer.service';
import { pricingFacade } from '../src/modules/pricing/pricing.facade';
import { QUERY_BUDGETS, type QueryBudgetName } from '../src/perf/queryBudgets';

import { Shopper } from './helpers/paidOrder';
import { countQueries } from './helpers/queryCounter';

/**
 * Enforces src/perf/queryBudgets.ts.
 *
 * Two different assertions, deliberately:
 *   - a CEILING, which catches a path drifting upward;
 *   - an EQUALITY across response sizes, which is the only assertion that can distinguish a
 *     batched query from an N+1 whose list is short in the seed data.
 *
 * Every count is also asserted to be non-zero, so a route that silently stops touching the
 * database — a 404, an empty result, an early return — cannot pass by measuring nothing.
 */

const app = createApp();
const API = '/api/v1';

/** Budgets describe the COLD page. Prefixes are dropped directly rather than through the
 *  invalidators, because those emit events whose asynchronous reindex bleeds into the next count. */
const PAGE_CACHE_PREFIXES = [
  CATALOG_CACHE_PREFIXES.storefrontListing,
  CATALOG_CACHE_PREFIXES.storefrontFacets,
  CATALOG_CACHE_PREFIXES.storefrontPdp,
  CATALOG_CACHE_PREFIXES.storefrontSuggest,
  CATALOG_CACHE_PREFIXES.category,
  CATALOG_CACHE_PREFIXES.cmsPage,
];

/**
 * Waits until nothing is still writing.
 *
 * Adding ten cart lines fires ten rounds of catalog events whose handlers reindex and recount in
 * the background. One of those landing inside a measurement window adds a query that has nothing
 * to do with the path being measured, which made the cart comparison read 36 against 37 on one run
 * and 36 against 36 on the next. Draining first makes the count depend only on the request.
 */
async function quiesce(): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const { count } = await countQueries(async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    });

    if (count === 0) return;
  }

  throw new Error('background database work never settled; a measurement here would be noise');
}

interface Profile {
  queries: number;
  reads: string;
  writes: number;
}

async function count(run: () => Promise<unknown>): Promise<number> {
  return (await profile(run)).queries;
}

async function profile(run: () => Promise<unknown>): Promise<Profile> {
  for (const prefix of PAGE_CACHE_PREFIXES) await cache.delByPrefix(prefix);
  await quiesce();

  const { count: queries, statements } = await countQueries(run);

  // G1: a path that issued no queries at all was not exercised, whatever the ceiling says.
  expect(queries).toBeGreaterThan(0);

  const tally = new Map<string, number>();
  let writes = 0;

  for (const sql of statements) {
    // Schema-agnostic on purpose: it is `main` on SQLite and the database name on MySQL.
    const table = /FROM `[^`]+`\.`(\w+)`/.exec(sql)?.[1];
    if (table && /^SELECT/i.test(sql)) {
      tally.set(table, (tally.get(table) ?? 0) + 1);
      continue;
    }
    writes += 1;
  }

  const reads = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name}=${n}`)
    .join(' ');

  // G1: an empty tally would make every scale-invariance comparison below compare '' with ''.
  expect(reads, 'no SELECT was attributed to a table; the log matcher is wrong').not.toBe('');

  return { queries, reads, writes };
}

/**
 * Scale invariance, asserted on the READ profile rather than on the raw total.
 *
 * The read tally is the thing an N+1 shows up in, and comparing it table by table is stricter than
 * comparing a single number: resolving a gallery per cart line moved ProductMedia, Media and
 * MediaVariant from zero to ten each, which this would have caught even if some other query had
 * coincidentally dropped by thirty.
 *
 * Writes are counted but not compared exactly, because a fire-and-forget event handler fired by
 * the request under measurement may or may not land inside the window — that race is what made an
 * otherwise identical cart read report 36 against 37 on one run in three. A per-line WRITE pattern
 * is still caught: at one line against ten it would differ by nine, not by one.
 */
function expectSameShape(label: string, small: Profile, large: Profile, lineDelta: number): void {
  expect(
    large.reads,
    `${label} did not issue the same queries at both sizes.\n  smaller: ${small.reads}\n  larger : ${large.reads}`,
  ).toBe(small.reads);

  expect(
    large.writes - small.writes,
    `${label} issued ${small.writes} writes at the smaller size and ${large.writes} at the larger`,
  ).toBeLessThan(lineDelta);
}

function expectWithin(name: QueryBudgetName, queries: number): void {
  const budget = QUERY_BUDGETS[name];

  // Printed so a provider change can be compared against the recorded figures, not guessed at.
  console.log(`[budget] ${name} ${queries} (recorded ${budget.measured}, ceiling ${budget.ceiling})`);

  expect(
    queries,
    `${name} (${budget.path}) issued ${queries} queries, over its ceiling of ${budget.ceiling}. ` +
      'Batch the extra queries. Raising the ceiling requires recording why in queryBudgets.ts.',
  ).toBeLessThanOrEqual(budget.ceiling);
}

let slugs: string[] = [];
let categorySlug = '';

beforeAll(async () => {
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    select: { slug: true },
    orderBy: { slug: 'asc' },
    take: 48,
  });
  slugs = products.map((product) => product.slug);

  const category = await prisma.category.findFirstOrThrow({
    where: { isActive: true, deletedAt: null, depth: 0 },
    select: { slug: true },
  });
  categorySlug = category.slug;

  // Warm the settings and tax caches: a first-ever read is not part of a steady-state budget.
  await request(app).get(`${API}/catalog/products/${slugs[0]}`);
  await request(app).get(`${API}/catalog/products?limit=24`);
  await request(app).get(`${API}/search?q=sofa&limit=24`);
  await request(app).get(`${API}/catalog/categories/${categorySlug}`);
  await pageRendererService.renderHome({ device: 'DESKTOP' });
  await pricingFacade.quoteCart({ items: [{ slug: slugs[0]!, qty: 1 }], channel: 'WEB' });
}, 120_000);

describe('query budgets', () => {
  it('every budget records a measurement, a ceiling above it, and a reason', () => {
    for (const [name, budget] of Object.entries(QUERY_BUDGETS)) {
      expect(budget.measured, `${name} has no recorded measurement`).toBeGreaterThan(0);
      expect(budget.ceiling, `${name} ceiling is below its own measurement`).toBeGreaterThanOrEqual(
        budget.measured,
      );
      expect(budget.note, `${name} has no recorded justification`).toBeTruthy();
    }
  });

  it('PDP stays within budget', async () => {
    expectWithin('PDP', await count(() => request(app).get(`${API}/catalog/products/${slugs[0]}`)));
  }, 60_000);

  it('listing stays within budget and does not grow with the page size', async () => {
    const sizes = [6, 24, 48];
    const runs: Profile[] = [];
    for (const size of sizes) {
      runs.push(await profile(() => request(app).get(`${API}/catalog/products?limit=${size}`)));
    }

    expectWithin('LISTING', Math.max(...runs.map((run) => run.queries)));
    expectSameShape('a listing of 6 against 24 products', runs[0]!, runs[1]!, 18);
    expectSameShape('a listing of 6 against 48 products', runs[0]!, runs[2]!, 42);
  }, 120_000);

  it('search stays within budget', async () => {
    expectWithin('SEARCH', await count(() => request(app).get(`${API}/search?q=sofa&limit=24`)));
  }, 60_000);

  it('category landing stays within budget', async () => {
    expectWithin(
      'CATEGORY_LANDING',
      await count(() => request(app).get(`${API}/catalog/categories/${categorySlug}`)),
    );
  }, 60_000);

  it('a cart quote stays within budget and does not grow with the line count', async () => {
    const one = await profile(() =>
      pricingFacade.quoteCart({ items: [{ slug: slugs[0]!, qty: 1 }], channel: 'WEB' }),
    );
    const forty = await profile(() =>
      pricingFacade.quoteCart({
        items: slugs.slice(0, 40).map((slug) => ({ slug, qty: 1 })),
        channel: 'WEB',
      }),
    );

    expectWithin('QUOTE_CART', Math.max(one.queries, forty.queries));
    expectSameShape('a quote of 1 against 40 lines', one, forty, 39);
  }, 120_000);

  it('reading a cart stays within budget and does not grow with the line count', async () => {
    const ten = request.agent(app);
    await ten.post(`${API}/cart`).send({});
    for (const slug of slugs.slice(0, 10)) {
      await ten.post(`${API}/cart/items`).send({ slug, qty: 1 });
    }

    const one = request.agent(app);
    await one.post(`${API}/cart`).send({});
    await one.post(`${API}/cart/items`).send({ slug: slugs[0], qty: 1 });

    const tenLines = await profile(() => ten.get(`${API}/cart`));
    const oneLine = await profile(() => one.get(`${API}/cart`));

    expectWithin('CART_READ', Math.max(oneLine.queries, tenLines.queries));
    expectSameShape('a cart read of 1 against 10 lines', oneLine, tenLines, 9);
  }, 120_000);

  it('checkout init stays within budget and does not grow with the line count', async () => {
    const address = {
      fullName: 'Budget Buyer',
      phone: '919810000123',
      line1: '14 Residency Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      stateCode: 'KA',
      pincode: '560025',
    };

    const init = async (lines: number, email: string) => {
      const shopper = new Shopper();
      for (const slug of slugs.slice(0, lines)) {
        await shopper.post('/cart/items', { slug, qty: 1 });
      }

      let status = 0;
      const run = await profile(async () => {
        const response = await shopper.post('/checkout/init', {
          contact: { email, phone: address.phone },
          shippingAddress: address,
          sameAsShipping: true,
        });
        status = response.status;
      });

      expect(status).toBe(201);
      return run;
    };

    const oneLine = await init(1, 'budget.one@example.com');
    const fiveLines = await init(5, 'budget.five@example.com');

    expectWithin('CHECKOUT_INIT', Math.max(oneLine.queries, fiveLines.queries));
    expectSameShape('checkout init of 1 against 5 lines', oneLine, fiveLines, 4);
  }, 120_000);

  it('the home page stays within budget and does not grow with the block count', async () => {
    const thirteen = await profile(() => pageRendererService.renderHome({ device: 'DESKTOP' }));

    const home = await prisma.page.findFirstOrThrow({
      where: { type: 'HOME', status: 'PUBLISHED', deletedAt: null },
      include: { blocks: { orderBy: { position: 'asc' } } },
    });
    const before = home.blocks.length;

    // Clones of real blocks, so the extra five do the same data-loading work the originals do.
    await prisma.pageBlock.createMany({
      data: home.blocks.slice(0, 5).map((block, index) => ({
        pageId: home.id,
        type: block.type,
        position: 100 + index,
        isActive: true,
        deviceVisibility: 'ALL',
        configJson: block.configJson,
      })),
    });

    const eighteen = await profile(() => pageRendererService.renderHome({ device: 'DESKTOP' }));

    expectWithin('HOME', Math.max(thirteen.queries, eighteen.queries));
    expectSameShape(
      `the home page with ${before} against ${before + 5} blocks`,
      thirteen,
      eighteen,
      5,
    );
  }, 120_000);

  it('admin order detail stays within budget', async () => {
    const login = await request(app)
      .post(`${API}/admin/auth/login`)
      .send({ email: 'admin@clearwood.local', password: 'ChangeMe@12345' });

    const jar = (login.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const cookie = jar.map((entry) => entry.split(';')[0]).join('; ');

    const order = await prisma.order.findFirstOrThrow({ select: { id: true } });

    let status = 0;
    const queries = await count(async () => {
      const response = await request(app)
        .get(`${API}/admin/orders/${order.id}`)
        .set('Cookie', cookie);
      status = response.status;
    });

    expect(status).toBe(200);
    expectWithin('ADMIN_ORDER_DETAIL', queries);
  }, 60_000);
});
