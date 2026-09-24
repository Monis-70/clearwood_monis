import {
  CATEGORY_ATTRIBUTE_OVERRIDES,
  CATEGORY_TREE,
  categorySeo,
  deriveCategoryKind,
  type SeedCategory,
} from './data/categories';
import { log, prisma } from './context';

interface Placed {
  id: string;
  path: string;
  depth: number;
  name: string;
  slug: string;
  deletedAt: Date | null;
}

const PLACED = { id: true, path: true, depth: true, name: true, slug: true, deletedAt: true };

/** The row a seed slug refers to today: by slug, or by the slug an admin renamed it away from. */
async function resolve(slug: string): Promise<Placed | null> {
  const direct = await prisma.category.findUnique({ where: { slug }, select: PLACED });
  if (direct) return direct;

  const redirect = await prisma.slugRedirect.findFirst({
    where: { entityType: 'CATEGORY', fromSlug: slug },
    orderBy: { createdAt: 'desc' },
    select: { entityId: true },
  });
  return redirect
    ? prisma.category.findUnique({ where: { id: redirect.entityId }, select: PLACED })
    : null;
}

/**
 * Seeds the site map CREATE-ONLY. The catalog belongs to the admin once it exists:
 *   - a category that already exists (by slug, or by a slug an admin renamed away from) is left
 *     exactly as it is - name, parent, position, status, kind and attribute links alike;
 *   - a deleted one stays deleted, and so does everything the seed would have put under it;
 *   - a missing one is created under its parent's CURRENT path, with its attribute links.
 * So a deploy that re-runs the seed can add new categories but never undo an admin's edit.
 *
 * Returns the slugs it created in THIS run, so later steps seed rows that belong to a new category
 * (its menu entry) without re-adding rows an admin removed from an existing one.
 */
export async function seedCategories(): Promise<Set<string>> {
  const createdSlugs = new Set<string>();
  const attributeIds = new Map(
    (
      await prisma.attribute.findMany({ select: { id: true, code: true, isVariantDefining: true } })
    ).map((row) => [row.code, row]),
  );

  let created = 0;
  let kept = 0;
  let linkCount = 0;

  async function walk(nodes: SeedCategory[], parent: Placed | null): Promise<void> {
    for (const [index, node] of nodes.entries()) {
      const existing = await resolve(node.slug);
      if (existing?.deletedAt) continue;

      let row = existing;
      if (row) {
        kept += 1;
      } else {
        const kind = node.kind ?? deriveCategoryKind(node.name, parent?.slug ?? null);
        row = await prisma.category.create({
          data: {
            name: node.name,
            slug: node.slug,
            parentId: parent?.id ?? null,
            path: parent ? `${parent.path}/${node.slug}` : node.slug,
            depth: parent ? parent.depth + 1 : 0,
            position: index + 1,
            kind,
            showInMenu: node.showInMenu ?? true,
            isFeatured: node.isFeatured ?? false,
            menuColumn: node.menuColumn ?? null,
            leadFormKey: node.leadFormKey ?? null,
            shortDescription: node.shortDescription ?? null,
            ...categorySeo(node.name, parent?.name ?? null),
          },
          select: PLACED,
        });
        created += 1;
        createdSlugs.add(node.slug);

        // Links are part of the new category; an existing one's links are the admin's.
        const overrides = CATEGORY_ATTRIBUTE_OVERRIDES[node.slug] ?? [];
        const codes = [...new Set([...(node.attributes ?? []), ...overrides.map((o) => o.code)])];

        for (const [attributeIndex, code] of codes.entries()) {
          const attribute = attributeIds.get(code);
          if (!attribute) {
            throw new Error(`Category "${node.slug}" references unknown attribute ${code}`);
          }

          const override = overrides.find((entry) => entry.code === code);
          await prisma.categoryAttribute.create({
            data: {
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
      }

      if (node.children?.length) await walk(node.children, row);
    }
  }

  await walk(CATEGORY_TREE, null);

  log(
    'categories',
    `${created} categories and ${linkCount} attribute links created, ${kept} left as they are`,
  );
  return createdSlugs;
}
