import { activeDrivers, isProduction } from '../config/env';
import { pingDatabase } from '../config/prisma';
import { cache } from '../container';

export interface HealthReport {
  status: 'ok';
  uptime: number;
  timestamp: string;
}

export interface DependencyStatus {
  status: 'up' | 'down';
  driver: string;
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'degraded' | 'unavailable';
  timestamp: string;
  dependencies: {
    database: DependencyStatus;
    cache: DependencyStatus;
  };
}

/** Never leak internal messages to the public in production (R10). */
function describe(error: unknown): string {
  if (isProduction) return 'unavailable';
  return error instanceof Error ? error.message : String(error);
}

async function probe(driver: string, check: () => Promise<unknown>): Promise<DependencyStatus> {
  const startedAt = Date.now();
  try {
    await check();
    return { status: 'up', driver, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { status: 'down', driver, latencyMs: Date.now() - startedAt, error: describe(error) };
  }
}

export const healthService = {
  /** Liveness: must not touch any dependency. */
  getHealth(): HealthReport {
    return {
      status: 'ok',
      uptime: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
    };
  },

  /**
   * Readiness: the database is required; the cache is not. Without the cache every read falls back
   * to MySQL, so the process still serves (`degraded`) and must stay in rotation.
   */
  async getReadiness(): Promise<ReadinessReport> {
    const [database, cacheStatus] = await Promise.all([
      probe(activeDrivers.db, pingDatabase),
      probe(activeDrivers.cache, async () => {
        const alive = await cache.ping();
        if (!alive) throw new Error('cache ping returned false');
      }),
    ]);

    const status =
      database.status === 'down'
        ? 'unavailable'
        : cacheStatus.status === 'down'
          ? 'degraded'
          : 'ready';

    return {
      status,
      timestamp: new Date().toISOString(),
      dependencies: { database, cache: cacheStatus },
    };
  },
};
