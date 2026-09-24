import { describe, expect, it, vi } from 'vitest';

import { prisma } from '../src/config/prisma';
import { searchIndexerService } from '../src/modules/storefront/searchIndexer.service';
import { searchDocumentRepository } from '../src/repositories/searchDocument.repository';
import { storefrontRepository } from '../src/repositories/storefront.repository';

import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';

// Both races were seen on the VPS in the Prompt 8 deploy, as "catalog event listener failed".

const CONCURRENCY = 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('search index writes under concurrency', () => {
  it('lets every concurrent upsert of one document succeed and keeps exactly one row', async () => {
    const entityId = `race-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

    const result = await runConcurrently(CONCURRENCY, (index) =>
      searchDocumentRepository.upsert({
        entityType: 'COLLECTION',
        entityId,
        locale: 'en',
        title: `Race ${index}`,
        subtitle: null,
        bodyText: '',
        keywordsText: '',
        brandText: null,
        categoryText: '',
        attributeText: '',
        sku: null,
        slug: entityId,
        minPricePaise: null,
        maxPricePaise: null,
        inStock: true,
        isActive: true,
        popularityScore: 0,
        boostScore: 0,
        checksum: String(index).padStart(64, '0'),
      }),
    );

    try {
      expectNoInfrastructureFailures(result);
      expect(result.ok, `rejected: ${result.reasons.join('; ')}`).toBe(CONCURRENCY);
      expect(
        await prisma.searchDocument.count({ where: { entityType: 'COLLECTION', entityId } }),
      ).toBe(1);
    } finally {
      await prisma.searchDocument.deleteMany({ where: { entityId } });
    }
  }, 60_000);

  it('never lets an older category rebuild prune a document a newer one wrote', async () => {
    const tag = `${process.pid}${Math.random().toString(36).slice(2, 8)}`;
    // Index everything first, so the race below is about one new document and nothing else.
    await searchIndexerService.indexCategories();
    const fresh = await prisma.category.create({
      data: { name: `Race ${tag}`, slug: `race-${tag}`, path: `race-${tag}`, depth: 0 },
    });

    const real = storefrontRepository.findIndexableCategories.bind(storefrontRepository);
    let calls = 0;
    const spy = vi
      .spyOn(storefrontRepository, 'findIndexableCategories')
      .mockImplementation(async () => {
        calls += 1;
        const call = calls;
        const rows = await real();
        if (call > 1) return rows;
        // A stale snapshot, returned only after a newer rebuild indexed the category (or 1.5 s).
        const deadline = Date.now() + 1_500;
        while (Date.now() < deadline) {
          const written = await prisma.searchDocument.count({
            where: { entityType: 'CATEGORY', entityId: fresh.id },
          });
          if (written > 0) break;
          await sleep(50);
        }
        return rows.filter((row) => row.id !== fresh.id);
      });

    try {
      // A category event lands while an earlier rebuild, holding a stale snapshot, is running.
      const earlier = searchIndexerService.indexCategories();
      while (calls === 0) await sleep(5);
      const later = searchIndexerService.indexCategories();
      await Promise.all([earlier, later]);
      expect(calls, 'both rebuilds read the category tree').toBe(2);
      expect(
        await prisma.searchDocument.count({
          where: { entityType: 'CATEGORY', entityId: fresh.id },
        }),
      ).toBe(1);
    } finally {
      spy.mockRestore();
      await prisma.searchDocument.deleteMany({ where: { entityId: fresh.id } });
      await prisma.category.delete({ where: { id: fresh.id } });
    }
  }, 60_000);
});
