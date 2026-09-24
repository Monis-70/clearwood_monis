import { execSync, fork, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { format } from 'mysql2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma, prismaEvents } from '../src/config/prisma';
import { cache, payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { catalogEvents } from '../src/events/catalogEvents';
import { passwordService } from '../src/modules/auth/password.service';

import { buildBenchCatalog } from './helpers/benchCatalog';
import { setStockForProduct } from './helpers/stock';

/**
 * Request-level performance baseline: the storefront's hot paths, one at a time and under load.
 *
 * Opt-in (CLEARWOOD_PERF_BASELINE=1). CLEARWOOD_PERF_PRODUCTS adds that many synthetic products
 * (helpers/benchCatalog.ts) to the seeded demo catalog; 0 measures the seed alone. Each path runs
 * CLEARWOOD_PERF_RUNS times cold (result caches dropped, config caches warm) and as many times warm;
 * the report gives p50/p95 wall time, SQL statements, database time, InnoDB rows read, JSON and
 * gzip bytes, cache hits, statements repeated within one request, and EXPLAIN for the slowest.
 *
 * CLEARWOOD_PERF_CONCURRENCY=1,10,25,50,100 then forks a real HTTP server (production pool:
 * connection_limit=8; Redis when CLEARWOOD_PERF_REDIS_URL is set) and drives a storefront mix at
 * each level for CLEARWOOD_PERF_SECONDS, sampling server RSS, CPU, event-loop delay, MySQL
 * connections and the MySQL container's CPU. CLEARWOOD_PERF_OUT writes everything as JSON.
 */

const enabled = process.env.CLEARWOOD_PERF_BASELINE === '1';
const PRODUCTS = Number(process.env.CLEARWOOD_PERF_PRODUCTS ?? 0);
const RUNS = Number(process.env.CLEARWOOD_PERF_RUNS ?? 20);
const LEVELS = (process.env.CLEARWOOD_PERF_CONCURRENCY ?? '')
  .split(',')
  .map(Number)
  .filter((level) => level > 0);
const SECONDS = Number(process.env.CLEARWOOD_PERF_SECONDS ?? 15);
const REDIS_URL = process.env.CLEARWOOD_PERF_REDIS_URL;
const ONLY = process.env.CLEARWOOD_PERF_ONLY?.split(',').filter(Boolean);
const OUT = process.env.CLEARWOOD_PERF_OUT;
const DB_CONTAINER = process.env.CLEARWOOD_PERF_DB_CONTAINER ?? 'clearwood-mysql';
const PROFILE_DIR = process.env.CLEARWOOD_PERF_CPU_PROFILE_DIR;
const NODE_ARGS = (process.env.CLEARWOOD_PERF_NODE_ARGS ?? '').split(' ').filter(Boolean);
const EXPORTS = process.env.CLEARWOOD_PERF_EXPORT === '1';
const API = '/api/v1';
const app = createApp();
const mock = paymentDriver as MockPaymentDriver;

/** Per-shopper and per-URL results; configuration caches (settings, tax, tree) stay warm. */
const RESULT_CACHES = [
  'sf:list:',
  'sf:facet:',
  'sf:pdp:',
  'sf:sugg:',
  'price:quote:',
  'prod:',
  'coll:',
  'cms:page:',
];

interface Captured {
  sql: string;
  params: string;
  duration: number;
}

interface Sample {
  wallMs: number;
  queries: number;
  dbMs: number;
  bytes: number;
  hits: number;
  misses: number;
  rowsRead: number;
  dbBytesSent: number;
}

interface Summary {
  key: string;
  label: string;
  mode: 'cold' | 'warm';
  p50: number;
  p95: number;
  max: number;
  queries: number;
  dbMs: number;
  bytes: number;
  gzipBytes: number;
  hits: number;
  misses: number;
  rowsRead: number;
  dbBytesSent: number;
}

interface Session {
  cookie: string;
  csrf: string;
}

let sink: Captured[] | null = null;
const lookups = { hits: 0, misses: 0 };
const summaries: Summary[] = [];
const statementLog: Record<string, string[]> = {};
const environment: Record<string, unknown> = {};
const levels: Record<string, unknown>[] = [];

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
};
const round = (value: number): number => Math.round(value * 10) / 10;

function shape(sql: string): string {
  const verb = sql.trim().split(/\s+/)[0]!.toUpperCase();
  const table =
    /(?:FROM|INTO|UPDATE) `[^`]+`\.`(\w+)`/.exec(sql)?.[1] ??
    /(?:FROM|INTO) `?(\w+)`?/.exec(sql)?.[1];
  const where = / WHERE (.*?)(?: ORDER BY| LIMIT| GROUP BY|$)/s.exec(sql)?.[1] ?? '';
  return `${verb} ${table ?? '?'} ${where.replace(/`[^`]+`\./g, '').slice(0, 160)}`.trim();
}

function repeatedShapes(captured: Captured[]): string[] {
  const counts = new Map<string, number>();
  for (const row of captured) counts.set(row.sql, (counts.get(row.sql) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([sql, count]) => `${count}x ${shape(sql)}`);
}

async function innodbRowsRead(): Promise<{ rows: number; bytesSent: number }> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_rows_read', 'Bytes_sent')",
  );
  const value = (name: string) => {
    const row = rows.find((entry) => (entry.Variable_name ?? entry.f0) === name) ?? {};
    return Number(row.Value ?? row.f1 ?? 0);
  };
  return { rows: value('Innodb_rows_read'), bytesSent: value('Bytes_sent') };
}

async function explain(row: Captured): Promise<string> {
  const bound = format(row.sql, JSON.parse(row.params) as string[]);
  const plan = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`EXPLAIN ${bound}`);
  const steps = plan
    .map((step) => {
      const name = step.table ?? step.f2;
      const type = step.type ?? step.f4;
      const key = step.key ?? step.f6 ?? '-';
      const estimate = step.rows ?? step.f9;
      const extra = step.Extra ?? step.f11;
      return `${String(name)}/${String(type)}/${String(key)}/${String(estimate)}${extra ? ` (${String(extra)})` : ''}`;
    })
    .join(' | ');
  return `${row.duration} ms ${shape(row.sql).slice(0, 90)} => ${steps}`;
}

async function dropResultCaches(): Promise<void> {
  for (const prefix of RESULT_CACHES) await cache.delByPrefix(prefix);
}

async function sampleOnce(send: () => request.Test, withRows: boolean) {
  await catalogEvents.settled();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const captured: Captured[] = [];
  const before = withRows ? await innodbRowsRead() : { rows: 0, bytesSent: 0 };
  lookups.hits = 0;
  lookups.misses = 0;
  sink = captured;
  const started = performance.now();
  const response = await send();
  const wallMs = performance.now() - started;
  await new Promise((resolve) => setImmediate(resolve));
  sink = null;
  const after = withRows ? await innodbRowsRead() : { rows: 0, bytesSent: 0 };

  expect(response.status, response.text.slice(0, 300)).toBeLessThan(300);
  const sample: Sample = {
    wallMs,
    queries: captured.length,
    dbMs: captured.reduce((sum, row) => sum + row.duration, 0),
    bytes: Buffer.byteLength(response.text),
    hits: lookups.hits,
    misses: lookups.misses,
    rowsRead: after.rows - before.rows,
    // The status query's own result set is a few hundred bytes of the delta.
    dbBytesSent: after.bytesSent - before.bytesSent,
  };
  return { sample, captured, text: response.text };
}

function summarise(
  key: string,
  label: string,
  mode: Summary['mode'],
  samples: Sample[],
  body: string,
) {
  const summary: Summary = {
    key,
    label,
    mode,
    p50: round(
      percentile(
        samples.map((s) => s.wallMs),
        0.5,
      ),
    ),
    p95: round(
      percentile(
        samples.map((s) => s.wallMs),
        0.95,
      ),
    ),
    max: round(Math.max(...samples.map((s) => s.wallMs))),
    queries: percentile(
      samples.map((s) => s.queries),
      0.5,
    ),
    dbMs: percentile(
      samples.map((s) => s.dbMs),
      0.5,
    ),
    bytes: percentile(
      samples.map((s) => s.bytes),
      0.5,
    ),
    gzipBytes: gzipSync(body).length,
    hits: percentile(
      samples.map((s) => s.hits),
      0.5,
    ),
    misses: percentile(
      samples.map((s) => s.misses),
      0.5,
    ),
    rowsRead: Math.max(...samples.map((s) => s.rowsRead)),
    dbBytesSent: Math.max(...samples.map((s) => s.dbBytesSent)),
  };
  summaries.push(summary);
  console.log(
    `[perf] ${key} ${label} ${mode}: p50 ${summary.p50} ms, p95 ${summary.p95} ms, ` +
      `${summary.queries} q, ${summary.dbMs} ms db, ${summary.bytes} B (${summary.gzipBytes} gz), ` +
      `cache ${summary.hits} hit/${summary.misses} miss${mode === 'cold' ? `, ${summary.rowsRead} rows read, ${summary.dbBytesSent} B from db` : ''}`,
  );
}

async function measure(key: string, label: string, send: () => request.Test): Promise<void> {
  if (ONLY && !ONLY.includes(key)) return;

  const cold: Sample[] = [];
  let coldCaptured: Captured[] = [];
  let body = '';
  for (let run = 0; run < RUNS; run += 1) {
    await dropResultCaches();
    const last = run === RUNS - 1;
    const { sample, captured, text } = await sampleOnce(send, last);
    cold.push(sample);
    if (last) {
      coldCaptured = captured;
      body = text;
    }
  }

  await send();
  const warm: Sample[] = [];
  for (let run = 0; run < RUNS; run += 1) warm.push((await sampleOnce(send, false)).sample);

  summarise(key, label, 'cold', cold, body);
  summarise(key, label, 'warm', warm, body);

  const repeated = repeatedShapes(coldCaptured);
  if (repeated.length > 0) console.log(`[perf]   repeated: ${repeated.join(' | ')}`);
  const top = [...coldCaptured]
    .filter((row) => /^\s*(SELECT|WITH)/i.test(row.sql))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 2);
  for (const row of top) console.log(`[perf]   slow: ${await explain(row)}`);
  statementLog[key] = coldCaptured.map((row) => `${row.duration}ms ${shape(row.sql)}`);
}

/* ------------------------------------------------------------ shoppers */

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | string | undefined;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function remember(session: Session, response: request.Response): void {
  const jar = new Map(
    session.cookie
      .split('; ')
      .filter(Boolean)
      .map((pair) => [pair.split('=')[0]!, pair] as const),
  );
  for (const cookie of cookiesOf(response)) {
    const pair = cookie.split(';')[0]!;
    jar.set(pair.split('=')[0]!, pair);
  }
  session.cookie = [...jar.values()].join('; ');
  session.csrf = jar.get('cw_cus_csrf')?.split('=')[1] ?? session.csrf;
}

async function post(session: Session, url: string, body: object): Promise<request.Response> {
  const response = await request(app)
    .post(`${API}${url}`)
    .set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf)
    .send(body);
  remember(session, response);
  return response;
}

async function signIn(): Promise<Session> {
  const email = 'perf.shopper@clearwood.local';
  const password = 'Rosewood-Teak-2026';
  await prisma.customer.create({
    data: {
      email,
      name: 'Perf Shopper',
      status: 'ACTIVE',
      passwordHash: await passwordService.hash(password),
      emailVerifiedAt: new Date(),
    },
  });
  const login = await request(app).post(`${API}/auth/login`).send({ identifier: email, password });
  expect(login.status).toBe(200);
  const session: Session = { cookie: '', csrf: '' };
  remember(session, login);
  return session;
}

const ADDRESS = {
  fullName: 'Perf Shopper',
  phone: '919810000123',
  line1: '14 Residency Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  stateCode: 'KA',
  pincode: '560025',
};

async function placeOrder(session: Session, productId: string): Promise<void> {
  const added = await post(session, '/cart/items', { productId, qty: 1 });
  expect(added.status, added.text).toBeLessThan(300);
  const init = await post(session, '/checkout/init', {
    contact: { email: 'perf.shopper@clearwood.local', phone: ADDRESS.phone },
    shippingAddress: ADDRESS,
    sameAsShipping: true,
  });
  expect(init.status, init.text).toBe(201);
  const placed = await post(session, `/checkout/${init.body.data.id}/place`, {
    paymentProvider: 'RAZORPAY',
  });
  expect(placed.status, placed.text).toBe(201);
  const verified = await post(
    session,
    '/checkout/verify',
    mock.simulateCheckout(placed.body.data.providerOrderId),
  );
  expect(verified.status, verified.text).toBe(200);
}

/* ---------------------------------------------------------------- load */

type Planned = {
  kind: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  auth?: boolean;
};

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function dockerCpuUsec(): number | null {
  try {
    const text = execSync(`docker exec ${DB_CONTAINER} cat /sys/fs/cgroup/cpu.stat`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return Number(/usage_usec (\d+)/.exec(text)?.[1] ?? NaN);
  } catch {
    return null;
  }
}

function ask<T>(child: ChildProcess, type: string, reply: string): Promise<T> {
  return new Promise((resolve) => {
    const listener = (message: { type: string }) => {
      if (message.type !== reply) return;
      child.off('message', listener);
      resolve(message as T);
    };
    child.on('message', listener);
    child.send({ type });
  });
}

async function startServer(): Promise<{ child: ChildProcess; port: number }> {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', '8');
  url.searchParams.set('pool_timeout', '20');
  const child = fork(path.join(process.cwd(), 'tests', 'helpers', 'perfServer.ts'), [], {
    execArgv: [
      '--import',
      'tsx',
      '--expose-gc',
      ...NODE_ARGS,
      ...(PROFILE_DIR ? ['--cpu-prof', `--cpu-prof-dir=${PROFILE_DIR}`] : []),
    ],
    cwd: process.cwd(),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      DATABASE_URL: url.toString(),
      LOG_LEVEL: 'silent',
      ...(REDIS_URL
        ? { CACHE_DRIVER: 'redis', REDIS_URL, REDIS_KEY_PREFIX: `perf${process.pid}:` }
        : { CACHE_DRIVER: 'memory' }),
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('message', (message: { type: string; port: number }) => resolve(message.port));
    child.once('exit', (code) => reject(new Error(`perf server exited with ${code}`)));
  });
  return { child, port };
}

async function drive(
  port: number,
  concurrency: number,
  seconds: number,
  plan: (random: () => number) => Planned,
  session: Session,
) {
  const latencies = new Map<string, number[]>();
  const statuses = new Map<number, number>();
  let errors = 0;
  const deadline = performance.now() + seconds * 1000;

  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      const random = prng(1_000 + worker * 7_919);
      while (performance.now() < deadline) {
        const next = plan(random);
        const started = performance.now();
        try {
          const response = await fetch(`http://127.0.0.1:${port}${API}${next.path}`, {
            method: next.method,
            headers: {
              'content-type': 'application/json',
              'accept-encoding': 'gzip',
              ...(next.auth ? { cookie: session.cookie } : {}),
            },
            ...(next.body ? { body: JSON.stringify(next.body) } : {}),
          });
          await response.arrayBuffer();
          statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
          if (response.status >= 400) errors += 1;
        } catch {
          errors += 1;
        }
        const list = latencies.get(next.kind) ?? [];
        list.push(performance.now() - started);
        latencies.set(next.kind, list);
      }
    }),
  );
  return { latencies, statuses, errors };
}

async function mysqlConnections(database: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    'SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB = ?',
    database,
  );
  return Number(rows[0]?.n ?? 0);
}

async function stopServer(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.send({ type: 'stop' });
  });
}

/* ------------------------------------------------------------------ run */

describe.skipIf(!enabled)('performance baseline', () => {
  let session: Session;
  let rootSlug = '';
  let slugs: string[] = [];
  let productIds: string[] = [];
  let exactTitle = '';
  let sku = '';
  let brandId: string | null = null;
  let attributeValueId: string | null = null;
  const categorySlugs: string[] = [];

  beforeAll(async () => {
    prismaEvents.$on(
      'query' as never,
      ((event: Captured & { query: string }) => {
        if (!sink || /^(BEGIN|COMMIT|ROLLBACK|SELECT 1\b)/i.test(event.query.trim())) return;
        sink.push({ sql: event.query, params: event.params, duration: event.duration });
      }) as never,
    );
    const get = cache.get.bind(cache);
    cache.get = (async (key: string) => {
      const value = await get(key);
      if (value === null) lookups.misses += 1;
      else lookups.hits += 1;
      return value;
    }) as typeof cache.get;

    const started = performance.now();
    if (PRODUCTS > 0) await buildBenchCatalog(PRODUCTS);
    environment.fixtureSeconds = round((performance.now() - started) / 1000);

    const [version] = await prisma.$queryRawUnsafe<Array<{ v: string }>>('SELECT VERSION() AS v');
    const [size] = await prisma.$queryRawUnsafe<Array<{ dataMb: number; indexMb: number }>>(
      'SELECT ROUND(SUM(data_length)/1048576,1) AS dataMb, ROUND(SUM(index_length)/1048576,1) AS indexMb FROM information_schema.TABLES WHERE table_schema = DATABASE()',
    );
    environment.node = process.version;
    environment.mysql = version?.v;
    environment.dataMb = Number(size?.dataMb ?? 0);
    environment.indexMb = Number(size?.indexMb ?? 0);
    for (const table of [
      'Product',
      'ProductVariant',
      'Category',
      'Attribute',
      'AttributeValue',
      'VariantAttributeValue',
      'ProductAttributeValue',
      'ProductListingAttribute',
      'SearchDocument',
      'Media',
    ]) {
      const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM \`${table}\``,
      );
      environment[table] = Number(row?.n ?? 0);
    }
    console.log(`[perf] environment ${JSON.stringify(environment)}`);

    const [widest] = await prisma.$queryRawUnsafe<Array<{ slug: string }>>(`
      SELECT c.slug FROM Category c
      JOIN Category d ON d.path = c.path OR d.path LIKE CONCAT(c.path, '/%')
      JOIN ProductCategory pc ON pc.categoryId = d.id
      WHERE c.depth = 0 AND c.deletedAt IS NULL
      GROUP BY c.id, c.slug ORDER BY COUNT(DISTINCT pc.productId) DESC LIMIT 1`);
    rootSlug = widest!.slug;

    const categories = await prisma.category.findMany({
      where: { deletedAt: null, isActive: true, productCountCache: { gt: 0 } },
      select: { slug: true },
      take: 60,
    });
    categorySlugs.push(rootSlug, ...categories.map((row) => row.slug));

    const grid = await request(app).get(
      `${API}/catalog/products?categorySlug=${rootSlug}&limit=24&inStockOnly=true`,
    );
    expect(grid.status).toBe(200);
    const facets = grid.body.data.facets as Array<{ kind: string; values: { value: string }[] }>;
    brandId = facets.find((facet) => facet.kind === 'BRAND')?.values[0]?.value ?? null;
    attributeValueId = facets.find((facet) => facet.kind === 'ATTRIBUTE')?.values[0]?.value ?? null;

    const reachable = await request(app).get(
      `${API}/catalog/products?limit=48&inStockOnly=true&includeFacets=false&sort=NAME_ASC`,
    );
    const items = reachable.body.data.items as Array<{ id: string; slug: string; name: string }>;
    slugs = items.map((item) => item.slug);
    productIds = items.map((item) => item.id);
    exactTitle = items[0]!.name;
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productIds[0]! },
      select: { sku: true },
    });
    sku = product.sku;

    session = await signIn();
    for (const slug of slugs.slice(0, 5)) await setStockForProduct(slug, 1_000);
    for (let n = 0; n < 20; n += 1) await placeOrder(session, productIds[n % 5]!);
    for (const productId of productIds.slice(10, 20)) {
      const added = await post(session, '/cart/items', { productId, qty: 1 });
      expect(added.status, added.text).toBeLessThan(300);
    }
    const list = await post(session, '/wishlists', { name: 'Perf' });
    expect(list.status, list.text).toBeLessThan(300);
    for (const productId of productIds.slice(20, 40)) {
      const added = await post(session, `/wishlists/${list.body.data.id}/items`, { productId });
      expect(added.status, added.text).toBeLessThan(300);
    }
    await catalogEvents.settled();
    console.log(
      `[perf] scope "${rootSlug}", brand ${brandId}, value ${attributeValueId}, ` +
        `title "${exactTitle}", sku ${sku}, setup ${round((performance.now() - started) / 1000)} s`,
    );
  }, 3_600_000);

  afterAll(() => {
    if (OUT) {
      writeFileSync(
        OUT,
        JSON.stringify(
          { products: PRODUCTS, environment, summaries, levels, statementLog },
          null,
          2,
        ),
      );
    }
  });

  it('records each storefront path cold and warm', async () => {
    const as = (req: request.Test) => req.set('Cookie', session.cookie);
    const scope = `${API}/catalog/products?categorySlug=${rootSlug}`;
    const filters = [
      brandId ? `brandIds=${brandId}` : '',
      attributeValueId ? `attributeValueIds=${attributeValueId}` : '',
    ]
      .filter(Boolean)
      .join('&');

    await measure('A', 'category listing, grid + facets', () =>
      request(app).get(`${scope}&limit=24`),
    );
    await measure('A2', 'category listing, grid only, page 2', () =>
      request(app).get(`${scope}&limit=24&includeFacets=false&page=2`),
    );
    await measure('B', 'category + filters', () =>
      request(app).get(`${scope}&limit=24&${filters}`),
    );
    await measure('C', 'category + price range', () =>
      request(app).get(`${scope}&limit=24&priceMin=1000000&priceMax=6000000`),
    );
    await measure('D', 'search "sofa"', () => request(app).get(`${API}/search?q=sofa&limit=24`));
    await measure('E', 'search "sofa" + filters', () =>
      request(app).get(`${API}/search?q=sofa&limit=24&${filters}`),
    );
    await measure('F', 'product detail', () =>
      request(app).get(`${API}/catalog/products/${slugs[0]}`),
    );
    await measure('G', 'pricing quote, 3 lines + pincode', () =>
      request(app)
        .post(`${API}/pricing/quote`)
        .send({
          items: slugs.slice(0, 3).map((slug, index) => ({ slug, qty: index + 1 })),
          pincode: '560025',
        }),
    );
    await measure('H', 'cart read, 10 lines', () => as(request(app).get(`${API}/cart`)));
    await measure('I', 'wishlist read, 20 items', () => as(request(app).get(`${API}/wishlists`)));
    await measure('J', 'order history, 20 orders', () =>
      as(request(app).get(`${API}/me/orders?limit=20`)),
    );
    await measure('S1', 'search exact title', () =>
      request(app).get(`${API}/search?q=${encodeURIComponent(exactTitle)}&limit=24`),
    );
    await measure('S2', 'search prefix "sof"', () =>
      request(app).get(`${API}/search?q=sof&limit=24`),
    );
    await measure('S3', 'search multi-word "teak sofa"', () =>
      request(app).get(`${API}/search?q=teak%20sofa&limit=24`),
    );
    await measure('S4', 'search in category', () =>
      request(app).get(`${API}/search?q=sofa&limit=24&categorySlug=${rootSlug}`),
    );
    await measure('S5', 'search SKU', () =>
      request(app).get(`${API}/search?q=${encodeURIComponent(sku)}&limit=24`),
    );
    await measure('S6', 'suggest "so"', () => request(app).get(`${API}/search/suggest?q=so`));
    await measure('S7', 'search zero-result', () =>
      request(app).get(`${API}/search?q=zzqxvw&limit=24`),
    );
  }, 3_600_000);

  it('holds up under concurrent storefront traffic', async () => {
    if (LEVELS.length === 0) return;

    const terms = [
      'sofa',
      'chair',
      'teak',
      'table',
      'bed',
      'walnut sofa',
      'stool',
      'oak',
      'dining',
    ];
    const pick = <T>(list: T[], random: () => number): T =>
      list[Math.floor(random() * list.length)]!;
    const plan = (random: () => number): Planned => {
      const roll = random();
      const category = pick(categorySlugs, random);
      if (roll < 0.3) {
        const page = 1 + Math.floor(random() * 3);
        const facets = random() < 0.5 ? '' : '&includeFacets=false';
        return {
          kind: 'listing',
          method: 'GET',
          path: `/catalog/products?categorySlug=${category}&limit=24&page=${page}${facets}`,
        };
      }
      if (roll < 0.4) {
        return {
          kind: 'filtered',
          method: 'GET',
          path: `/catalog/products?categorySlug=${rootSlug}&limit=24&${random() < 0.5 && brandId ? `brandIds=${brandId}` : `priceMin=${1_000_000 + Math.floor(random() * 5) * 500_000}`}`,
        };
      }
      if (roll < 0.55) {
        return {
          kind: 'search',
          method: 'GET',
          path: `/search?q=${encodeURIComponent(pick(terms, random))}&limit=24`,
        };
      }
      if (roll < 0.6) {
        const term = pick(terms, random);
        return {
          kind: 'suggest',
          method: 'GET',
          path: `/search/suggest?q=${encodeURIComponent(term.slice(0, 2 + Math.floor(random() * 3)))}`,
        };
      }
      if (roll < 0.8) {
        return { kind: 'pdp', method: 'GET', path: `/catalog/products/${pick(slugs, random)}` };
      }
      if (roll < 0.85) {
        return {
          kind: 'quote',
          method: 'POST',
          path: '/pricing/quote',
          body: { items: [{ slug: pick(slugs, random), qty: 1 }], pincode: '560025' },
        };
      }
      if (roll < 0.95) return { kind: 'cart', method: 'GET', path: '/cart', auth: true };
      if (roll < 0.98) return { kind: 'wishlist', method: 'GET', path: '/wishlists', auth: true };
      return { kind: 'orders', method: 'GET', path: '/me/orders?limit=20', auth: true };
    };

    const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    const baseline = await mysqlConnections(database);
    const { child, port } = await startServer();

    try {
      await drive(port, 10, 3, plan, session);

      for (const concurrency of LEVELS) {
        await ask(child, 'mark', 'marked');
        const cpuBefore = dockerCpuUsec();
        let peakRss = 0;
        let peakHeap = 0;
        let peakConnections = 0;
        let sampling = true;
        const sampler = (async () => {
          while (sampling) {
            const memory = await ask<{ rss: number; heapUsed: number }>(child, 'sample', 'sample');
            peakRss = Math.max(peakRss, memory.rss);
            peakHeap = Math.max(peakHeap, memory.heapUsed);
            peakConnections = Math.max(
              peakConnections,
              (await mysqlConnections(database)) - baseline,
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        })();

        const started = performance.now();
        const outcome = await drive(port, concurrency, SECONDS, plan, session);
        const wallMs = performance.now() - started;
        sampling = false;
        await sampler;
        const cpuAfter = dockerCpuUsec();
        const report = await ask<{
          cpuMs: number;
          loopDelayP99Ms: number;
          loopDelayMaxMs: number;
          hits: number;
          misses: number;
        }>(child, 'report', 'report');
        const live = await ask<{ rss: number; heapUsed: number }>(child, 'gc', 'gc');

        const all = [...outcome.latencies.values()].flat();
        const perKind = Object.fromEntries(
          [...outcome.latencies].map(([kind, values]) => [
            kind,
            {
              n: values.length,
              p50: round(percentile(values, 0.5)),
              p95: round(percentile(values, 0.95)),
            },
          ]),
        );
        const level = {
          concurrency,
          requests: all.length,
          throughput: round(all.length / (wallMs / 1000)),
          p50: round(percentile(all, 0.5)),
          p95: round(percentile(all, 0.95)),
          p99: round(percentile(all, 0.99)),
          max: round(Math.max(...all)),
          errors: outcome.errors,
          statuses: Object.fromEntries(outcome.statuses),
          serverCpuPct: round((report.cpuMs / wallMs) * 100),
          serverCpuMsPerRequest: round(report.cpuMs / all.length),
          dbCpuPct:
            cpuBefore !== null && cpuAfter !== null
              ? round(((cpuAfter - cpuBefore) / 1000 / wallMs) * 100)
              : null,
          dbCpuMsPerRequest:
            cpuBefore !== null && cpuAfter !== null
              ? round((cpuAfter - cpuBefore) / 1000 / all.length)
              : null,
          peakRssMb: round(peakRss / 1_048_576),
          peakHeapMb: round(peakHeap / 1_048_576),
          liveHeapAfterGcMb: round(live.heapUsed / 1_048_576),
          rssAfterGcMb: round(live.rss / 1_048_576),
          peakConnections,
          loopDelayP99Ms: round(report.loopDelayP99Ms),
          loopDelayMaxMs: round(report.loopDelayMaxMs),
          cacheHitPct: round((report.hits / Math.max(1, report.hits + report.misses)) * 100),
          perKind,
        };
        levels.push(level);
        console.log(`[load] ${JSON.stringify(level)}`);
      }
    } finally {
      await stopServer(child);
    }
  }, 3_600_000);

  it('keeps admin exports inside the worker heap', async () => {
    if (!EXPORTS) return;

    const email = 'perf.catalog@clearwood.local';
    const password = 'Rosewood-Teak-2026';
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'CATALOG_MANAGER' } });
    const admin = await prisma.adminUser.create({
      data: {
        email,
        name: 'Perf Catalog',
        passwordHash: await passwordService.hash(password),
        status: 'ACTIVE',
      },
    });
    await prisma.adminUserRole.create({ data: { adminUserId: admin.id, roleId: role.id } });

    const { child, port } = await startServer();
    try {
      const login = await fetch(`http://127.0.0.1:${port}${API}/admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; ');

      for (const entity of ['PRODUCT', 'VARIANT']) {
        const before = await ask<{ rss: number; heapUsed: number }>(child, 'gc', 'gc');
        let peakRss = before.rss;
        let peakHeap = before.heapUsed;
        let sampling = true;
        const sampler = (async () => {
          while (sampling) {
            const memory = await ask<{ rss: number; heapUsed: number }>(child, 'sample', 'sample');
            peakRss = Math.max(peakRss, memory.rss);
            peakHeap = Math.max(peakHeap, memory.heapUsed);
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })();

        const started = performance.now();
        const response = await fetch(
          `http://127.0.0.1:${port}${API}/admin/catalog/export/${entity}`,
          {
            headers: { cookie },
          },
        );
        const body = await response.arrayBuffer();
        const wallMs = performance.now() - started;
        sampling = false;
        await sampler;
        const after = await ask<{ rss: number; heapUsed: number }>(child, 'sample', 'sample');

        expect(response.status).toBe(200);
        const result = {
          entity,
          rows: new TextDecoder().decode(body).split('\n').length - 2,
          bytes: body.byteLength,
          wallMs: round(wallMs),
          heapBeforeMb: round(before.heapUsed / 1_048_576),
          peakHeapMb: round(Math.max(peakHeap, after.heapUsed) / 1_048_576),
          peakRssMb: round(Math.max(peakRss, after.rss) / 1_048_576),
        };
        levels.push({ export: result });
        console.log(`[export] ${JSON.stringify(result)}`);
      }
    } finally {
      await stopServer(child);
    }
  }, 3_600_000);
});
