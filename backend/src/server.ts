import type { Server } from 'node:http';

import { createApp } from './app';
import { activeDrivers, env } from './config/env';
import { logger } from './config/logger';
import { disconnectPrisma } from './config/prisma';
import { closeDrivers } from './container';

const app = createApp();

const server: Server = app.listen(env.API_PORT, () => {
  logger.info(
    {
      port: env.API_PORT,
      prefix: env.API_PREFIX,
      drivers: activeDrivers,
      docs: `http://localhost:${env.API_PORT}/docs`,
    },
    `${env.APP_NAME} API listening on http://localhost:${env.API_PORT}`,
  );
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.fatal(
      { port: env.API_PORT },
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
