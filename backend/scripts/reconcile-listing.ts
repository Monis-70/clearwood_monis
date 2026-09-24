// Runs ONE listing-index reconcile pass and exits: price windows that opened or closed since the
// last pass, requested rebuilds, and rows MySQL says are stale (listingReconciler.service).
//
//   npm run listing:reconcile            -> prints the outcome as JSON
//
// For deployments that turn the in-process timer off (LISTING_RECONCILE_INTERVAL_SECONDS=0) and
// schedule this from cron or a PM2 cron app instead. It takes the same MySQL lease as the API
// workers, so running it while they tick - or twice at once - does the work once.
import { disconnectPrisma } from '../src/config/prisma';
import { closeDrivers } from '../src/container';
import { listingReconciler } from '../src/modules/storefront/listingReconciler.service';

async function main(): Promise<void> {
  const outcome = await listingReconciler.run();
  console.log(JSON.stringify(outcome));
}

main()
  .catch((error: unknown) => {
    console.error(`[listing] reconcile failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDrivers();
    await disconnectPrisma();
  });
