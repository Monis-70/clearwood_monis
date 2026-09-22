import { COLLECTIONS } from './data/collections';
import { log, prisma } from './context';

export async function seedCollections(): Promise<void> {
  for (const collection of COLLECTIONS) {
    // D3 — the rules live in a String column, serialised here and parsed with jsonColumn().
    const rulesJson = JSON.stringify(collection.rules);

    await prisma.collection.upsert({
      where: { slug: collection.slug },
      update: {
        type: collection.type,
        rulesJson,
        position: collection.position,
        isActive: true,
        deletedAt: null,
      },
      create: {
        slug: collection.slug,
        name: collection.name,
        type: collection.type,
        description: collection.description,
        rulesJson,
        position: collection.position,
      },
    });
  }

  log('collections', `${COLLECTIONS.length} collections upserted`);
}
