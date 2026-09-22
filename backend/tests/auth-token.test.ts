import { describe, expect, it } from 'vitest';

import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';
import { tokenService } from '../src/modules/auth/token.service';
import { AppError } from '../src/utils/AppError';

describe('passwordService', () => {
  it('hashes with argon2id and verifies the original', async () => {
    const hash = await passwordService.hash('Correct Horse Battery 9');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await passwordService.verify(hash, 'Correct Horse Battery 9')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await passwordService.hash('Correct Horse Battery 9');
    expect(await passwordService.verify(hash, 'correct horse battery 9')).toBe(false);
  });

  it('flags a hash produced with weaker parameters', async () => {
    const current = await passwordService.hash('Correct Horse Battery 9');
    expect(passwordService.needsRehash(current)).toBe(false);
    expect(passwordService.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('spends the same effort when no account matched', async () => {
    expect(await passwordService.verifyDummy('anything at all')).toBe(false);
  });

  it('enforces the strength policy', () => {
    expect(() => passwordService.assertPolicy('short')).toThrow(AppError);
    expect(() => passwordService.assertPolicy('password123')).toThrow(/too common/i);
    expect(() => passwordService.assertPolicy('aaaaaaaaaaaa')).toThrow(/repeated/i);
    expect(() =>
      passwordService.assertPolicy('owner@clearwood.local', { email: 'owner@clearwood.local' }),
    ).toThrow(/email/i);
    expect(() => passwordService.assertPolicy('Rosewood-Teak-42')).not.toThrow();
  });
});

describe('tokenService — realm isolation', () => {
  it('signs and verifies an access token for its own realm', () => {
    const token = tokenService.signAccessToken(
      'ADMIN',
      { id: 'admin-1', permissionVersion: 3 },
      { sessionId: 'family-1', permissions: ['catalog.product.read'] },
    );

    const claims = tokenService.verifyAccessToken('ADMIN', token);
    expect(claims.sub).toBe('admin-1');
    expect(claims.realm).toBe('ADMIN');
    expect(claims.sid).toBe('family-1');
    expect(claims.ver).toBe(3);
    expect(claims.aud).toBe('clearwood-admin');
  });

  it('refuses an ADMIN token in the CUSTOMER realm', () => {
    const token = tokenService.signAccessToken(
      'ADMIN',
      { id: 'admin-1', permissionVersion: 1 },
      { sessionId: 'family-1', permissions: [] },
    );

    expect(() => tokenService.verifyAccessToken('CUSTOMER', token)).toThrowError(
      expect.objectContaining({ code: 'TOKEN_INVALID' }),
    );
  });

  it('refuses a CUSTOMER token in the ADMIN realm', () => {
    const token = tokenService.signAccessToken(
      'CUSTOMER',
      { id: 'customer-1' },
      { sessionId: 'family-2' },
    );

    expect(() => tokenService.verifyAccessToken('ADMIN', token)).toThrowError(
      expect.objectContaining({ code: 'TOKEN_INVALID' }),
    );
  });

  it('never puts permissions in a customer token', () => {
    const token = tokenService.signAccessToken(
      'CUSTOMER',
      { id: 'customer-1' },
      { sessionId: 'family-2', permissions: ['system.role.create'] },
    );

    expect(tokenService.verifyAccessToken('CUSTOMER', token).perms).toBeUndefined();
  });

  it('reports a tampered signature as TOKEN_INVALID', () => {
    const token = tokenService.signAccessToken(
      'ADMIN',
      { id: 'admin-1', permissionVersion: 1 },
      { sessionId: 'family-1', permissions: [] },
    );
    const [header, payload] = token.split('.');

    expect(() =>
      tokenService.verifyAccessToken('ADMIN', `${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAA`),
    ).toThrowError(expect.objectContaining({ code: 'TOKEN_INVALID' }));
  });

  it('reports an expired token as TOKEN_EXPIRED', async () => {
    const expired = tokenService.signAccessToken(
      'ADMIN',
      { id: 'admin-1', permissionVersion: 1 },
      { sessionId: 'family-1', permissions: [] },
    );

    // Re-sign with a TTL already in the past by shifting the clock forward past the 15m window.
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000;
    try {
      expect(() => tokenService.verifyAccessToken('ADMIN', expired)).toThrowError(
        expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
      );
    } finally {
      Date.now = realNow;
    }
  });
});

describe('tokenService — refresh rotation and reuse detection', () => {
  it('rotates within one family and invalidates the presented token', async () => {
    const first = await tokenService.issueRefreshToken('ADMIN', 'admin-rotation-1');
    const second = await tokenService.rotateRefreshToken('ADMIN', first.token);

    expect(second.issued.familyId).toBe(first.familyId);
    expect(second.issued.token).not.toBe(first.token);
    expect(second.principalId).toBe('admin-rotation-1');

    const third = await tokenService.rotateRefreshToken('ADMIN', second.issued.token);
    expect(third.issued.familyId).toBe(first.familyId);
  });

  it('revokes the whole family when a used token is replayed', async () => {
    const first = await tokenService.issueRefreshToken('ADMIN', 'admin-reuse-1');
    const second = await tokenService.rotateRefreshToken('ADMIN', first.token);

    await expect(tokenService.rotateRefreshToken('ADMIN', first.token)).rejects.toMatchObject({
      code: 'TOKEN_REUSE',
      statusCode: 401,
    });

    const family = await prisma.refreshToken.findMany({ where: { familyId: first.familyId } });
    expect(family.length).toBeGreaterThanOrEqual(2);
    expect(family.every((row) => row.revokedAt !== null)).toBe(true);

    // The token that was still valid a moment ago is dead too.
    await expect(
      tokenService.rotateRefreshToken('ADMIN', second.issued.token),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('keeps the realms apart in storage as well', async () => {
    const issued = await tokenService.issueRefreshToken('CUSTOMER', 'customer-realm-1');

    await expect(tokenService.rotateRefreshToken('ADMIN', issued.token)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('revokes every family for a principal on demand', async () => {
    await tokenService.issueRefreshToken('ADMIN', 'admin-revoke-all');
    await tokenService.issueRefreshToken('ADMIN', 'admin-revoke-all');

    const revoked = await tokenService.revokeAllForPrincipal(
      'ADMIN_USER',
      'admin-revoke-all',
      'TEST',
    );
    expect(revoked).toBe(2);
  });
});
