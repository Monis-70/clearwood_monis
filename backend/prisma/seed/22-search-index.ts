import { popularityService, searchIndexerService } from '../../src/container';

import { log } from './context';

/**
 * Builds the initial SearchDocument set.
 *
 * Idempotent by construction: every document carries a checksum, so a re-seed rewrites nothing
 * unless the underlying product actually changed. The indexed price range comes from the Prompt 6
 * pricing facade — there is no second price calculation anywhere in the indexer.
 */
export async function seedSearchIndex(): Promise<void> {
  const created = await popularityService.backfill();
  const outcome = await searchIndexerService.reindexAll();

  log(
    'search-index',
    `${outcome.processed} products scanned, ${outcome.written} documents written, ` +
      `${created} stat rows created${outcome.failed > 0 ? `, ${outcome.failed} failed` : ''}`,
  );
}
