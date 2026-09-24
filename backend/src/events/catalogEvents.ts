import { logger } from '../config/logger';

/**
 * A deliberately tiny in-process event bus for catalog writes.
 *
 * Prompt 5's admin services already invalidate caches on write; Prompt 7 needs the search index
 * refreshed on exactly the same events. Rather than bolting a second call onto every write path,
 * writes emit here once and both listeners (cache invalidation and incremental reindex) react —
 * which is what keeps the two from drifting apart.
 *
 * Listeners are fire-and-forget: a failed reindex logs and is retried by the next write or by an
 * admin reindex job, but it must never fail the admin's save.
 */

export interface CatalogEventMap {
  'product.changed': { productId: string; reason: string };
  'product.removed': { productId: string };
  /** `categoryIds`: the nodes whose subtree changed; absent = any category may have. */
  'category.changed': { categoryId?: string; categoryIds?: string[]; reason: string };
  'collection.changed': { collectionId?: string; reason: string };
  'brand.changed': { brandId?: string; reason: string };
  /** `textUnchanged`: groups, ordering, category mapping - nothing a product document shows. */
  'attribute.changed': { attributeId?: string; textUnchanged?: boolean; reason: string };
  'inventory.changed': { productId: string; variantId: string };
  /** A price rule, tier, price list or tax class moved: the indexed price range is now stale. */
  'pricing.changed': { productIds?: string[]; reason: string };
  /** Prompt 8 — the counters Prompt 7 left at zero. */
  'cart.item.added': { productId: string; variantId: string | null; qty: number };
  'wishlist.item.added': { productId: string };
  'wishlist.item.removed': { productId: string };
  /** Prompt 9A — the last counter Prompt 7 left at zero, plus the sold count on the product. */
  'order.confirmed': { productId: string; variantId: string | null; qty: number };

  /** A CMS page or help article was published, edited or withdrawn (Prompt B1 Task 4). */
  'content.changed': { reason: string };
}

export type CatalogEventName = keyof CatalogEventMap;

type Listener<K extends CatalogEventName> = (payload: CatalogEventMap[K]) => void | Promise<void>;

const listeners = new Map<CatalogEventName, Listener<CatalogEventName>[]>();

/** Awaited by tests so an assertion never races the listener. */
const inFlight = new Set<Promise<void>>();

export const catalogEvents = {
  on<K extends CatalogEventName>(event: K, listener: Listener<K>): void {
    const current = listeners.get(event) ?? [];
    listeners.set(event, [...current, listener as Listener<CatalogEventName>]);
  },

  emit<K extends CatalogEventName>(event: K, payload: CatalogEventMap[K]): void {
    for (const listener of listeners.get(event) ?? []) {
      const task = Promise.resolve()
        .then(() => listener(payload))
        .catch((error: unknown) => {
          logger.warn({ err: error, event, payload }, 'catalog event listener failed');
        })
        .finally(() => {
          inFlight.delete(task);
        });

      inFlight.add(task);
    }
  },

  /** Lets a test (or a request that must be read-your-writes) wait for the listeners to settle. */
  async settled(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight]);
    }
  },

  reset(): void {
    listeners.clear();
  },

  listenerCount(event: CatalogEventName): number {
    return (listeners.get(event) ?? []).length;
  },
};
