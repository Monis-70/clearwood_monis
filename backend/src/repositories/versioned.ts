import { AppError } from '../utils/AppError';

/**
 * Optimistic locking (Prompt 5).
 *
 * The version is part of the WHERE clause, not a read-then-write check, so two concurrent PATCHes
 * can never both succeed: the second one matches zero rows and is reported as 409 STALE_RESOURCE
 * with the version it should reload.
 */

interface VersionedDelegate {
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  findUnique(args: { where: { id: string } }): Promise<{ version: number } | null>;
}

export function asVersioned(delegate: unknown): VersionedDelegate {
  return delegate as VersionedDelegate;
}

export async function updateVersioned(
  delegate: unknown,
  entity: string,
  id: string,
  expectedVersion: number,
  data: Record<string, unknown>,
): Promise<void> {
  const model = asVersioned(delegate);

  const { count } = await model.updateMany({
    where: { id, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });

  if (count > 0) return;

  const current = await model.findUnique({ where: { id } });
  if (!current) throw AppError.notFound(`${entity} not found`, { id });

  throw new AppError(
    409,
    'STALE_RESOURCE',
    `This ${entity.toLowerCase()} was changed by someone else — reload and try again`,
    { entity, id, yourVersion: expectedVersion, currentVersion: current.version },
  );
}
