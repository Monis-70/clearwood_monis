import { describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { searchDocumentRepository } from '../src/repositories/searchDocument.repository';

import { expectNoInfrastructureFailures, runConcurrently } from './helpers/concurrency';

/**
 * Two catalog events for one entity - a collection created, then its products set a moment later -
 * index the same search document at once. Prisma's upsert on MySQL reads, then inserts, so the
 * slower writer hit the unique key and its write was dropped (seen on the VPS in the Prompt 8
 * deploy, as "catalog event listener failed" with P2002 on SearchDocument).
 */

const CONCURRENCY = 10;

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
});
