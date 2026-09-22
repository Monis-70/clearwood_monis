import { describe, expect, it } from 'vitest';

import { MAX_CATEGORY_DEPTH } from '@shared/schemas/catalog';

import { prisma } from '../src/config/prisma';
import { categoryPathService } from '../src/services/categoryPath.service';
import { AppError } from '../src/utils/AppError';
import { slugify } from '../src/utils/slug';

describe('slugify', () => {
  it('produces URL-safe slugs that survive the shared slug schema', () => {
    expect(slugify('Ottomans & Pouffes')).toBe('ottomans-and-pouffes');
    expect(slugify('3+1+1 Sofa Sets')).toBe('3-plus-1-plus-1-sofa-sets');
    expect(slugify('  Café   Chairs  ')).toBe('cafe-chairs');
  });
});

describe('categoryPathService.buildPath', () => {
  it('materialises the slug path from the parent down', () => {
    expect(categoryPathService.buildPath(null, 'sofas')).toBe('sofas');
    expect(categoryPathService.buildPath('sofas', 'fabric-sofas')).toBe('sofas/fabric-sofas');
    expect(categoryPathService.depthFor(null)).toBe(0);
    expect(categoryPathService.depthFor(1)).toBe(2);
  });

  it('matches what the seed wrote for every category', async () => {
    const categories = await prisma.category.findMany({
      where: { deletedAt: null },
      select: { slug: true, path: true, depth: true, parentId: true },
    });
    const bySlugPath = new Map(categories.map((row) => [row.path, row]));

    for (const category of categories) {
      const segments = categoryPathService.ancestorSlugs(category.path);
      expect(segments.at(-1)).toBe(category.slug);
      expect(category.depth).toBe(segments.length - 1);

      if (segments.length > 1) {
        const parentPath = segments.slice(0, -1).join('/');
        expect(bySlugPath.has(parentPath)).toBe(true);
      } else {
        expect(category.parentId).toBeNull();
      }
    }
  });
});

describe('categoryPathService.recomputeSubtree', () => {
  it('is a no-op when the seeded paths are already correct', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    expect(await categoryPathService.recomputeSubtree(sofas.id)).toBe(0);
  });

  it('repairs a corrupted subtree', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    const fabric = await prisma.category.findUniqueOrThrow({ where: { slug: 'fabric-sofas' } });

    await prisma.category.update({
      where: { id: fabric.id },
      data: { path: 'wrong/place', depth: 9 },
    });

    const updated = await categoryPathService.recomputeSubtree(sofas.id);
    expect(updated).toBeGreaterThan(0);

    const repaired = await prisma.category.findUniqueOrThrow({ where: { id: fabric.id } });
    expect(repaired.path).toBe('sofas/fabric-sofas');
    expect(repaired.depth).toBe(1);
  });
});

describe('categoryPathService.assertNoCycle', () => {
  it('rejects a category becoming its own parent', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });

    await expect(categoryPathService.assertNoCycle(sofas.id, sofas.id)).rejects.toMatchObject({
      code: 'CATEGORY_CYCLE',
      statusCode: 409,
    });
  });

  it('rejects a parent that is already a descendant', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    const fabric = await prisma.category.findUniqueOrThrow({ where: { slug: 'fabric-sofas' } });

    await expect(categoryPathService.assertNoCycle(sofas.id, fabric.id)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('allows a legitimate parent', async () => {
    const chairs = await prisma.category.findUniqueOrThrow({ where: { slug: 'chairs' } });
    const fabric = await prisma.category.findUniqueOrThrow({ where: { slug: 'fabric-sofas' } });

    await expect(categoryPathService.assertNoCycle(fabric.id, chairs.id)).resolves.toBeUndefined();
  });
});

describe('category depth cap', () => {
  it(`refuses anything deeper than ${MAX_CATEGORY_DEPTH}`, () => {
    expect(() => categoryPathService.assertDepthWithinCap(MAX_CATEGORY_DEPTH, 'ok')).not.toThrow();
    expect(() =>
      categoryPathService.assertDepthWithinCap(MAX_CATEGORY_DEPTH + 1, 'too-deep'),
    ).toThrow(AppError);
  });

  it('no seeded category exceeds the cap', async () => {
    const deepest = await prisma.category.aggregate({ _max: { depth: true } });
    expect(deepest._max.depth ?? 0).toBeLessThanOrEqual(MAX_CATEGORY_DEPTH);
  });
});
