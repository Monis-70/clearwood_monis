import {
  CATEGORY_ATTRIBUTE_OVERRIDES,
  CATEGORY_TREE,
  categorySeo,
  deriveCategoryKind,
  type SeedCategory,
} from './data/categories';
import { log, prisma } from './context';

/**
 * Seeds the complete site map from docs/PROJECT_CONTEXT.md §8.
 * Structure (parent, path, depth, position, kind, menu visibility) is synced on every run;
 * editorial content (name, descriptions, SEO copy, banners) is written once and then preserved,
 * so re-seeding can never undo an admin edit.
 */
export async function seedCategories(): Promise<void> {
  const attributeIds = new Map(
    (
      await prisma.attribute.findMany({ select: { id: true, code: true, isVariantDefining: true } })
    ).map((row) => [row.code, row]),
  );

  let categoryCount = 0;
  let linkCount = 0;

  async function walk(
    nodes: SeedCategory[],
    parent: { id: string; path: string; depth: number; name: string; slug: string } | null,
  ): Promise<void> {
    for (const [index, node] of nodes.entries()) {
      const kind = node.kind ?? deriveCategoryKind(node.name, parent?.slug ?? null);
      const path = parent ? `${parent.path}/${node.slug}` : node.slug;
      const depth = parent ? parent.depth + 1 : 0;
      const seo = categorySeo(node.name, parent?.name ?? null);

      const row = await prisma.category.upsert({
        where: { slug: node.slug },
        update: {
          parentId: parent?.id ?? null,
          path,
          depth,
          position: index + 1,
          kind,
          showInMenu: node.showInMenu ?? true,
          isFeatured: node.isFeatured ?? false,
          menuColumn: node.menuColumn ?? null,
          isActive: true,
          deletedAt: null,
        },
        create: {
          name: node.name,
          slug: node.slug,
          parentId: parent?.id ?? null,
          path,
          depth,
          position: index + 1,
          kind,
          showInMenu: node.showInMenu ?? true,
          isFeatured: node.isFeatured ?? false,
          menuColumn: node.menuColumn ?? null,
          shortDescription: node.shortDescription ?? null,
          ...seo,
        },
      });
      categoryCount += 1;

      const overrides = CATEGORY_ATTRIBUTE_OVERRIDES[node.slug] ?? [];
      const codes = [...new Set([...(node.attributes ?? []), ...overrides.map((o) => o.code)])];

      for (const [attributeIndex, code] of codes.entries()) {
        const attribute = attributeIds.get(code);
        if (!attribute)
          throw new Error(`Category "${node.slug}" references unknown attribute ${code}`);

        const override = overrides.find((entry) => entry.code === code);
        await prisma.categoryAttribute.upsert({
          where: {
            categoryId_attributeId: { categoryId: row.id, attributeId: attribute.id },
          },
          update: {
            position: attributeIndex + 1,
            isRequired: override?.isRequired ?? false,
            isVariantDefining: attribute.isVariantDefining,
          },
          create: {
            categoryId: row.id,
            attributeId: attribute.id,
            position: attributeIndex + 1,
            isRequired: override?.isRequired ?? false,
            isVariantDefining: attribute.isVariantDefining,
            isFilterable: true,
          },
        });
        linkCount += 1;
      }

      if (node.children?.length) {
        await walk(node.children, {
          id: row.id,
          path,
          depth,
          name: node.name,
          slug: node.slug,
        });
      }
    }
  }

  await walk(CATEGORY_TREE, null);

  log('categories', `${categoryCount} categories and ${linkCount} attribute links upserted`);
}
