import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { catalogScheduleRepository } from '../../repositories/catalogSchedule.repository';
import { listingIndexRepository } from '../../repositories/listingIndex.repository';
import { maintenanceTaskRepository } from '../../repositories/maintenanceTask.repository';
import {
  priceScheduleRepository,
  type WindowedAdjustment,
  type WindowedPriceList,
} from '../../repositories/priceSchedule.repository';
import { storefrontRepository } from '../../repositories/storefront.repository';
import { categoryService } from '../../services/category.service';
import { catalogCacheService } from '../catalog-admin/catalogCache.service';

import { collectionRulesService } from './collectionRules.service';
import { listingIndexService } from './listingIndex.service';
import { searchIndexerService } from './searchIndexer.service';
import { settingsService } from './storefrontSettings.service';

/**
 * Keeps `ProductListingIndex` true over TIME, not only on writes (PROJECT_CONTEXT §45).
 *
 * Each run, under a MySQL lease (MaintenanceTask 'listing-index'), covers the span since the last
 * run's watermark and re-prices:
 *   - every product a price window opened or closed for in that span (PriceAdjustment and
 *     PriceList startsAt/endsAt, weekday-conditioned rules at each UTC midnight), for the default
 *     audience the index is priced for;
 *   - everything, when a rebuild was requested (a pricing write whose reach is unknown or wide)
 *     or a GLOBAL rule's window crossed;
 *   - products MySQL itself says are stale - no row, or a product/variant row written after its
 *     index row was computed - which is what repairs a lost or forgotten event.
 * Then the catalog's own clock (PROJECT_CONTEXT §47): scheduled products that went live get their
 * search documents, featured and new-arrival windows that ended and collection windows that
 * opened or closed drop the caches that judged them, AUTOMATIC collections are re-evaluated and
 * category counts recomputed when the catalog was written or the clock crossed something.
 * Then it drops the price-bearing caches and advances the watermark.
 *
 * Every PM2 worker may call run(); the lease (a compare-and-set UPDATE, renewed between batches,
 * expiring if its holder dies) means one of them does the work and the others return at once.
 * The watermark only advances when a run completes while still holding the lease, so a crashed
 * or lease-less run leaves its span to the next holder; re-pricing is idempotent, so a span done
 * twice is only wasted work, never a wrong price.
 */

export const LISTING_TASK = 'listing-index';

/** Stale rows repaired per run, so one run stays bounded; the rest wait for the next. */
const STALE_PER_RUN = 2_000;
const REPRICE_BATCH = 200;
/** Rebuild requests that arrive during a run are served by at most this many extra rounds. */
const MAX_ROUNDS = 3;

const PROCESS_OWNER = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export interface ReconcileOutcome {
  ran: boolean;
  owner: string;
  from: string | null;
  to: string;
  rebuilt: boolean;
  windows: number;
  repriced: number;
  stale: number;
  pruned: number;
  cachesDropped: boolean;
  schedule: ScheduleOutcome;
}

/** What the catalog's clock moved during the span. */
export interface ScheduleOutcome {
  /** Scheduled products that went live. */
  published: number;
  /** Featured products whose `featuredUntil` passed. */
  featureEnded: number;
  /** Products that aged out of the new-arrival window. */
  arrivalsAged: number;
  /** Collections whose startsAt or endsAt passed. */
  collectionWindows: number;
  /** AUTOMATIC collections whose membership changed on re-evaluation. */
  collectionsChanged: number;
  /** Categories whose `productCountCache` changed. */
  countsUpdated: number;
}

const NO_SCHEDULE: ScheduleOutcome = {
  published: 0,
  featureEnded: 0,
  arrivalsAged: 0,
  collectionWindows: 0,
  collectionsChanged: 0,
  countsUpdated: 0,
};

const DAY_MS = 86_400_000;

class LeaseLostError extends Error {
  constructor() {
    super('the listing reconciler lease was lost mid-run');
  }
}

const utcDay = (date: Date) => Math.floor(date.getTime() / 86_400_000);

let inFlight: Promise<ReconcileOutcome> | null = null;

export const listingReconciler = {
  owner: PROCESS_OWNER,

  /**
   * Offer to run in this process. Concurrent callers here share one run; callers in other
   * processes are turned away by the lease. Rebuild requests raised meanwhile get another round.
   */
  run(): Promise<ReconcileOutcome> {
    inFlight ??= (async () => {
      try {
        let outcome = await this.runOnce(PROCESS_OWNER);
        for (let round = 1; round < MAX_ROUNDS && outcome.ran; round += 1) {
          const state = await maintenanceTaskRepository.read(LISTING_TASK);
          const pending =
            state?.rebuildRequestedAt &&
            (!state.lastRebuiltAt || state.rebuildRequestedAt > state.lastRebuiltAt);
          if (!pending) break;
          outcome = await this.runOnce(PROCESS_OWNER);
        }
        return outcome;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  /** Resolves once this process has no run in progress (tests; graceful shutdown). */
  async idle(): Promise<void> {
    if (inFlight) await inFlight.catch(() => undefined);
  },

  /**
   * Durable: the request survives this process, and whichever process holds the lease next
   * honours it - once, however many writes asked while it was pending.
   */
  async requestRebuild(): Promise<void> {
    await maintenanceTaskRepository.ensure(LISTING_TASK);
    await maintenanceTaskRepository.requestRebuild(LISTING_TASK, new Date());
    void this.run().catch((error: unknown) =>
      logger.warn({ err: error }, 'listing reconcile after a rebuild request failed'),
    );
  },

  /** A category, collection or attribute write: re-price only if some live rule reads that fact. */
  async requestRebuildIfRulesRead(
    fact: 'categoryId' | 'collectionId' | 'attributeValueId',
  ): Promise<boolean> {
    if ((await priceScheduleRepository.countRulesReading(fact)) === 0) return false;
    await this.requestRebuild();
    return true;
  },

  /** One leased pass. `owner` names the caller in the lease (tests stand in for other workers). */
  async runOnce(owner: string): Promise<ReconcileOutcome> {
    const to = new Date();
    const leaseMs = env.LISTING_RECONCILE_LEASE_SECONDS * 1_000;
    const outcome: ReconcileOutcome = {
      ran: false,
      owner,
      from: null,
      to: to.toISOString(),
      rebuilt: false,
      windows: 0,
      repriced: 0,
      stale: 0,
      pruned: 0,
      cachesDropped: false,
      schedule: { ...NO_SCHEDULE },
    };

    await maintenanceTaskRepository.ensure(LISTING_TASK);
    const acquired = await maintenanceTaskRepository.tryAcquire(
      LISTING_TASK,
      owner,
      to,
      new Date(to.getTime() + leaseMs),
    );
    if (!acquired) return outcome;
    outcome.ran = true;

    const keepAlive = async () => {
      const now = new Date();
      const held = await maintenanceTaskRepository.renew(
        LISTING_TASK,
        owner,
        now,
        new Date(now.getTime() + leaseMs),
      );
      if (!held) throw new LeaseLostError();
    };

    try {
      const state = await maintenanceTaskRepository.read(LISTING_TASK);
      // First run: nothing older than the oldest index row can still be unapplied.
      const from = state?.watermarkAt ?? (await listingIndexRepository.oldestComputedAt()) ?? to;
      outcome.from = from.toISOString();

      const plan = await this.plan(from, to);
      outcome.windows = plan.windows;
      const rebuildRequested = Boolean(
        state?.rebuildRequestedAt &&
        (!state.lastRebuiltAt || state.rebuildRequestedAt > state.lastRebuiltAt),
      );

      if (rebuildRequested || plan.reach === 'ALL') {
        await searchIndexerService.reindexAll('PRODUCT', undefined, keepAlive);
        outcome.rebuilt = true;
      } else {
        const stale = await listingIndexRepository.findStale(STALE_PER_RUN);
        outcome.stale = stale.length;

        const targets = [...new Set([...plan.reach, ...stale])];
        for (let index = 0; index < targets.length; index += REPRICE_BATCH) {
          const batch = targets.slice(index, index + REPRICE_BATCH);
          await listingIndexService.refreshMany(batch);
          await searchIndexerService.indexProducts(batch);
          await keepAlive();
        }
        outcome.repriced = targets.length;
        outcome.pruned = await listingIndexRepository.pruneUnpriceable();
      }

      outcome.schedule = await this.schedule(from, to, {
        reindexed: outcome.rebuilt,
        keepAlive,
      });
      const scheduleMoved = Object.values(outcome.schedule).some((count) => count > 0);

      if (
        outcome.rebuilt ||
        outcome.repriced > 0 ||
        outcome.pruned > 0 ||
        outcome.windows > 0 ||
        plan.checkoutRules > 0
      ) {
        await catalogCacheService.invalidatePrices();
        outcome.cachesDropped = true;
      }
      if (scheduleMoved) {
        await catalogCacheService.invalidateSchedule();
        outcome.cachesDropped = true;
      }

      const completed = await maintenanceTaskRepository.complete(LISTING_TASK, owner, {
        watermarkAt: to,
        rebuiltAt: outcome.rebuilt ? to : null,
        completedAt: new Date(),
      });
      if (!completed) {
        logger.warn({ owner }, 'listing reconcile finished after losing its lease; span retried');
      }
      if (outcome.rebuilt || outcome.repriced > 0 || outcome.windows > 0 || scheduleMoved) {
        logger.info({ outcome }, 'listing index reconciled');
      }
      return outcome;
    } catch (error) {
      await maintenanceTaskRepository
        .fail(
          LISTING_TASK,
          owner,
          error instanceof Error ? error.message : String(error),
          new Date(),
        )
        .catch(() => undefined);
      throw error;
    }
  },

  /**
   * The catalog facts the clock moved in (from, to]. `reindexed`: this run already rebuilt every
   * product document, so the published and feature-ended ones need no second pass.
   */
  async schedule(
    from: Date,
    to: Date,
    run: { reindexed: boolean; keepAlive: () => Promise<void> },
  ): Promise<ScheduleOutcome> {
    const settings = await settingsService.read();
    const arrivalWindowMs = settings.newArrivalDays * DAY_MS;

    const [published, featureEnded, arrivalsAged, collectionWindows, written] = await Promise.all([
      catalogScheduleRepository.productsPublishedBetween(from, to),
      catalogScheduleRepository.productsFeatureEndedBetween(from, to),
      arrivalWindowMs > 0
        ? catalogScheduleRepository.countArrivalsAgedOut(from, to, arrivalWindowMs)
        : Promise.resolve(0),
      catalogScheduleRepository.countCollectionsCrossing(from, to),
      catalogScheduleRepository.catalogWrittenSince(from),
    ]);

    // A scheduled product had no search document until now; an expired feature loses its boost.
    const documents = run.reindexed ? [] : [...new Set([...published, ...featureEnded])];
    for (let index = 0; index < documents.length; index += REPRICE_BATCH) {
      await searchIndexerService.indexProducts(documents.slice(index, index + REPRICE_BATCH));
      await run.keepAlive();
    }
    if (collectionWindows > 0) await searchIndexerService.indexCollections();

    const crossed =
      published.length > 0 || featureEnded.length > 0 || arrivalsAged > 0 || collectionWindows > 0;
    const outcome: ScheduleOutcome = {
      published: published.length,
      featureEnded: featureEnded.length,
      arrivalsAged,
      collectionWindows,
      collectionsChanged: 0,
      countsUpdated: 0,
    };
    if (!crossed && !written && utcDay(from) === utcDay(to)) return outcome;

    // Rules read product facts, links and the clock: re-evaluated quietly, announced on change.
    for (const collection of await storefrontRepository.findAutomaticCollectionIds()) {
      try {
        const result = await collectionRulesService.evaluate(collection.id, { quiet: true });
        if (result.added > 0 || result.removed > 0) outcome.collectionsChanged += 1;
      } catch (error) {
        logger.warn({ err: error, collectionId: collection.id }, 'collection re-evaluation failed');
      }
      await run.keepAlive();
    }

    outcome.countsUpdated = await categoryService.recomputeProductCounts(to);
    return outcome;
  },

  /** Which products the price windows crossed in (from, to] reach, for the default audience. */
  async plan(
    from: Date,
    to: Date,
  ): Promise<{ reach: 'ALL' | string[]; windows: number; checkoutRules: number }> {
    const dayChanged = utcDay(from) !== utcDay(to);
    const [adjustments, weekday, priceLists, defaultGroupId, checkoutRules] = await Promise.all([
      priceScheduleRepository.adjustmentsCrossing(from, to),
      dayChanged ? priceScheduleRepository.weekdayAdjustments() : Promise.resolve([]),
      priceScheduleRepository.priceListsCrossing(from, to),
      priceScheduleRepository.defaultGroupId(),
      priceScheduleRepository.checkoutRulesCrossing(from, to, dayChanged),
    ]);

    // The index is priced for the default group on the WEB channel; other audiences' live prices
    // still changed, which is why the caches drop for any window at all.
    const priced = (rule: WindowedAdjustment | WindowedPriceList) =>
      (rule.customerGroupId === null || rule.customerGroupId === defaultGroupId) &&
      (rule.channel === 'ALL' || rule.channel === 'WEB');

    const rules = [
      ...new Map([...adjustments, ...weekday].map((rule) => [rule.id, rule])).values(),
    ];
    const windows = rules.length + priceLists.length;

    const reach = new Set<string>();
    for (const rule of rules.filter(priced)) {
      const products = await priceScheduleRepository.productsForRule(rule);
      if (products === 'ALL') return { reach: 'ALL', windows, checkoutRules };
      for (const id of products) reach.add(id);
    }
    for (const id of await priceScheduleRepository.productsForPriceLists(
      priceLists.filter(priced).map((list) => list.id),
    )) {
      reach.add(id);
    }

    return { reach: [...reach], windows, checkoutRules };
  },
};
