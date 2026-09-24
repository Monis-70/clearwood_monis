import { COLLECTIONS } from './data/collections';
import { log, prisma } from './context';

/**
 * CREATE-ONLY: an existing collection (active or deleted) is the admin's - its type, rules,
 * position, window and state are never rewritten by a re-run. One the admin renamed is found
 * through its slug redirect, so the old seed slug does not come back as a second collection.
 *
 * Returns the slugs created in THIS run (see seedCategories).
 */
export async function seedCollections(): Promise<Set<string>> {
  const createdSlugs = new Set<string>();

  for (const collection of COLLECTIONS) {
    const existing = await prisma.collection.findUnique({
      where: { slug: collection.slug },
      select: { id: true },
    });
    if (existing) continue;

    const renamed = await prisma.slugRedirect.findFirst({
      where: { entityType: 'COLLECTION', fromSlug: collection.slug },
      select: { id: true },
    });
    if (renamed) continue;

    // D3 — the rules live in a String column, serialised here and parsed with jsonColumn().
    await prisma.collection.create({
      data: {
        slug: collection.slug,
        name: collection.name,
        type: collection.type,
        description: collection.description,
        rulesJson: JSON.stringify(collection.rules),
        position: collection.position,
      },
    });
    createdSlugs.add(collection.slug);
  }

  log('collections', `${COLLECTIONS.length} collections ensured (${createdSlugs.size} created)`);
  return createdSlugs;
}
