import type { Prisma, RefreshToken } from '@prisma/client';

import type { PrincipalType } from '@shared/enums';

import { prisma } from '../config/prisma';

/** Shared by both realms — the discriminator is `principalType` (see modules/auth/realm.config). */
export const refreshTokenRepository = {
  findByHash(tokenHash: string): Promise<RefreshToken | null> {
    return prisma.refreshToken.findUnique({ where: { tokenHash } });
  },

  findById(id: string): Promise<RefreshToken | null> {
    return prisma.refreshToken.findUnique({ where: { id } });
  },

  create(data: Prisma.RefreshTokenUncheckedCreateInput): Promise<RefreshToken> {
    return prisma.refreshToken.create({ data });
  },

  /**
   * Marks the token used only if nothing else has: the predicate is on the row's OWN columns, so
   * a zero count unambiguously means another request rotated or revoked it first. Exactly one
   * caller can ever win a given token, which is what stops two concurrent refreshes forking one
   * session into two live ones.
   */
  async claim(id: string): Promise<boolean> {
    const result = await prisma.refreshToken.updateMany({
      where: { id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    return result.count === 1;
  },

  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const result = await prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  },

  async revokeAllForPrincipal(
    principalType: PrincipalType,
    principalId: string,
    reason: string,
    exceptFamilyId?: string,
  ): Promise<number> {
    const result = await prisma.refreshToken.updateMany({
      where: {
        principalType,
        principalId,
        revokedAt: null,
        ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  },

  /** One row per family: the newest token, which is what the session list shows. */
  async listFamilies(
    principalType: PrincipalType,
    principalId: string,
    includeExpired: boolean,
  ): Promise<RefreshToken[]> {
    const rows = await prisma.refreshToken.findMany({
      where: {
        principalType,
        principalId,
        revokedAt: null,
        ...(includeExpired ? {} : { expiresAt: { gt: new Date() } }),
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.familyId)) return false;
      seen.add(row.familyId);
      return true;
    });
  },

  findFamilyRoot(familyId: string): Promise<RefreshToken | null> {
    return prisma.refreshToken.findFirst({
      where: { familyId },
      orderBy: [{ createdAt: 'asc' }],
    });
  },

  async deleteExpired(before = new Date()): Promise<number> {
    const result = await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: before } } });
    return result.count;
  },

  count(): Promise<number> {
    return prisma.refreshToken.count();
  },
};
