import type { Server } from 'node:http';

import { createApp } from './app';
import { activeDrivers, env, isProduction } from './config/env';
import { logger } from './config/logger';
import { disconnectPrisma } from './config/prisma';
import { closeDrivers } from './container';
import { listingReconciler } from './modules/storefront/listingReconciler.service';

const app = createApp();

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const displayHost = env.HOST.includes(':') ? `[${env.HOST}]` : env.HOST;

// The host is passed explicitly: without it Node listens on every interface, whatever HOST says.
const server: Server = app.listen(env.API_PORT, env.HOST, () => {
  logger.info(
    {
      host: env.HOST,
      port: env.API_PORT,
      prefix: env.API_PREFIX,
      drivers: activeDrivers,
      docs: `http://${displayHost}:${env.API_PORT}/docs`,
    },
    `${env.APP_NAME} API listening on http://${displayHost}:${env.API_PORT}`,
  );

  if (isProduction && !LOOPBACK.has(env.HOST)) {
    logger.warn(
      { host: env.HOST },
      'the API is bound to a non-loopback address — make sure a TLS reverse proxy is the only thing that can reach it',
    );
  }
});

/*
 * Every worker offers to reconcile the listing index on this interval; the MySQL lease lets one of
 * them do it (listingReconciler.service). Price windows open and close with no write to react to,
 * so something has to look at the clock.
 */
const reconcileTimer =
  env.LISTING_RECONCILE_INTERVAL_SECONDS > 0
    ? setInterval(() => {
        listingReconciler
          .run()
          .catch((error: unknown) => logger.warn({ err: error }, 'listing reconcile failed'));
      }, env.LISTING_RECONCILE_INTERVAL_SECONDS * 1_000)
    : null;
reconcileTimer?.unref();

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.fatal(
      { host: env.HOST, port: env.API_PORT },
      `Port ${env.API_PORT} is already in use — it is reserved for the ClearWood API.`,
    );
  } else {
    logger.fatal({ err: error }, 'server failed to start');
  }
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    if (reconcileTimer) clearInterval(reconcileTimer);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await listingReconciler.idle();
    await closeDrivers();
    await disconnectPrisma();
    logger.info('shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    exitCode = 1;
  }

  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});

export { app, server };
