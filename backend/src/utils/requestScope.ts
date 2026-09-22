import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped deduplication of identical work.
 *
 * THE DISTINCTION THIS FILE EXISTS TO ENFORCE — read before using it:
 *
 *   ALLOWED  Two places in ONE request ask for the SAME thing with the SAME arguments. The second
 *            caller joins the first caller's in-flight promise. Nothing is remembered past the
 *            response, so a write in the next request is seen immediately, and the query count
 *            does not depend on how many items the request happens to contain.
 *
 *   BANNED   Using this to make a per-item query pattern cheap. If the work being deduplicated is
 *            keyed by an item id, the memo hides an N+1 rather than removing it: the first request
 *            for a new item still pays per item, and the count still grows with the cart, the grid
 *            or the block list. Batch the query instead.
 *
 * The test for which one you have: if the key contains an id that varies per line of the request,
 * stop and batch. If the key is constant for the whole request, this is the right tool.
 *
 * Outside a request there is no store, so `once` simply runs the function. Jobs, the seed and unit
 * tests therefore behave exactly as they did before this existed.
 */
const storage = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export const requestScope = {
  /** Runs `fn` inside a fresh scope. Everything awaited within shares one memo. */
  run<T>(fn: () => T): T {
    return storage.run(new Map(), fn);
  },

  /** The first caller does the work; later callers in the same request await the same promise. */
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const store = storage.getStore();
    if (!store) return fn();

    const inFlight = store.get(key);
    if (inFlight) return inFlight as Promise<T>;

    // Not cached on rejection: a failed load must be retried, not remembered.
    const pending = fn().catch((error: unknown) => {
      store.delete(key);
      throw error;
    });

    store.set(key, pending);
    return pending;
  },

  active(): boolean {
    return storage.getStore() !== undefined;
  },
};
