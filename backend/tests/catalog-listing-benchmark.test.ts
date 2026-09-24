import { writeFileSync } from 'node:fs';

import { format } from 'mysql2';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { prisma, prismaEvents } from '../src/config/prisma';
import { cache } from '../src/container';
import { catalogEvents } from '../src/events/catalogEvents';
import { listingIndexService } from '../src/modules/storefront/listingIndex.service';

import { buildBenchCatalog, type BenchFixture } from './helpers/benchCatalog';

/**
 * Storefront listing benchmark on a synthetic catalog (Prompt 4, scaled up in Prompt 5).
 *
 * CLEARWOOD_LISTING_BENCHMARK_PRODUCTS is the WHOLE catalog (helpers/benchCatalog.ts).
 *
 * Opt-in (CLEARWOOD_LISTING_BENCHMARK=1). Every path is measured cold (page caches dropped,
 * background work drained) three times; the median wall time is reported with the query count,
 * database time, InnoDB rows read, response size and EXPLAIN for the slowest statements.
 * CLEARWOOD_LISTING_BENCHMARK_REBUILD=1 also times a full listing-index rebuild.
 */

const enabled = process.env.CLEARWOOD_LISTING_BENCHMARK === '1';
const TOTAL = Number(process.env.CLEARWOOD_LISTING_BENCHMARK_PRODUCTS ?? 3600);
const IN_SCOPE = Math.round(TOTAL * 0.8);
const OUT_OF_SCOPE = TOTAL - IN_SCOPE;
const RUNS = 3;
const API = '/api/v1';
const app = createApp();

interface Captured {
  sql: string;
  params: string;
  duration: number;
}

interface Measurement {
  label: string;
  url: string;
  wallMs: number;
  queries: number;
  dbMs: number;
  rowsRead: number;
  bytes: number;
  total: number | null;
  slowest: string[];
}

let sink: Captured[] | null = null;
/** Count-only capture for long operations, where keeping every statement would exhaust memory. */
let tally: { queries: number; dbMs: number } | null = null;
const results: Measurement[] = [];

async function innodbRowsRead(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SHOW GLOBAL STATUS LIKE 'Innodb_rows_read'",
  );
  const row = rows[0] ?? {};
  return Number(row.Value ?? row.f1 ?? 0);
}

/** Lets fire-and-forget listeners finish so they are not counted against the next request. */
async function quiesce(): Promise<void> {
  await catalogEvents.settled();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function explain(row: Captured): Promise<string> {
  const bound = format(row.sql, JSON.parse(row.params) as string[]);
  const plan = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`EXPLAIN ${bound}`);
  const table = /FROM `[^`]+`\.`(\w+)`/.exec(row.sql)?.[1] ?? /FROM `?(\w+)`?/.exec(row.sql)?.[1];
  const steps = plan
    .map((step) => {
      const name = step.table ?? step.f2;
      const type = step.type ?? step.f4;
      const key = step.key ?? step.f6 ?? '-';
      const estimate = step.rows ?? step.f9;
      const extra = step.Extra ?? step.f11;
      return `${name}/${type}/${key}/${estimate}${extra ? ` (${extra})` : ''}`;
    })
    .join(' | ');
  return `${row.duration} ms ${table ?? '?'}: ${steps}`;
}

async function measure(
  label: string,
  url: string,
  headers: Record<string, string> = {},
  options: { warm?: boolean } = {},
) {
  const runs: Omit<Measurement, 'slowest' | 'label' | 'url'>[] = [];
  let slowest: string[] = [];

  if (options.warm) {
    await cache.delByPrefix('sf:');
    await request(app).get(url).set(headers);
  }

  for (let run = 0; run < RUNS; run += 1) {
    if (!options.warm) {
      await cache.delByPrefix('sf:');
      await cache.delByPrefix('cat:');
    }
    await quiesce();

    const captured: Captured[] = [];
    const rowsBefore = await innodbRowsRead();
    sink = captured;
    const started = performance.now();
    const response = await request(app).get(url).set(headers);
    const wallMs = performance.now() - started;
    await new Promise((resolve) => setImmediate(resolve));
    sink = null;
    const rowsRead = (await innodbRowsRead()) - rowsBefore;

    expect(response.status, `${label}: ${url}`).toBe(200);
    runs.push({
      wallMs,
      queries: captured.length,
      dbMs: captured.reduce((sum, row) => sum + row.duration, 0),
      rowsRead,
      bytes: Buffer.byteLength(JSON.stringify(response.body)),
      total: typeof response.body.meta?.total === 'number' ? response.body.meta.total : null,
    });

    if (run === RUNS - 1) {
      const top = [...captured]
        .filter((row) => /^\s*(SELECT|WITH)/i.test(row.sql))
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 3);
      slowest = await Promise.all(top.map(explain));

      if (process.env.CLEARWOOD_LISTING_BENCHMARK_ANALYZE === '1' && top[0]) {
        const bound = format(top[0].sql, JSON.parse(top[0].params) as string[]);
        const tree = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `EXPLAIN ANALYZE ${bound}`,
        );
        console.log(`[analyze] ${label}\n${String(Object.values(tree[0] ?? {})[0])}`);
      }
    }
  }

  const median = [...runs].sort((a, b) => a.wallMs - b.wallMs)[Math.floor(RUNS / 2)]!;
  const result: Measurement = { label, url, ...median, slowest };
  results.push(result);

  console.log(
    `[bench] ${label}: ${median.wallMs.toFixed(0)} ms wall, ${median.queries} queries, ` +
      `${median.dbMs} ms db, ${median.rowsRead} rows read, ${median.bytes} bytes, total ${median.total}`,
  );
  for (const line of slowest) console.log(`[bench]   ${line}`);
  return result;
}

describe.skipIf(!enabled)('storefront listing benchmark', () => {
  let fixture: BenchFixture;

  beforeAll(async () => {
    prismaEvents.$on(
      'query' as never,
      ((event: Captured & { query: string }) => {
        if (/^(BEGIN|COMMIT|ROLLBACK|SELECT 1\b)/i.test(event.query.trim())) return;
        if (tally) {
          tally.queries += 1;
          tally.dbMs += event.duration;
        } else if (sink) {
          sink.push({ sql: event.query, params: event.params, duration: event.duration });
        }
      }) as never,
    );

    const started = performance.now();
    fixture = await buildBenchCatalog(TOTAL);
    // Index experiments: candidate DDL applied to this throwaway database only.
    for (const ddl of (process.env.CLEARWOOD_LISTING_BENCHMARK_DDL ?? '').split(';')) {
      if (ddl.trim()) await prisma.$executeRawUnsafe(ddl);
    }
    console.log(
      `[bench] fixture: ${IN_SCOPE} products under "${fixture.rootSlug}" (48 leaves, 3 levels), ` +
        `${OUT_OF_SCOPE} elsewhere, 1-4 variants, 3 images each, ` +
        `built in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );

    // Settings, tax classes and category attributes warm, as in steady state.
    await request(app).get(`${API}/catalog/products?categorySlug=${fixture.rootSlug}&limit=24`);
  }, 3_600_000);

  it('measures the listing, filter and facet paths', async () => {
    const root = `${API}/catalog/products?categorySlug=${fixture.rootSlug}`;
    const grid = `${root}&includeFacets=false&limit=24`;

    const first = await measure('category grid, page 1', grid);
    // Drafts, archived, hidden, scheduled and deleted rows are in scope but never listed.
    expect(first.total).toBeGreaterThan(IN_SCOPE * 0.85);
    expect(first.total).toBeLessThan(IN_SCOPE);
    const deepPage = Math.max(2, Math.floor(((first.total ?? 0) / 24) * 0.9));

    // Where a card's bytes go: the cache stores exactly this payload.
    const sample = (await request(app).get(grid)).body.data.items[0] as Record<string, unknown>;
    const image = sample.image as { lqip: string | null; sources: unknown[] } | null;
    console.log(
      `[bench] card bytes: total ${JSON.stringify(sample).length}, lqip ${image?.lqip?.length ?? 0}, ` +
        `sources ${JSON.stringify(image?.sources ?? []).length} (${image?.sources.length ?? 0} renditions), ` +
        `swatches ${JSON.stringify(sample.swatches).length}`,
    );

    await measure('category grid + facets, page 1', `${root}&limit=24`);
    await measure('category grid, page 60', `${grid}&page=60`);
    await measure(`category grid, deep page ${deepPage}`, `${grid}&page=${deepPage}`);
    await measure(
      'mid-level category grid',
      `${API}/catalog/products?categorySlug=${fixture.midSlug}&includeFacets=false&limit=24`,
    );
    await measure(
      'leaf category grid',
      `${API}/catalog/products?categorySlug=${fixture.leafSlug}&includeFacets=false&limit=24`,
    );
    await measure(
      'filtered grid (brand + option + in stock) + facets',
      `${root}&limit=24&brandIds=${fixture.brandId}&attributeValueIds=${fixture.colourValueId}&inStockOnly=true`,
    );
    await measure(
      'filtered grid (two options) + facets',
      `${root}&limit=24&attributeValueIds=${fixture.colourValueId},${fixture.secondValueId}`,
    );
    await measure('sorted grid NEWEST', `${grid}&sort=NEWEST`);
    await measure('sorted grid NAME_ASC, page 20', `${grid}&sort=NAME_ASC&page=20`);
    await measure('price-sorted grid PRICE_ASC', `${grid}&sort=PRICE_ASC`);
    await measure('price-sorted grid PRICE_DESC, page 30', `${grid}&sort=PRICE_DESC&page=30`);
    await measure('price range + facets', `${root}&limit=24&priceMin=1000000&priceMax=4000000`);
    await measure('facet endpoint', `${API}/catalog/filters?categorySlug=${fixture.rootSlug}`);
    await measure(
      'facet endpoint with selections',
      `${API}/catalog/filters?categorySlug=${fixture.rootSlug}&brandIds=${fixture.brandId}&attributeValueIds=${fixture.colourValueId}&priceMin=1000000`,
    );
    await measure(
      'collection grid (10% of catalog), CURATED',
      `${API}/catalog/products?collectionSlug=${fixture.collectionSlug}&includeFacets=false&limit=24`,
    );
    await measure(
      'whole catalog grid, POPULARITY',
      `${API}/catalog/products?includeFacets=false&limit=24`,
    );
    await measure(
      'whole catalog grid, PRICE_ASC',
      `${API}/catalog/products?includeFacets=false&limit=24&sort=PRICE_ASC`,
    );
    await measure('category grid + facets, warm cache', `${root}&limit=24`, {}, { warm: true });
    await measure(
      'facet endpoint, warm cache',
      `${API}/catalog/filters?categorySlug=${fixture.rootSlug}`,
      {},
      { warm: true },
    );

    let rebuild: Record<string, number> | null = null;
    if (process.env.CLEARWOOD_LISTING_BENCHMARK_REBUILD === '1') {
      const [size] = await prisma.$queryRawUnsafe<Array<{ products: bigint; variants: bigint }>>(`
        SELECT (SELECT COUNT(*) FROM Product WHERE status = 'ACTIVE' AND deletedAt IS NULL) AS products,
          (SELECT COUNT(*) FROM ProductVariant v JOIN Product p ON p.id = v.productId
            WHERE p.status = 'ACTIVE' AND p.deletedAt IS NULL AND v.deletedAt IS NULL
              AND v.isActive = TRUE) AS variants`);
      await quiesce();

      tally = { queries: 0, dbMs: 0 };
      const rowsBefore = await innodbRowsRead();
      const started = performance.now();
      const outcome = await listingIndexService.rebuildAll();
      const wallMs = performance.now() - started;
      const counted = tally;
      tally = null;

      rebuild = {
        products: Number(size?.products ?? 0),
        variants: Number(size?.variants ?? 0),
        wallMs: Math.round(wallMs),
        queries: counted.queries,
        dbMs: counted.dbMs,
        rowsRead: (await innodbRowsRead()) - rowsBefore,
        processed: outcome.processed,
        failed: outcome.failed,
      };
      console.log(`[bench] full listing-index rebuild: ${JSON.stringify(rebuild)}`);
    }

    const out = process.env.CLEARWOOD_LISTING_BENCHMARK_OUT;
    if (out) writeFileSync(out, JSON.stringify({ products: TOTAL, results, rebuild }, null, 2));
  }, 3_600_000);
});
