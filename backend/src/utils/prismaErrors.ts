import { Prisma } from '@prisma/client';

/** True when `error` is a unique violation on an index whose name contains `indexFragment`. */
export function isUniqueViolation(error: unknown, indexFragment: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  const names = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return names.includes(indexFragment);
}
