import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { DEV_ADMIN_PASSWORD } from '../src/config/env';
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

  it('refuses the published development placeholder as a chosen password', () => {
    expect(passwordService.isPublishedPlaceholder(DEV_ADMIN_PASSWORD)).toBe(true);
    expect(passwordService.isPublishedPlaceholder('Rosewood-Teak-42')).toBe(false);
    expect(() => passwordService.assertPolicy(DEV_ADMIN_PASSWORD)).toThrow(/placeholder/i);
    expect(() => passwordService.assertPolicy(DEV_ADMIN_PASSWORD.toUpperCase())).toThrow(
      /placeholder/i,
    );
  });
});

describe('tokenService — the algorithm and the claim shape are pinned', () => {
  const config = tokenService.config('ADMIN');
  const claims = { realm: 'ADMIN', typ: 'access', sid: 'family-pinned', ver: 1 };
  const options = {
    subject: 'admin-1',
    audience: config.audience,
    issuer: config.issuer,
    expiresIn: '5m',
  } as const;

  const expectInvalid = (token: string) =>
    expect(() => tokenService.verifyAccessToken('ADMIN', token)).toThrowError(
      expect.objectContaining({ code: 'TOKEN_INVALID', statusCode: 401 }),
    );

  it('signs with HS256 and accepts its own token', () => {
    const token = tokenService.signAccessToken(
      'ADMIN',
      { id: 'admin-1', permissionVersion: 1 },
      { sessionId: 'family-pinned', permissions: [] },
    );
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));

    expect(header.alg).toBe('HS256');
    expect(tokenService.verifyAccessToken('ADMIN', token).sid).toBe('family-pinned');

    // G1: the same claims signed the same way verify, so each refusal below is about one change.
    const control = jwt.sign(claims, config.accessSecret, { ...options, algorithm: 'HS256' });
    expect(tokenService.verifyAccessToken('ADMIN', control).sub).toBe('admin-1');
  });

  it('refuses another HMAC algorithm, even signed with the right secret', () => {
    expectInvalid(jwt.sign(claims, config.accessSecret, { ...options, algorithm: 'HS512' }));
    expectInvalid(jwt.sign(claims, config.accessSecret, { ...options, algorithm: 'HS384' }));
  });

  it('refuses an unsigned token', () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      ...claims,
      sub: 'admin-1',
      aud: config.audience,
      iss: config.issuer,
      iat: now,
      exp: now + 300,
    };

    expectInvalid(`${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`);
  });

  it('refuses the wrong issuer or audience', () => {
    expectInvalid(
      jwt.sign(claims, config.accessSecret, {
        ...options,
        algorithm: 'HS256',
        issuer: 'elsewhere',
      }),
    );
    expectInvalid(
      jwt.sign(claims, config.accessSecret, {
        ...options,
        algorithm: 'HS256',
        audience: 'clearwood-web',
      }),
    );
  });

  it('refuses a correctly signed token whose claims have the wrong shape', () => {
    const withoutSession: Record<string, unknown> = { ...claims };
    delete withoutSession.sid;
    const sign = (payload: object) =>
      jwt.sign(payload, config.accessSecret, { ...options, algorithm: 'HS256' });

    expectInvalid(sign(withoutSession));
    expectInvalid(sign({ ...claims, ver: '1' }));
    expectInvalid(sign({ ...claims, typ: 'refresh' }));
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

  it('never forks a session when the same token is rotated concurrently', async () => {
    const first = await tokenService.issueRefreshToken('ADMIN', 'admin-race-1');

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => tokenService.rotateRefreshToken('ADMIN', first.token)),
    );

    const won = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    // At most one rotation can win the claim; every other caller is treated as a replay.
    expect(won.length).toBeLessThanOrEqual(1);
    expect(refused.length).toBeGreaterThanOrEqual(results.length - 1);
    for (const result of refused) {
      expect(result.reason).toMatchObject({ code: 'TOKEN_REUSE', statusCode: 401 });
    }

    // Nothing in the family is usable afterwards - the winner's fresh token included.
    expect(
      await prisma.refreshToken.count({ where: { familyId: first.familyId, revokedAt: null } }),
    ).toBe(0);
    // One original and at most one child: a lost claim never issues a token.
    expect(
      await prisma.refreshToken.count({ where: { familyId: first.familyId } }),
    ).toBeLessThanOrEqual(2);
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
