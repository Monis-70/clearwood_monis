import { prisma } from '../config/prisma';

/**
 * R1 - `MaintenanceTask`, the lease and watermark of a periodic job.
 *
 * Every transition is ONE conditional UPDATE, so MySQL decides who holds a lease: two processes
 * racing for it cannot both see "free", and a holder whose lease expired cannot write its
 * completion over the next holder's run. Times come from the caller (the application clock that
 * also stamps the rows the job reads).
 */

export interface MaintenanceTaskState {
  name: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  watermarkAt: Date | null;
  rebuildRequestedAt: Date | null;
  lastRebuiltAt: Date | null;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastError: string | null;
  runCount: number;
}

export const maintenanceTaskRepository = {
  async ensure(name: string): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO MaintenanceTask (id, name, updatedAt)
      VALUES (REPLACE(UUID(), '-', ''), ${name}, CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE name = name`;
  },

  read(name: string): Promise<MaintenanceTaskState | null> {
    return prisma.maintenanceTask.findUnique({
      where: { name },
      select: {
        name: true,
        leaseOwner: true,
        leaseExpiresAt: true,
        watermarkAt: true,
        rebuildRequestedAt: true,
        lastRebuiltAt: true,
        lastStartedAt: true,
        lastCompletedAt: true,
        lastError: true,
        runCount: true,
      },
    });
  },

  /** Takes the lease if nobody holds a live one. True means this caller now owns the run. */
  async tryAcquire(name: string, owner: string, now: Date, until: Date): Promise<boolean> {
    const taken = await prisma.$executeRaw`
      UPDATE MaintenanceTask
      SET leaseOwner = ${owner}, leaseExpiresAt = ${until}, lastStartedAt = ${now},
        runCount = runCount + 1, updatedAt = ${now}
      WHERE name = ${name} AND (leaseExpiresAt IS NULL OR leaseExpiresAt < ${now})`;
    return taken === 1;
  },

  /** Extends a lease its owner still holds; false means it was lost and the run must stop. */
  async renew(name: string, owner: string, now: Date, until: Date): Promise<boolean> {
    const renewed = await prisma.$executeRaw`
      UPDATE MaintenanceTask SET leaseExpiresAt = ${until}, updatedAt = ${now}
      WHERE name = ${name} AND leaseOwner = ${owner} AND leaseExpiresAt >= ${now}`;
    return renewed === 1;
  },

  /** Records a finished run and frees the lease - only if this owner still holds it. */
  async complete(
    name: string,
    owner: string,
    done: { watermarkAt: Date; rebuiltAt: Date | null; completedAt: Date },
  ): Promise<boolean> {
    const written = await prisma.$executeRaw`
      UPDATE MaintenanceTask
      SET watermarkAt = ${done.watermarkAt},
        lastRebuiltAt = COALESCE(${done.rebuiltAt}, lastRebuiltAt),
        lastCompletedAt = ${done.completedAt}, lastError = NULL,
        leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ${done.completedAt}
      WHERE name = ${name} AND leaseOwner = ${owner}`;
    return written === 1;
  },

  /** Frees the lease after a failure, leaving the watermark where it was so the work is retried. */
  async fail(name: string, owner: string, error: string, now: Date): Promise<void> {
    await prisma.$executeRaw`
      UPDATE MaintenanceTask
      SET lastError = ${error.slice(0, 1000)}, leaseOwner = NULL, leaseExpiresAt = NULL,
        updatedAt = ${now}
      WHERE name = ${name} AND leaseOwner = ${owner}`;
  },

  /** A durable "rebuild everything": only ever moves forward, so concurrent requests coalesce. */
  async requestRebuild(name: string, at: Date): Promise<void> {
    await prisma.$executeRaw`
      UPDATE MaintenanceTask
      SET rebuildRequestedAt = GREATEST(COALESCE(rebuildRequestedAt, ${at}), ${at}), updatedAt = ${at}
      WHERE name = ${name}`;
  },
};
