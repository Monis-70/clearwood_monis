import { createHash, randomBytes, randomUUID } from 'node:crypto';

import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';

import type { AuthRealm, PrincipalType } from '@shared/enums';

import { logger } from '../../config/logger';
import { refreshTokenRepository } from '../../repositories/refreshToken.repository';
import { AppError } from '../../utils/AppError';

import { realmConfig, type RealmConfig } from './realm.config';

/**
 * Access tokens are short-lived JWTs. Refresh tokens are 256-bit random strings that exist in the
 * database only as sha256 hashes — a database leak cannot be replayed as a session.
 */

export interface AccessTokenClaims extends JwtPayload {
  sub: string;
  realm: AuthRealm;
  typ: 'access';
  /** Refresh-token family id: the stable session identifier. */
  sid: string;
  /** Permission version — bumped on any role change so live tokens die immediately. */
  ver: number;
  perms?: string[];
}

export interface IssuedRefreshToken {
  /** The only time the plaintext exists. It goes straight into an httpOnly cookie. */
  token: string;
  familyId: string;
  expiresAt: Date;
  id: string;
}

export interface RefreshContext {
  ip?: string | null;
  userAgent?: string | null;
  deviceLabel?: string | null;
}

const REFRESH_TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) throw new Error(`invalid TTL "${ttl}" — use 15m, 24h, 30d …`);

  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * multiplier;
}

export const tokenService = {
  ttlToMs,
  hashToken,

  accessTokenTtlSeconds(realm: AuthRealm): number {
    return Math.floor(ttlToMs(realmConfig(realm).accessTtl) / 1000);
  },

  /**
   * Customer tokens deliberately carry no permission list — the storefront has no RBAC, and a
   * smaller token keeps the cookie well under the 4KB limit.
   */
  signAccessToken(
    realm: AuthRealm,
    principal: { id: string; permissionVersion?: number },
    options: { sessionId: string; permissions?: string[] },
  ): string {
    const config = realmConfig(realm);

    const payload: Record<string, unknown> = {
      realm,
      typ: 'access',
      sid: options.sessionId,
      ver: principal.permissionVersion ?? 1,
    };

    if (realm === 'ADMIN' && options.permissions) {
      payload.perms = options.permissions;
    }

    const signOptions: SignOptions = {
      subject: principal.id,
      audience: config.audience,
      issuer: config.issuer,
      expiresIn: config.accessTtl as SignOptions['expiresIn'],
      jwtid: randomUUID(),
    };

    return jwt.sign(payload, config.accessSecret, signOptions);
  },

  /** Throws TOKEN_EXPIRED / TOKEN_INVALID — never leaks why beyond those two codes. */
  verifyAccessToken(realm: AuthRealm, token: string): AccessTokenClaims {
    const config = realmConfig(realm);

    try {
      const claims = jwt.verify(token, config.accessSecret, {
        audience: config.audience,
        issuer: config.issuer,
      }) as AccessTokenClaims;

      if (claims.typ !== 'access' || claims.realm !== realm) {
        throw new AppError(401, 'TOKEN_INVALID', 'This token is not valid for this realm');
      }
      return claims;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof jwt.TokenExpiredError) {
        throw new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired');
      }
      throw new AppError(401, 'TOKEN_INVALID', 'Invalid authentication token');
    }
  },

  async issueRefreshToken(
    realm: AuthRealm,
    principalId: string,
    context: RefreshContext = {},
    familyId: string = randomUUID(),
    parentId: string | null = null,
  ): Promise<IssuedRefreshToken> {
    const config = realmConfig(realm);
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlToMs(config.refreshTtl));

    const row = await refreshTokenRepository.create({
      principalType: config.principalType,
      principalId,
      tokenHash: hashToken(token),
      familyId,
      parentId,
      expiresAt,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      deviceLabel: context.deviceLabel ?? null,
    });

    return { token, familyId, expiresAt, id: row.id };
  },

  /**
   * Rotation with reuse detection: the presented token is marked used and replaced by a sibling in
   * the same family. Presenting an already-used token means it leaked — the whole family dies.
   */
  async rotateRefreshToken(
    realm: AuthRealm,
    presentedToken: string,
    context: RefreshContext = {},
  ): Promise<{ issued: IssuedRefreshToken; principalId: string }> {
    const config = realmConfig(realm);
    const existing = await refreshTokenRepository.findByHash(hashToken(presentedToken));

    if (!existing || existing.principalType !== config.principalType) {
      throw new AppError(401, 'TOKEN_INVALID', 'Invalid refresh token');
    }

    if (existing.usedAt) {
      await refreshTokenRepository.revokeFamily(existing.familyId, 'TOKEN_REUSE_DETECTED');
      logger.warn(
        { familyId: existing.familyId, principalId: existing.principalId, realm },
        'refresh token reuse detected — session family revoked',
      );
      throw new AppError(401, 'TOKEN_REUSE', 'This session has been revoked for your safety', {
        familyId: existing.familyId,
      });
    }

    if (existing.revokedAt) {
      throw new AppError(401, 'TOKEN_INVALID', 'This session has been revoked');
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired');
    }

    await refreshTokenRepository.markUsed(existing.id);

    const issued = await this.issueRefreshToken(
      realm,
      existing.principalId,
      {
        ip: context.ip ?? existing.ip,
        userAgent: context.userAgent ?? existing.userAgent,
        deviceLabel: context.deviceLabel ?? existing.deviceLabel,
      },
      existing.familyId,
      existing.id,
    );

    return { issued, principalId: existing.principalId };
  },

  async resolveFamily(realm: AuthRealm, presentedToken: string) {
    const config = realmConfig(realm);
    const row = await refreshTokenRepository.findByHash(hashToken(presentedToken));
    return row && row.principalType === config.principalType ? row : null;
  },

  revokeFamily(familyId: string, reason: string): Promise<number> {
    return refreshTokenRepository.revokeFamily(familyId, reason);
  },

  revokeAllForPrincipal(
    principalType: PrincipalType,
    principalId: string,
    reason: string,
    exceptFamilyId?: string,
  ): Promise<number> {
    return refreshTokenRepository.revokeAllForPrincipal(
      principalType,
      principalId,
      reason,
      exceptFamilyId,
    );
  },

  config(realm: AuthRealm): RealmConfig {
    return realmConfig(realm);
  },
};
