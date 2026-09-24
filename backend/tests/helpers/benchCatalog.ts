import type { Prisma } from '@prisma/client';
import { expect } from 'vitest';

import { prisma } from '../../src/config/prisma';
import { combinationKeyOf } from '../../src/modules/catalog-admin/variantOptions';
import { categoryAttributeService } from '../../src/services/categoryAttribute.service';
import { mark } from '../../src/utils/uniqueMark';

/**
 * The synthetic catalog the opt-in benchmarks share (catalog-listing-benchmark, perf-baseline).
 *
 * `total` is the WHOLE catalog: 80% sits under one seed root's own three-level subtree
 * (4 x 4 x 3 leaves), 20% under other roots. Products carry 1-4 priced variants with real option
 * values, a spec, three images, mixed stock (reserved, backorder, made to order), popularity,
 * ratings, collection membership and a lifecycle mix (drafts, archived, hidden, search-only,
 * catalog-only, scheduled, soft-deleted).
 */

export interface BenchFixture {
  rootSlug: string;
  midSlug: string;
  leafSlug: string;
  collectionSlug: string;
  brandId: string;
  colourValueId: string;
  secondValueId: string;
}

export const benchProductId = (n: number) => `bench${String(n).padStart(6, '0')}`;
export const benchVariantCount = (n: number) => 1 + (n % 4);

/** Lifecycle by n % 100, so every scale carries the same share of rows a listing must skip. */
export function benchLifecycle(n: number) {
  const slot = n % 100;
  return {
    status: slot < 2 ? 'DRAFT' : slot === 2 ? 'ARCHIVED' : 'ACTIVE',
    visibility:
      slot === 3 ? 'HIDDEN' : slot === 4 ? 'SEARCH_ONLY' : slot === 5 ? 'CATALOG_ONLY' : 'PUBLIC',
    scheduled: slot === 6,
    deleted: slot === 7,
  };
}

const KINDS = ['Sofa', 'Chair', 'Table', 'Bed', 'Stool'];
const WOODS = ['sheesham', 'teak', 'mango', 'walnut', 'oak', 'acacia', 'rosewood'];

/** A description about as long as a real one, so search moves realistic amounts of text. */
function description(n: number): string {
  const wood = WOODS[n % WOODS.length]!;
  const kind = KINDS[n % KINDS.length]!.toLowerCase();
  return (
    `Every ${kind} in this range is built by hand in our own workshop from seasoned ${wood}, ` +
    `joined with mortise and tenon and finished in ${3 + (n % 5)} coats of hand-rubbed oil. ` +
    'Nothing is outsourced: the frame, the upholstery and the final inspection happen under one ' +
    'roof, and each piece is made individually after you order it. The timber is kiln dried to ' +
    'the moisture content of an Indian home so it does not split or warp through the monsoon. ' +
    `Dimensions, finish and fabric can be customised; allow ${7 + (n % 40)} days for making.`
  );
}

export async function buildBenchCatalog(total: number): Promise<BenchFixture> {
  const inScope = Math.round(total * 0.8);

  const roots = await prisma.category.findMany({
    where: { deletedAt: null, isActive: true, depth: 0 },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });

  let root = roots[0]!;
  let widest = -1;
  for (const candidate of roots) {
    const below = await prisma.category.count({
      where: { deletedAt: null, isActive: true, path: { startsWith: `${candidate.path}/` } },
    });
    if (below > widest) {
      root = candidate;
      widest = below;
    }
  }
  const others = roots.filter((row) => row.id !== root.id).slice(0, 4);

  // A three-level subtree of the benchmark's own under that root: 4 x 4 x 3 = 48 leaves.
  const node = (name: string, parent: { id: string; path: string; depth: number }, at: number) =>
    prisma.category.create({
      data: {
        name: `Bench ${name}`,
        slug: `bench-${name}`,
        parentId: parent.id,
        path: `${parent.path}/bench-${name}`,
        depth: parent.depth + 1,
        position: 100 + at,
      },
    });
  const middles: Awaited<ReturnType<typeof node>>[] = [];
  const leaves: Awaited<ReturnType<typeof node>>[] = [];
  for (let i = 0; i < 4; i += 1) {
    const one = await node(`${i}`, root, i);
    middles.push(one);
    for (let j = 0; j < 4; j += 1) {
      const two = await node(`${i}-${j}`, one, j);
      for (let k = 0; k < 3; k += 1) leaves.push(await node(`${i}-${j}-${k}`, two, k));
    }
  }

  // 10%, 5% and 1% of the catalog, curated: [every, remainder].
  const membership = [
    [10, 1],
    [20, 2],
    [100, 9],
  ] as const;
  const collections = await Promise.all(
    membership.map(([every]) =>
      prisma.collection.create({
        data: { slug: `bench-every-${every}`, name: `Bench every ${every}` },
      }),
    ),
  );

  const resolved = await categoryAttributeService.resolveForCategory(root.id);
  const optionAttributes = resolved
    .filter((entry) => entry.isVariantDefiningForCategory && entry.values.length >= 2)
    .slice(0, 2);
  const specAttribute = resolved.find(
    (entry) => !entry.isVariantDefiningForCategory && entry.values.length >= 2,
  );
  expect(optionAttributes.length, 'the root category needs variant-defining attributes').toBe(2);

  const brands = await prisma.brand.findMany({
    where: { deletedAt: null },
    orderBy: { id: 'asc' },
  });
  const media = await prisma.media.findMany({
    where: { deletedAt: null, status: 'READY' },
    orderBy: { id: 'asc' },
    take: 9,
    select: { id: true },
  });
  expect(media.length).toBeGreaterThanOrEqual(3);

  const [first, second] = optionAttributes as [
    (typeof optionAttributes)[number],
    (typeof optionAttributes)[number],
  ];
  const published = Date.UTC(2026, 0, 1);
  const future = Date.now() + 30 * 86_400_000;

  for (let start = 0; start < total; start += 500) {
    const size = Math.min(500, total - start);
    const numbers = Array.from({ length: size }, (_, offset) => start + offset);

    const products = numbers.map((n) => {
      const base = 5_000_00 + (n % 97) * 1_250_00;
      const life = benchLifecycle(n);
      return {
        id: benchProductId(n),
        sku: `BENCH-${n}`,
        slug: `bench-product-${n}`,
        name: `Bench ${KINDS[n % 5]} ${n}`,
        subtitle: `Solid wood, finish ${n % 7}`,
        shortDescription: 'Handmade in our own workshop.',
        description: description(n),
        status: life.status,
        visibility: life.visibility,
        brandId: brands.length > 0 ? brands[n % brands.length]!.id : null,
        basePricePaise: base,
        compareAtPricePaise: n % 5 === 0 ? base + 2_000_00 : null,
        isMadeToOrder: n % 10 === 0,
        leadTimeDays: 7 + (n % 40),
        allowCustomization: n % 7 === 0,
        isFeatured: n % 20 === 0,
        isNewArrival: n % 10 === 3,
        ratingAvgBp: (n * 37) % 50_001,
        ratingCount: n % 60,
        soldCount: (n * 13) % 500,
        position: n,
        publishedAt: life.scheduled
          ? new Date(future)
          : new Date(published + (n % 250) * 3_600_000),
        deletedAt: life.deleted ? new Date(published) : null,
      };
    });
    await prisma.product.createMany({ data: products });

    await prisma.collectionProduct.createMany({
      data: numbers.flatMap((n) =>
        collections
          .filter((_, index) => n % membership[index]![0] === membership[index]![1])
          .map((collection) => ({
            collectionId: collection.id,
            productId: benchProductId(n),
            position: n,
          })),
      ),
    });

    await prisma.productCategory.createMany({
      data: numbers.flatMap((n): Prisma.ProductCategoryCreateManyInput[] => {
        const productId = benchProductId(n);
        if (n >= inScope) {
          const other = others[n % Math.max(others.length, 1)] ?? root;
          return [{ productId, categoryId: other.id, isPrimary: true, primaryMark: mark(true) }];
        }
        const leaf = leaves.length > 0 ? leaves[n % leaves.length]! : root;
        return [
          { productId, categoryId: leaf.id, isPrimary: true, primaryMark: mark(true), position: 0 },
          ...(leaf.id === root.id
            ? []
            : [{ productId, categoryId: root.id, isPrimary: false, position: n % 50 }]),
        ];
      }),
    });

    const variants: Prisma.ProductVariantCreateManyInput[] = [];
    const options: Prisma.VariantAttributeValueCreateManyInput[] = [];
    const optionText = new Map<number, string[]>();

    for (const n of numbers) {
      const productId = benchProductId(n);
      for (let k = 0; k < benchVariantCount(n); k += 1) {
        const a = first.values[(n + k) % first.values.length]!;
        const b = second.values[(n + 2 * k) % second.values.length]!;
        const pairs = [
          { attributeId: first.id, attributeValueId: a.id },
          { attributeId: second.id, attributeValueId: b.id },
        ];
        optionText.set(n, [...(optionText.get(n) ?? []), a.label, b.label]);
        const variantId = `benchv${String(n).padStart(6, '0')}${k}`;
        const pattern = (n + k) % 20;
        variants.push({
          id: variantId,
          productId,
          sku: `BENCH-${n}-${k}`,
          position: k,
          isDefault: k === 0,
          defaultMark: mark(k === 0),
          pricePaise: k === 0 ? null : 5_000_00 + (n % 97) * 1_250_00 + k * 3_500_00,
          stockQty: pattern < 4 ? 0 : pattern === 4 ? 2 : 3 + (n % 9),
          reservedQty: pattern === 4 ? 2 : 0,
          allowBackorder: pattern === 5,
          stockStatus: pattern < 4 ? 'OUT_OF_STOCK' : 'IN_STOCK',
          combinationKey: combinationKeyOf(pairs),
        });
        options.push(
          ...pairs.map((pair, index) => ({ id: `${variantId}o${index}`, variantId, ...pair })),
        );
      }
    }
    await prisma.productVariant.createMany({ data: variants });
    await prisma.variantAttributeValue.createMany({ data: options });

    if (specAttribute) {
      await prisma.productAttributeValue.createMany({
        data: numbers.map((n) => ({
          productId: benchProductId(n),
          attributeId: specAttribute.id,
          attributeValueId: specAttribute.values[n % specAttribute.values.length]!.id,
        })),
      });
    }

    await prisma.productMedia.createMany({
      data: numbers.flatMap((n) =>
        [0, 1, 2].map((k) => ({
          productId: benchProductId(n),
          mediaId: media[(n + k) % media.length]!.id,
          role: k === 0 ? 'PRIMARY' : 'GALLERY',
          primaryMark: mark(k === 0),
          position: k,
        })),
      ),
    });

    await prisma.productStat.createMany({
      data: numbers
        .filter((n) => n % 10 < 7)
        .map((n) => ({
          productId: benchProductId(n),
          viewCount7d: (n * 7) % 900,
          popularityScore: (n * 7919) % 10_000,
        })),
    });

    // Only what the indexer would index: live, reachable and searchable. The price index the
    // listing filters and sorts on is copied from the same variant price range below.
    await prisma.searchDocument.createMany({
      data: products
        .map((product, index) => ({ product, n: numbers[index]! }))
        .filter(({ n }) => {
          const life = benchLifecycle(n);
          return (
            life.status === 'ACTIVE' &&
            !life.deleted &&
            !life.scheduled &&
            (life.visibility === 'PUBLIC' || life.visibility === 'SEARCH_ONLY')
          );
        })
        .map(({ product, n }) => {
          const prices = Array.from({ length: benchVariantCount(n) }, (_, k) =>
            k === 0 ? product.basePricePaise : product.basePricePaise + k * 3_500_00,
          );
          const brand = brands.length > 0 ? brands[n % brands.length]! : null;
          return {
            entityType: 'PRODUCT',
            entityId: product.id,
            title: product.name,
            subtitle: product.subtitle,
            bodyText: `${product.shortDescription} ${product.description}`,
            keywordsText: `${product.sku} ${WOODS[n % WOODS.length]} handmade`,
            brandText: brand?.name ?? null,
            categoryText:
              n < inScope
                ? `${root.name} Bench ${(n % 48) >> 2} Bench leaf ${n % 48}`
                : (others[n % Math.max(others.length, 1)]?.name ?? 'other'),
            attributeText: [...new Set(optionText.get(n) ?? [])].join(' '),
            sku: product.sku,
            slug: product.slug,
            minPricePaise: Math.min(...prices),
            maxPricePaise: Math.max(...prices),
            inStock: true,
            popularityScore: product.soldCount,
            checksum: `bench-${n}`,
          };
        }),
    });
  }

  // From Prompt 4 on, the catalog keeps its own price index for every ACTIVE product.
  const [projection] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductListingIndex'",
  );
  if (Number(projection?.n ?? 0) > 0) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO ProductListingIndex (id, productId, minPricePaise, maxPricePaise, computedAt, createdAt, updatedAt)
      SELECT CONCAT('bli', p.id), p.id, MIN(COALESCE(v.pricePaise, p.basePricePaise)),
        MAX(COALESCE(v.pricePaise, p.basePricePaise)), NOW(3), NOW(3), NOW(3)
      FROM Product p JOIN ProductVariant v ON v.productId = p.id
      WHERE p.id LIKE 'bench%' AND p.status = 'ACTIVE' AND p.deletedAt IS NULL
      GROUP BY p.id`);
  }

  // From Prompt 5 on, the listing reads attribute membership from its own projection.
  const [attributeProjection] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductListingAttribute'",
  );
  const hasAttributeProjection = Number(attributeProjection?.n ?? 0) > 0;
  if (hasAttributeProjection) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO ProductListingAttribute (id, productId, attributeId, attributeValueId, createdAt, updatedAt)
      SELECT REPLACE(UUID(), '-', ''), t.productId, t.attributeId, t.attributeValueId, NOW(3), NOW(3)
      FROM (
        SELECT pav.productId, pav.attributeId, pav.attributeValueId
        FROM ProductAttributeValue pav JOIN ProductListingIndex li ON li.productId = pav.productId
        WHERE pav.productId LIKE 'bench%' AND pav.attributeValueId IS NOT NULL
        UNION
        SELECT v.productId, vav.attributeId, vav.attributeValueId
        FROM VariantAttributeValue vav
        JOIN ProductVariant v ON v.id = vav.variantId AND v.deletedAt IS NULL AND v.isActive = TRUE
        JOIN ProductListingIndex li ON li.productId = v.productId
        WHERE v.productId LIKE 'bench%'
      ) t`);
  }

  await prisma.$executeRawUnsafe(
    `ANALYZE TABLE Product, Category, ProductCategory, CollectionProduct, ProductVariant, VariantAttributeValue, ProductAttributeValue, ProductMedia, ProductStat, SearchDocument${Number(projection?.n ?? 0) > 0 ? ', ProductListingIndex' : ''}${hasAttributeProjection ? ', ProductListingAttribute' : ''}`,
  );

  const brandId = brands[0]!.id;
  return {
    rootSlug: root.slug,
    midSlug: middles[0]!.slug,
    leafSlug: leaves[0]!.slug,
    collectionSlug: collections[0]!.slug,
    brandId,
    colourValueId: first.values[0]!.id,
    secondValueId: second.values[1]!.id,
  };
}
