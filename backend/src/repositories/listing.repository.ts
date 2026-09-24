import { Prisma } from '@prisma/client';

import type { ProductSort, RuleCategoryKind } from '@shared/enums';

import { prisma } from '../config/prisma';

/**
 * Prompt 4 - the storefront listing, filtered, sorted, counted and paginated inside MySQL.
 *
 * Raw SQL because Prisma cannot express the ordering expressions (COALESCE across a LEFT JOIN, a
 * relevance rank) or the facet aggregates. Every value is a bound parameter via `Prisma.sql`;
 * identifiers and sort expressions come only from the fixed fragments below, never from input.
 */

export interface ListingFilter {
  now: Date;
  /** Live since then = a new arrival (modules/storefront/merchandising.ts); null = the flag only. */
  newArrivalSince: Date | null;
  /** BROWSE_VISIBILITIES for a listing, SEARCH_VISIBILITIES for search results (shared/enums). */
  visibilities: readonly string[];
  /** The scoped category and its descendants; empty means every category. */
  categoryIds: string[];
  /** A rule category also admits products of its parent's subtree (null: any) with the fact. */
  categoryRule?: { kind: RuleCategoryKind; parentCategoryIds: string[] | null };
  collectionId: string | null;
  brandIds: string[];
  /** OR inside one attribute, AND across attributes. */
  attributeValues: { attributeId: string; valueIds: string[] }[];
  /** The shopper's "in stock" filter (a facet dimension). */
  inStockOnly: boolean;
  /** The `catalog.show_out_of_stock=false` policy: never a facet dimension. */
  hideOutOfStock: boolean;
  madeToOrder?: boolean;
  customizable?: boolean;
  isNewArrival?: boolean;
  isFeatured?: boolean;
  onSale: boolean;
  ratingMinBp?: number;
  leadTimeMaxDays?: number;
  priceMinPaise?: number;
  priceMaxPaise?: number;
  /** Search hits. An empty array matches nothing. */
  productIds?: string[];
}

export interface ListingOrder {
  sort: ProductSort;
  collectionId: string | null;
  categoryId: string | null;
  /** RELEVANCE only: product ids in rank order. */
  rankedIds: string[];
}

export interface ListingRow {
  id: string;
  minPricePaise: number | null;
  maxPricePaise: number | null;
}

export interface ListingSummary {
  total: number;
  minPricePaise: number;
  maxPricePaise: number;
}

export interface DimensionCounts {
  total: number;
  inStock: number;
  ratingAtLeast: Record<1 | 2 | 3 | 4, number>;
  madeToOrder: number;
  customizable: number;
  onSale: number;
}

export interface FacetScan {
  brands: { brandId: string; name: string | null; count: number }[];
  histogram: { minPaise: number; maxPaise: number; step: number; counts: Map<number, number> };
  dims: DimensionCounts;
}

const sql = Prisma.sql;

/** The navigation price: the indexed default-group minimum, or the base price until indexed. */
const PRICE = sql`COALESCE(li.minPricePaise, p.basePricePaise)`;
const MAX_PRICE = sql`COALESCE(li.maxPricePaise, p.basePricePaise)`;
const FROM = sql`Product p LEFT JOIN ProductListingIndex li ON li.productId = p.id`;

/** Same rule as the card, the PDP and the search index: made to order, backorderable, or unreserved stock. */
const IN_STOCK = sql`(p.isMadeToOrder = TRUE OR EXISTS (
  SELECT 1 FROM ProductVariant sv
  WHERE sv.productId = p.id AND sv.deletedAt IS NULL AND sv.isActive = TRUE
    AND (sv.allowBackorder = TRUE OR sv.stockQty - sv.reservedQty > 0)))`;

const ON_SALE = sql`((p.compareAtPricePaise IS NOT NULL AND p.compareAtPricePaise > p.basePricePaise)
  OR ${PRICE} < p.basePricePaise)`;

/** The flag is the admin's override; otherwise live within the window (merchandising.ts). */
function newArrival(since: Date | null): Prisma.Sql {
  return since
    ? sql`(p.isNewArrival = TRUE OR COALESCE(p.publishedAt, p.createdAt) >= ${since})`
    : sql`p.isNewArrival = TRUE`;
}

function featured(now: Date): Prisma.Sql {
  return sql`(p.isFeatured = TRUE AND (p.featuredUntil IS NULL OR p.featuredUntil > ${now}))`;
}

function linkedTo(alias: string, categoryIds: string[]): Prisma.Sql {
  if (categoryIds.length === 0) return sql`FALSE`;
  const table = Prisma.raw(alias);
  return sql`EXISTS (SELECT 1 FROM ProductCategory ${table}
    WHERE ${table}.productId = p.id AND ${table}.categoryId IN (${Prisma.join(categoryIds)}))`;
}

/** Explicit links always count; a rule category adds the parent's products with its fact. */
function categoryScope(filter: ListingFilter): Prisma.Sql | null {
  const rule = filter.categoryRule;
  if (!rule) return filter.categoryIds.length > 0 ? linkedTo('fc', filter.categoryIds) : null;

  const fact =
    rule.kind === 'NEW_ARRIVALS'
      ? newArrival(filter.newArrivalSince)
      : rule.kind === 'SPECIAL_COLLECTION'
        ? sql`p.isSpecialCollection = TRUE`
        : sql`p.allowCustomization = TRUE`;
  const within =
    rule.parentCategoryIds === null ? sql`TRUE` : linkedTo('rc', rule.parentCategoryIds);

  return sql`(${linkedTo('fc', filter.categoryIds)} OR (${fact} AND ${within}))`;
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function where(filter: ListingFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    sql`p.deletedAt IS NULL`,
    sql`p.status = 'ACTIVE'`,
    sql`p.visibility IN (${Prisma.join([...filter.visibilities])})`,
    sql`(p.publishedAt IS NULL OR p.publishedAt <= ${filter.now})`,
  ];

  if (filter.productIds) {
    parts.push(
      filter.productIds.length > 0 ? sql`p.id IN (${Prisma.join(filter.productIds)})` : sql`FALSE`,
    );
  }
  const scoped = categoryScope(filter);
  if (scoped) parts.push(scoped);
  if (filter.collectionId) {
    parts.push(sql`EXISTS (SELECT 1 FROM CollectionProduct fcp
      WHERE fcp.collectionId = ${filter.collectionId} AND fcp.productId = p.id)`);
  }
  if (filter.brandIds.length > 0) parts.push(sql`p.brandId IN (${Prisma.join(filter.brandIds)})`);

  for (const { valueIds } of filter.attributeValues) {
    // ProductListingAttribute already holds specs and active-variant options, once per product.
    parts.push(sql`p.id IN (SELECT fa.productId FROM ProductListingAttribute fa
      WHERE fa.attributeValueId IN (${Prisma.join(valueIds)}))`);
  }

  if (filter.inStockOnly || filter.hideOutOfStock) parts.push(IN_STOCK);
  if (filter.madeToOrder !== undefined) parts.push(sql`p.isMadeToOrder = ${filter.madeToOrder}`);
  if (filter.customizable !== undefined) {
    parts.push(sql`p.allowCustomization = ${filter.customizable}`);
  }
  if (filter.isNewArrival !== undefined) {
    const clause = newArrival(filter.newArrivalSince);
    parts.push(filter.isNewArrival ? clause : sql`NOT ${clause}`);
  }
  if (filter.isFeatured !== undefined) {
    const clause = featured(filter.now);
    parts.push(filter.isFeatured ? clause : sql`NOT ${clause}`);
  }
  if (filter.onSale) parts.push(ON_SALE);
  if (filter.ratingMinBp !== undefined) parts.push(sql`p.ratingAvgBp >= ${filter.ratingMinBp}`);
  if (filter.leadTimeMaxDays !== undefined) {
    parts.push(sql`(p.leadTimeDays IS NULL OR p.leadTimeDays <= ${filter.leadTimeMaxDays})`);
  }
  if (filter.priceMinPaise !== undefined) parts.push(sql`${PRICE} >= ${filter.priceMinPaise}`);
  if (filter.priceMaxPaise !== undefined) parts.push(sql`${PRICE} <= ${filter.priceMaxPaise}`);

  return Prisma.join(parts, ' AND ');
}

function orderBy(order: ListingOrder): { joins: Prisma.Sql; keys: Prisma.Sql } {
  switch (order.sort) {
    case 'PRICE_ASC':
      return { joins: Prisma.empty, keys: sql`${PRICE} ASC` };
    case 'PRICE_DESC':
      return { joins: Prisma.empty, keys: sql`${PRICE} DESC` };
    case 'NEWEST':
      return { joins: Prisma.empty, keys: sql`COALESCE(p.publishedAt, p.createdAt) DESC` };
    case 'BEST_SELLING':
      return { joins: Prisma.empty, keys: sql`p.soldCount DESC` };
    case 'RATING':
      return { joins: Prisma.empty, keys: sql`p.ratingAvgBp DESC, p.ratingCount DESC` };
    case 'NAME_ASC':
      return { joins: Prisma.empty, keys: sql`p.name ASC` };
    case 'RELEVANCE':
      return order.rankedIds.length > 0
        ? { joins: Prisma.empty, keys: sql`FIELD(p.id, ${Prisma.join(order.rankedIds)}) ASC` }
        : { joins: Prisma.empty, keys: sql`p.id ASC` };
    case 'CURATED':
      if (order.collectionId) {
        return {
          joins: sql`LEFT JOIN CollectionProduct oc
            ON oc.collectionId = ${order.collectionId} AND oc.productId = p.id`,
          keys: sql`oc.position ASC`,
        };
      }
      if (order.categoryId) {
        return {
          joins: sql`LEFT JOIN ProductCategory oc
            ON oc.categoryId = ${order.categoryId} AND oc.productId = p.id`,
          keys: sql`COALESCE(oc.position, p.position) ASC`,
        };
      }
      return { joins: Prisma.empty, keys: sql`p.position ASC` };
    case 'POPULARITY':
    default:
      return {
        joins: sql`LEFT JOIN ProductStat ps ON ps.productId = p.id`,
        keys: sql`COALESCE(ps.popularityScore, p.soldCount) DESC`,
      };
  }
}

export const listingRepository = {
  /**
   * One page of product ids in display order (`id` breaks every tie, so pages never overlap), with
   * the total and price bounds taken from the same scan by window aggregates.
   */
  async page(
    filter: ListingFilter,
    order: ListingOrder,
    offset: number,
    limit: number,
  ): Promise<{ rows: ListingRow[]; summary: ListingSummary }> {
    const { joins, keys } = orderBy(order);
    const found = await prisma.$queryRaw<
      (ListingRow & { total: bigint; minPrice: unknown; maxPrice: unknown })[]
    >`
      SELECT p.id AS id, li.minPricePaise AS minPricePaise, li.maxPricePaise AS maxPricePaise,
        COUNT(*) OVER () AS total, MIN(${PRICE}) OVER () AS minPrice,
        MAX(${MAX_PRICE}) OVER () AS maxPrice
      FROM ${FROM} ${joins}
      WHERE ${where(filter)}
      ORDER BY ${keys}, p.id ASC
      LIMIT ${limit} OFFSET ${offset}`;

    const rows = found.map((row) => ({
      id: row.id,
      minPricePaise: row.minPricePaise === null ? null : num(row.minPricePaise),
      maxPricePaise: row.maxPricePaise === null ? null : num(row.maxPricePaise),
    }));

    const first = found[0];
    if (first) {
      return {
        rows,
        summary: {
          total: num(first.total),
          minPricePaise: num(first.minPrice),
          maxPricePaise: num(first.maxPrice),
        },
      };
    }
    // Past the last page the window has no row to report on.
    return {
      rows,
      summary:
        offset > 0 ? await this.summary(filter) : { total: 0, minPricePaise: 0, maxPricePaise: 0 },
    };
  },

  async summary(filter: ListingFilter): Promise<ListingSummary> {
    const [row] = await prisma.$queryRaw<{ total: bigint; minPrice: unknown; maxPrice: unknown }[]>`
      SELECT COUNT(*) AS total, MIN(${PRICE}) AS minPrice, MAX(${MAX_PRICE}) AS maxPrice
      FROM ${FROM} WHERE ${where(filter)}`;

    return {
      total: num(row?.total),
      minPricePaise: num(row?.minPrice),
      maxPricePaise: num(row?.maxPrice),
    };
  },

  /** Products per attribute value, from specs and active variants alike, each product once. */
  async attributeValueCounts(
    filter: ListingFilter,
    attributeIds: string[],
  ): Promise<{ attributeId: string; attributeValueId: string; count: number }[]> {
    if (attributeIds.length === 0) return [];

    // The projection is unique per (product, value), so a plain COUNT(*) is the product count.
    const rows = await prisma.$queryRaw<
      { attributeId: string; attributeValueId: string; n: bigint }[]
    >`
      SELECT la.attributeId AS attributeId, la.attributeValueId AS attributeValueId, COUNT(*) AS n
      FROM ${FROM} JOIN ProductListingAttribute la ON la.productId = p.id
      WHERE ${where(filter)} AND la.attributeId IN (${Prisma.join(attributeIds)})
      GROUP BY la.attributeId, la.attributeValueId`;

    return rows.map((row) => ({
      attributeId: row.attributeId,
      attributeValueId: row.attributeValueId,
      count: num(row.n),
    }));
  },

  /**
   * Brand counts, a `buckets`-wide price histogram and the availability/rating/flag counters for
   * one filtered set, from a single scan: grouped by (brand, bucket), summed in Node.
   */
  async facetScan(filter: ListingFilter, buckets: number): Promise<FacetScan> {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      WITH f AS (
        SELECT p.brandId AS brandId, ${PRICE} AS price,
          MIN(${PRICE}) OVER () AS mn, MAX(${PRICE}) OVER () AS mx,
          ${IN_STOCK} AS inStock, p.ratingAvgBp AS rating,
          p.isMadeToOrder AS madeToOrder, p.allowCustomization AS customizable, ${ON_SALE} AS onSale
        FROM ${FROM} WHERE ${where(filter)}
      )
      SELECT f.brandId AS brandId, MAX(b.name) AS brandName,
        LEAST(FLOOR((f.price - f.mn) / CEIL(GREATEST(f.mx - f.mn, 1) / ${buckets})), ${buckets - 1})
          AS bucket,
        MIN(f.mn) AS mn, MIN(f.mx) AS mx, MIN(CEIL(GREATEST(f.mx - f.mn, 1) / ${buckets})) AS step,
        COUNT(*) AS n, SUM(f.inStock) AS inStock,
        SUM(f.rating >= 40000) AS r4, SUM(f.rating >= 30000) AS r3,
        SUM(f.rating >= 20000) AS r2, SUM(f.rating >= 10000) AS r1,
        SUM(f.madeToOrder) AS madeToOrder, SUM(f.customizable) AS customizable,
        SUM(f.onSale) AS onSale
      FROM f LEFT JOIN Brand b ON b.id = f.brandId AND b.deletedAt IS NULL
      GROUP BY f.brandId, bucket`;

    const brands = new Map<string, { brandId: string; name: string | null; count: number }>();
    const counts = new Map<number, number>();
    const dims: DimensionCounts = {
      total: 0,
      inStock: 0,
      ratingAtLeast: { 1: 0, 2: 0, 3: 0, 4: 0 },
      madeToOrder: 0,
      customizable: 0,
      onSale: 0,
    };

    for (const row of rows) {
      const n = num(row.n);
      if (typeof row.brandId === 'string') {
        const brand = brands.get(row.brandId) ?? {
          brandId: row.brandId,
          name: typeof row.brandName === 'string' ? row.brandName : null,
          count: 0,
        };
        brand.count += n;
        brands.set(row.brandId, brand);
      }
      const bucket = num(row.bucket);
      counts.set(bucket, (counts.get(bucket) ?? 0) + n);

      dims.total += n;
      dims.inStock += num(row.inStock);
      dims.ratingAtLeast[4] += num(row.r4);
      dims.ratingAtLeast[3] += num(row.r3);
      dims.ratingAtLeast[2] += num(row.r2);
      dims.ratingAtLeast[1] += num(row.r1);
      dims.madeToOrder += num(row.madeToOrder);
      dims.customizable += num(row.customizable);
      dims.onSale += num(row.onSale);
    }

    const first = rows[0];
    return {
      brands: [...brands.values()],
      histogram: first
        ? {
            minPaise: num(first.mn),
            maxPaise: num(first.mx),
            step: Math.max(num(first.step), 1),
            counts,
          }
        : { minPaise: 0, maxPaise: 0, step: 1, counts: new Map() },
      dims,
    };
  },
};
