import { catalogCacheService } from '../modules/catalog-admin/catalogCache.service';

import { categoryService } from './category.service';

/**
 * Keeps `Category.productCountCache` in step with the writes that move it (a product filed,
 * moved, published, deleted or restored; a category moved, hidden or deleted) instead of waiting
 * for the listing reconciler's next pass. The reconciler still recounts on its own schedule: it is
 * the durable backstop across PM2 workers, which each recount only after their own writes.
 *
 * Coalesced per process: a burst of writes shares one recount, and a request that arrives while
 * one is running gets exactly one more pass, so the last write is always counted.
 */

let running: Promise<void> | null = null;
let again = false;

async function loop(): Promise<void> {
  try {
    do {
      again = false;
      const updated = await categoryService.recomputeProductCounts();
      if (updated > 0) await catalogCacheService.invalidateCategoryCounts();
    } while (again);
  } finally {
    running = null;
  }
}

export const categoryCountsService = {
  recount(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = loop();
    return running;
  },
};
