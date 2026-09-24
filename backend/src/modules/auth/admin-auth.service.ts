import { randomBytes } from 'node:crypto';

import type { Request, Response } from 'express';

import type { AdminUserStatus, AuthRealm, PrincipalType } from '@shared/enums';
import type { AdminMeDto, AdminUserDto, SessionDto } from '@shared/types/auth';

import { env, isProduction } from '../../config/env';
import { logger } from '../../config/logger';
import { mailer } from '../../container';
import {
  adminUserRepository,
  type AdminUserWithRoles,
} from '../../repositories/adminUser.repository';
import { loginAttemptRepository } from '../../repositories/loginAttempt.repository';
import { refreshTokenRepository } from '../../repositories/refreshToken.repository';
import { verificationTokenRepository } from '../../repositories/otpChallenge.repository';
import { AppError } from '../../utils/AppError';

import { auditService, clientIp } from './audit.service';
import { cookieService } from './cookie.service';
import { passwordService } from './password.service';
import { rbacService } from './rbac.service';
import { tokenService } from './token.service';

const REALM: AuthRealm = 'ADMIN';
const PRINCIPAL: PrincipalType = 'ADMIN_USER';
const RESET_TTL_MS = 60 * 60 * 1000;

export interface AuthRequestContext {
  ip: string | null;
  userAgent: string | null;
  deviceLabel?: string | null;
  requestId?: string | null;
}

export function contextFromRequest(req: Request): AuthRequestContext {
  return {
    ip: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
}

export function toAdminUserDto(user: AdminUserWithRoles): AdminUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    status: user.status as AdminUserStatus,
    avatarMediaId: user.avatarMediaId,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    roles: user.roles.map((assignment) => ({
      id: assignment.role.id,
      code: assignment.role.code,
      name: assignment.role.name,
    })),
  };
}

function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The refresh token is written to an httpOnly cookie and NEVER returned in the response body.
 * Browser clients therefore have no way to read, store or leak it.
 */
async function establishSession(
  res: Response,
  user: AdminUserWithRoles,
  context: AuthRequestContext,
): Promise<AdminMeDto & { accessToken: string; sessionId: string }> {
  const resolved = await rbacService.resolvePermissions(user);
  const refresh = await tokenService.issueRefreshToken(REALM, user.id, context);

  const accessToken = tokenService.signAccessToken(
    REALM,
    { id: user.id, permissionVersion: user.permissionVersion },
    { sessionId: refresh.familyId, permissions: resolved.permissions },
  );

  cookieService.setAuthCookies(res, REALM, {
    accessToken,
    refreshToken: refresh.token,
    csrfToken: cookieService.newCsrfToken(),
    accessTtlMs: cookieService.accessTtlMs(REALM),
    refreshExpiresAt: refresh.expiresAt,
  });

  return {
    user: toAdminUserDto(user),
    roles: resolved.roles,
    permissions: resolved.permissions,
    mustChangePassword: user.mustChangePassword,
    accessToken,
    sessionId: refresh.familyId,
  };
}

export const adminAuthService = {
  toAdminUserDto,

  async login(
    req: Request,
    res: Response,
    input: { email: string; password: string; deviceLabel?: string },
  ): Promise<AdminMeDto & { accessToken: string; expiresIn: number }> {
    const context = { ...contextFromRequest(req), deviceLabel: input.deviceLabel ?? null };
    const user = await adminUserRepository.findByEmail(input.email);

    const fail = async (reason: string): Promise<never> => {
      await loginAttemptRepository.record({
        realm: REALM,
        identifier: input.email,
        success: false,
        reason,
        ip: context.ip,
        userAgent: context.userAgent,
      });
      void auditService.record({
        action: 'LOGIN_FAILED',
        entity: 'AdminUser',
        entityId: user?.id ?? null,
        actorType: PRINCIPAL,
        actorEmail: input.email,
        realm: REALM,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
        meta: { reason },
      });
      // Identical message for every failure — never reveal whether the account exists.
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    };

    if (!user) {
      await passwordService.verifyDummy(input.password);
      return fail('NO_SUCH_ACCOUNT');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await passwordService.verifyDummy(input.password);
      throw new AppError(401, 'ACCOUNT_LOCKED', 'Too many attempts — this account is locked', {
        lockedUntil: user.lockedUntil.toISOString(),
      });
    }

    // ACTIVE only. INVITED has no usable password until the invite is accepted.
    if (user.status !== 'ACTIVE') {
      await passwordService.verifyDummy(input.password);
      return fail(user.status === 'INVITED' ? 'ACCOUNT_INVITED' : 'ACCOUNT_DISABLED');
    }

    if (!(await passwordService.verify(user.passwordHash, input.password))) {
      const attempts = user.failedLoginCount + 1;
      const locked =
        attempts >= env.LOGIN_MAX_ATTEMPTS
          ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000)
          : null;
      await adminUserRepository.registerFailedLogin(user.id, locked);
      return fail(locked ? 'LOCKED_OUT' : 'BAD_PASSWORD');
    }

    /*
     * The development placeholder is published in this repository, so it may open a development
     * database and never a production one - including an account that was seeded with it before
     * production refused to boot on it. The caller sees the ordinary failure; the operator sees why.
     */
    if (isProduction && passwordService.isPublishedPlaceholder(input.password)) {
      logger.warn(
        { adminUserId: user.id },
        'sign-in refused: this account still uses the published placeholder password — reset it with `npm run admin:reset-password`',
      );
      return fail('PUBLISHED_PASSWORD');
    }

    if (passwordService.needsRehash(user.passwordHash)) {
      await adminUserRepository.update(user.id, {
        passwordHash: await passwordService.hash(input.password),
      });
    }

    const fresh = (await adminUserRepository.findById(user.id))!;
    await adminUserRepository.registerSuccessfulLogin(user.id, context.ip);
    await loginAttemptRepository.record({
      realm: REALM,
      identifier: input.email,
      success: true,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const session = await establishSession(res, fresh, context);

    void auditService.record({
      action: 'LOGIN',
      entity: 'AdminUser',
      entityId: user.id,
      actorType: PRINCIPAL,
      actorId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      realm: REALM,
      requestId: context.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { sessionId: session.sessionId },
    });

    return {
      user: session.user,
      roles: session.roles,
      permissions: session.permissions,
      mustChangePassword: session.mustChangePassword,
      accessToken: session.accessToken,
      expiresIn: tokenService.accessTokenTtlSeconds(REALM),
    };
  },

  /**
   * Browsers always present the refresh token through the httpOnly cookie. The body field is a
   * development/testing affordance for REST Client and the test suite and is refused in production.
   */
  async refresh(
    req: Request,
    res: Response,
    bodyToken?: string,
  ): Promise<AdminMeDto & { accessToken: string; expiresIn: number }> {
    const cookieToken = cookieService.readRefreshToken(req, REALM);

    if (!cookieToken && bodyToken && isProduction) {
      throw new AppError(
        400,
        'REFRESH_TOKEN_IN_BODY_NOT_ALLOWED',
        'Refresh tokens must be presented through the httpOnly cookie',
      );
    }

    const presented = cookieToken ?? bodyToken;
    if (!presented) throw new AppError(401, 'NOT_AUTHENTICATED', 'No refresh token supplied');

    const context = contextFromRequest(req);

    let rotated;
    try {
      rotated = await tokenService.rotateRefreshToken(REALM, presented, context);
    } catch (error) {
      if (error instanceof AppError && error.code === 'TOKEN_REUSE') {
        const family = (error.details as { familyId?: string } | null)?.familyId ?? null;
        void auditService.record({
          action: 'TOKEN_REUSE_DETECTED',
          entity: 'RefreshToken',
          entityId: family,
          actorType: PRINCIPAL,
          realm: REALM,
          severity: 'CRITICAL',
          requestId: context.requestId,
          ip: context.ip,
          userAgent: context.userAgent,
        });
        cookieService.clearAuthCookies(res, REALM);
      }
      throw error;
    }

    const user = await adminUserRepository.findById(rotated.principalId);
    // ACTIVE only: a SUSPENDED or DISABLED admin must not be able to mint fresh access tokens.
    if (!user || user.status !== 'ACTIVE') {
      await tokenService.revokeFamily(rotated.issued.familyId, 'ACCOUNT_DISABLED');
      cookieService.clearAuthCookies(res, REALM);
      throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is not active');
    }

    const resolved = await rbacService.resolvePermissions(user);
    const accessToken = tokenService.signAccessToken(
      REALM,
      { id: user.id, permissionVersion: user.permissionVersion },
      { sessionId: rotated.issued.familyId, permissions: resolved.permissions },
    );

    cookieService.setAuthCookies(res, REALM, {
      accessToken,
      refreshToken: rotated.issued.token,
      csrfToken: cookieService.readCsrfCookie(req, REALM) ?? cookieService.newCsrfToken(),
      accessTtlMs: cookieService.accessTtlMs(REALM),
      refreshExpiresAt: rotated.issued.expiresAt,
    });

    return {
      user: toAdminUserDto(user),
      roles: resolved.roles,
      permissions: resolved.permissions,
      mustChangePassword: user.mustChangePassword,
      accessToken,
      expiresIn: tokenService.accessTokenTtlSeconds(REALM),
    };
  },

  async logout(req: Request, res: Response): Promise<void> {
    const presented = cookieService.readRefreshToken(req, REALM);

    if (presented) {
      const row = await tokenService.resolveFamily(REALM, presented);
      if (row) await tokenService.revokeFamily(row.familyId, 'LOGOUT');
    } else if (req.auth?.sessionId) {
      await tokenService.revokeFamily(req.auth.sessionId, 'LOGOUT');
    }

    cookieService.clearAuthCookies(res, REALM);

    if (req.auth) {
      void auditService.recordFromRequest(req, {
        action: 'LOGOUT',
        entity: 'AdminUser',
        entityId: req.auth.principalId,
      });
    }
  },

  async logoutAll(req: Request, res: Response): Promise<number> {
    const auth = req.auth!;
    const revoked = await tokenService.revokeAllForPrincipal(
      PRINCIPAL,
      auth.principalId,
      'LOGOUT_ALL',
    );
    cookieService.clearAuthCookies(res, REALM);

    void auditService.recordFromRequest(req, {
      action: 'SESSION_REVOKED',
      entity: 'AdminUser',
      entityId: auth.principalId,
      meta: { revoked, scope: 'ALL' },
    });

    return revoked;
  },

  async me(adminUserId: string): Promise<AdminMeDto> {
    const user = await adminUserRepository.findById(adminUserId);
    if (!user) throw AppError.notFound('Account not found');

    const resolved = await rbacService.resolvePermissions(user);
    return {
      user: toAdminUserDto(user),
      roles: resolved.roles,
      permissions: resolved.permissions,
      mustChangePassword: user.mustChangePassword,
    };
  },

  async changePassword(
    req: Request,
    res: Response,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const auth = req.auth!;
    const user = await adminUserRepository.findById(auth.principalId);
    if (!user) throw AppError.notFound('Account not found');

    if (!(await passwordService.verify(user.passwordHash, input.currentPassword))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Your current password is incorrect');
    }

    // Clearing mustChangePassword while keeping the same secret would make the flag cosmetic.
    if (input.newPassword === input.currentPassword) {
      throw AppError.validation('Password must be different from your current password', {
        field: 'newPassword',
      });
    }

    passwordService.assertPolicy(input.newPassword, { email: user.email, phone: user.phone });

    await adminUserRepository.update(user.id, {
      passwordHash: await passwordService.hash(input.newPassword),
      passwordChangedAt: new Date(),
      mustChangePassword: false,
    });

    // Every other device is signed out; the current session keeps working.
    await tokenService.revokeAllForPrincipal(
      PRINCIPAL,
      user.id,
      'PASSWORD_CHANGED',
      auth.sessionId,
    );

    void auditService.recordFromRequest(req, {
      action: 'PASSWORD_CHANGE',
      entity: 'AdminUser',
      entityId: user.id,
    });

    res.locals.passwordChanged = true;
  },

  /** Always resolves the same way so the endpoint cannot be used to enumerate accounts. */
  async forgotPassword(req: Request, email: string): Promise<void> {
    const user = await adminUserRepository.findByEmail(email);
    const context = contextFromRequest(req);

    if (!user || user.status === 'DISABLED') {
      logger.debug({ email }, 'password reset requested for an unknown admin account');
      return;
    }

    await verificationTokenRepository.invalidateOutstanding(PRINCIPAL, user.id, 'PASSWORD_RESET');

    const token = newOpaqueToken();
    await verificationTokenRepository.create({
      purpose: 'PASSWORD_RESET',
      principalType: PRINCIPAL,
      principalId: user.id,
      tokenHash: tokenService.hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });

    await mailer.send({
      to: user.email,
      subject: 'Reset your ClearWood admin password',
      text: [
        `Hello ${user.name},`,
        '',
        'Use this token to set a new password. It expires in one hour.',
        '',
        token,
        '',
        'If you did not ask for this, you can ignore this email.',
      ].join('\n'),
    });

    void auditService.record({
      action: 'PASSWORD_RESET',
      entity: 'AdminUser',
      entityId: user.id,
      actorType: PRINCIPAL,
      actorId: user.id,
      actorEmail: user.email,
      realm: REALM,
      requestId: context.requestId,
      ip: context.ip,
      meta: { stage: 'REQUESTED' },
    });
  },

  /**
   * Completes both a password reset and an invite: `adminUserService.create` issues ADMIN_INVITE
   * tokens and tells the invitee to use them here. An invite is only good while the account is
   * still INVITED, so an old invite cannot be replayed as a reset later.
   */
  async resetPassword(req: Request, input: { token: string; newPassword: string }): Promise<void> {
    const record = await verificationTokenRepository.findByHash(
      tokenService.hashToken(input.token),
    );

    if (
      !record ||
      (record.purpose !== 'PASSWORD_RESET' && record.purpose !== 'ADMIN_INVITE') ||
      record.principalType !== PRINCIPAL ||
      record.consumedAt ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired');
    }

    const user = await adminUserRepository.findById(record.principalId);
    if (!user || (record.purpose === 'ADMIN_INVITE' && user.status !== 'INVITED')) {
      throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset link is no longer valid');
    }

    passwordService.assertPolicy(input.newPassword, { email: user.email, phone: user.phone });

    await adminUserRepository.update(user.id, {
      passwordHash: await passwordService.hash(input.newPassword),
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
      ...(user.status === 'INVITED' ? { status: 'ACTIVE' } : {}),
    });

    await verificationTokenRepository.consume(record.id);
    await tokenService.revokeAllForPrincipal(PRINCIPAL, user.id, 'PASSWORD_RESET');

    void auditService.recordFromRequest(req, {
      action: 'PASSWORD_RESET',
      entity: 'AdminUser',
      entityId: user.id,
      actorType: PRINCIPAL,
      actorId: user.id,
      actorEmail: user.email,
      realm: REALM,
      meta: { stage: 'COMPLETED', purpose: record.purpose },
    });
  },

  async listSessions(
    adminUserId: string,
    currentSessionId: string,
    includeExpired: boolean,
  ): Promise<SessionDto[]> {
    const families = await refreshTokenRepository.listFamilies(
      PRINCIPAL,
      adminUserId,
      includeExpired,
    );

    return families.map((row) => ({
      id: row.familyId,
      familyId: row.familyId,
      deviceLabel: row.deviceLabel,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      lastUsedAt: row.usedAt?.toISOString() ?? null,
      isCurrent: row.familyId === currentSessionId,
    }));
  },

  async revokeSession(req: Request, familyId: string): Promise<void> {
    const auth = req.auth!;
    const root = await refreshTokenRepository.findFamilyRoot(familyId);

    if (!root || root.principalId !== auth.principalId || root.principalType !== PRINCIPAL) {
      throw AppError.notFound('Session not found', { familyId });
    }

    await tokenService.revokeFamily(familyId, 'REVOKED_BY_USER');

    void auditService.recordFromRequest(req, {
      action: 'SESSION_REVOKED',
      entity: 'RefreshToken',
      entityId: familyId,
      meta: { scope: 'ONE' },
    });
  },
};
