/**
 * Slug generation shared by the seed and by Prompt 5's admin CRUD. The output always satisfies
 * `slugSchema` in shared/src/schemas/common.ts, so a slug is safe to put straight into a URL.
 */

/** Anything that can tell us whether a slug is already in use (a repository, usually). */
export interface SlugOwnerModel {
  slugExists(slug: string, excludeId?: string): Promise<boolean>;
}

const MAX_SLUG_LENGTH = 160;

export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');

  if (!slug) throw new Error(`"${input}" does not contain any slug-safe characters`);
  return slug;
}

/** Appends `-2`, `-3`, … until the slug is free. `excludeId` lets a row keep its own slug. */
export async function ensureUniqueSlug(
  model: SlugOwnerModel,
  base: string,
  excludeId?: string,
): Promise<string> {
  const root = slugify(base);

  if (!(await model.slugExists(root, excludeId))) return root;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${root.slice(0, MAX_SLUG_LENGTH - 5)}-${suffix}`;
    if (!(await model.slugExists(candidate, excludeId))) return candidate;
  }

  throw new Error(`could not find a free slug for "${base}"`);
}
