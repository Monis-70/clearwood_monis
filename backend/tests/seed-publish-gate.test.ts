import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { productAdminService } from '../src/modules/catalog-admin/product.admin.service';
import { invalidateCatalogCache } from '../src/services/categoryAttribute.service';
import { mark } from '../src/utils/uniqueMark';

import {
  CATEGORY_ATTRIBUTE_OVERRIDES,
  CATEGORY_TREE,
  type SeedCategory,
} from '../prisma/seed/data/categories';
import { DEMO_PRODUCTS } from '../prisma/seed/data/demoProducts';

/**
 * F14: the publish gate refuses specifications whose attribute the primary category does not
 * resolve (its own links plus every ancestor's). The seeded demo catalogue used to break that rule
 * for 66 of its 71 products because the seeded category tree never linked attributes those
 * products carry (warranty, frame wood, assembly, cushion firmness...). The rule was right and the
 * seed relationships were wrong, so the seed was corrected and the gate left untouched.
 */

const RUN = `F14${Date.now().toString(36).toUpperCase()}`;
const created = { products: [] as string[], categories: [] as string[] };

function seedLineage(): Map<string, Set<string>> {
  const resolved = new Map<string, Set<string>>();
  const walk = (nodes: SeedCategory[], inherited: string[]) => {
    for (const node of nodes) {
      const own = [
        ...(node.attributes ?? []),
        ...(CATEGORY_ATTRIBUTE_OVERRIDES[node.slug] ?? []).map((row) => row.code),
      ];
      const all = [...inherited, ...own];
      resolved.set(node.slug, new Set(all));
      walk(node.children ?? [], all);
    }
  };
  walk(CATEGORY_TREE, []);
  return resolved;
}

describe('F14: seeded catalogue vs the publish gate', () => {
  it('links every attribute a demo product specifies to its primary category or an ancestor', () => {
    const lineage = seedLineage();
    const foreign = DEMO_PRODUCTS.flatMap((product) => {
      const allowed = lineage.get(product.categories[0]!);
      if (!allowed) return [`${product.sku}: unknown primary ${product.categories[0]}`];
      return product.specs
        .filter((spec) => !allowed.has(spec.attribute))
        .map((spec) => `${product.sku}: ${spec.attribute} not linked to ${product.categories[0]}`);
    });
    expect(foreign).toEqual([]);
  });

  it('leaves no seeded demo product blocked by INVALID_CATEGORY_ATTRIBUTES', async () => {
    const products = await prisma.product.findMany({
      where: { sku: { in: DEMO_PRODUCTS.map((product) => product.sku) } },
      select: { id: true, sku: true },
    });
    expect(products).toHaveLength(DEMO_PRODUCTS.length);

    const blocked: string[] = [];
    for (const product of products) {
      const blockers = await productAdminService.publishBlockers(product.id);
      if (blockers.some((blocker) => blocker.code === 'INVALID_CATEGORY_ATTRIBUTES')) {
        blocked.push(product.sku);
      }
    }
    expect(blocked).toEqual([]);
  });
});

describe('F14: the gate itself is unchanged', () => {
  let productId = '';
  let parentId = '';
  let attributeId = '';

  beforeAll(async () => {
    const parentSlug = `${RUN}-parent`.toLowerCase();
    const parent = await prisma.category.create({
      data: { name: `${RUN} Parent`, slug: parentSlug, path: parentSlug, depth: 0 },
    });
    const childSlug = `${RUN}-child`.toLowerCase();
    const child = await prisma.category.create({
      data: {
        name: `${RUN} Child`,
        slug: childSlug,
        parentId: parent.id,
        path: `${parentSlug}/${childSlug}`,
        depth: 1,
      },
    });
    created.categories.push(child.id, parent.id);
    parentId = parent.id;

    const attribute = await prisma.attribute.findUniqueOrThrow({
      where: { code: 'MATTRESS_SIZE' },
      include: { values: { take: 1 } },
    });
    attributeId = attribute.id;

    const product = await prisma.product.create({
      data: { sku: `${RUN}-P`, slug: `${RUN}-p`.toLowerCase(), name: `${RUN} product` },
    });
    productId = product.id;
    created.products.push(product.id);
    await prisma.productCategory.create({
      data: {
        productId,
        categoryId: child.id,
        isPrimary: true,
        primaryMark: mark(true),
        position: 1,
      },
    });
    await prisma.productAttributeValue.create({
      data: { productId, attributeId, attributeValueId: attribute.values[0]!.id, position: 1 },
    });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: created.products } } });
    await prisma.category.deleteMany({ where: { id: { in: created.categories } } });
    await invalidateCatalogCache('attributes');
  });

  it('names the attribute the primary category does not resolve', async () => {
    const blockers = await productAdminService.publishBlockers(productId);
    const blocker = blockers.find((row) => row.code === 'INVALID_CATEGORY_ATTRIBUTES');
    expect(blocker?.details).toEqual({ attributeIds: [attributeId] });
  });

  it('accepts the specification once an ANCESTOR of the primary category links the attribute', async () => {
    await prisma.categoryAttribute.create({
      data: { categoryId: parentId, attributeId, position: 1 },
    });
    // The admin write path invalidates the resolved-attribute cache; a direct insert must too.
    await invalidateCatalogCache('attributes');

    const blockers = await productAdminService.publishBlockers(productId);
    expect(blockers.map((row) => row.code)).not.toContain('INVALID_CATEGORY_ATTRIBUTES');
  });
});
