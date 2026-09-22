import type { Prisma, SlugRedirect } from '@prisma/client';

import type { SlugEntityType } from '@shared/enums';
import type { SlugRedirectDto } from '@shared/types/catalogAdmin';

import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/AppError';

/**
 * Slug history. Renaming a product or category must never break an existing link, so every change
 * leaves a redirect row behind (Prompt 7 serves the 301s).
 *
 * Chains are flattened on write: if `old-name -> new-name` exists and `new-name` is renamed again,
 * the first row is re-pointed at the final target instead of chaining, so a lookup is one hop and
 * a rename cycle (A -> B -> A) can never produce an infinite redirect.
 */

type Client = Prisma.TransactionClient | typeof prisma;

function toDto(row: SlugRedirect): SlugRedirectDto {
  return {
    id: row.id,
    entityType: row.entityType as SlugEntityType,
    fromSlug: row.fromSlug,
    toSlug: row.toSlug,
    entityId: row.entityId,
    statusCode: row.statusCode,
    hitCount: row.hitCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export const slugRedirectService = {
  toDto,

  /**
   * Records `fromSlug -> toSlug` and repoints every redirect that used to end at `fromSlug`.
   * A no-op when the slug did not actually change.
   */
  async recordSlugChange(
    entityType: SlugEntityType,
    entityId: string,
    fromSlug: string,
    toSlug: string,
    client: Client = prisma,
  ): Promise<void> {
    if (!fromSlug || fromSlug === toSlug) return;

    // The new slug must not itself be a live redirect source, or the entity would redirect away
    // from itself.
    await client.slugRedirect.deleteMany({ where: { entityType, fromSlug: toSlug } });

    await client.slugRedirect.upsert({
      where: { entityType_fromSlug: { entityType, fromSlug } },
      update: { toSlug, entityId, hitCount: 0 },
      create: { entityType, fromSlug, toSlug, entityId },
    });

    // Flatten: anything that pointed at the old slug now points at the new one.
    await client.slugRedirect.updateMany({
      where: { entityType, toSlug: fromSlug },
      data: { toSlug },
    });
  },

  /** Resolves a stale slug to its current target, counting the hit. Returns null when unknown. */
  async resolve(entityType: SlugEntityType, fromSlug: string): Promise<SlugRedirectDto | null> {
    const row = await prisma.slugRedirect.findUnique({
      where: { entityType_fromSlug: { entityType, fromSlug } },
    });
    if (!row) return null;

    await prisma.slugRedirect.update({
      where: { id: row.id },
      data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
    });

    return toDto(row);
  },

  async listFor(entityType: SlugEntityType, entityId: string): Promise<SlugRedirectDto[]> {
    const rows = await prisma.slugRedirect.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  },

  /** A new slug may not collide with a redirect belonging to a different entity. */
  async assertSlugFree(
    entityType: SlugEntityType,
    slug: string,
    entityId: string | null,
  ): Promise<void> {
    const clash = await prisma.slugRedirect.findUnique({
      where: { entityType_fromSlug: { entityType, fromSlug: slug } },
    });

    if (clash && clash.entityId !== entityId) {
      throw new AppError(
        409,
        'SLUG_REDIRECT_CONFLICT',
        `"${slug}" already redirects to "${clash.toSlug}"`,
        { entityType, slug, redirectsTo: clash.toSlug },
      );
    }
  },
};
