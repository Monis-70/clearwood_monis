import { randomBytes } from 'node:crypto';

import type { Customer } from '@prisma/client';
import type { Request, Response } from 'express';

import type { AuthRealm, CustomerStatus, OtpPurpose, PrincipalType } from '@shared/enums';
import type { CustomerDto, OtpRequestResponse } from '@shared/types/auth';

import { env, isProduction } from '../../config/env';
import { logger } from '../../config/logger';
import { mailer } from '../../container';
import { customerRepository } from '../../repositories/customer.repository';
import { loginAttemptRepository } from '../../repositories/loginAttempt.repository';
import { verificationTokenRepository } from '../../repositories/otpChallenge.repository';
import { AppError } from '../../utils/AppError';

import { auditService, clientIp } from './audit.service';
import { contextFromRequest, type AuthRequestContext } from './admin-auth.service';
import { cookieService } from './cookie.service';
import { otpService } from './otp.service';
import { passwordService } from './password.service';
import { tokenService } from './token.service';

const REALM: AuthRealm = 'CUSTOMER';
const PRINCIPAL: PrincipalType = 'CUSTOMER';
const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export function toCustomerDto(customer: Customer): CustomerDto {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    status: customer.status as CustomerStatus,
    emailVerified: customer.emailVerifiedAt !== null,
    phoneVerified: customer.phoneVerifiedAt !== null,
    marketingOptIn: customer.marketingOptIn,
    acceptsWhatsapp: customer.acceptsWhatsapp,
    avatarMediaId: customer.avatarMediaId,
    referralCode: customer.referralCode,
    createdAt: customer.createdAt.toISOString(),
  };
}

function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function newReferralCode(): string {
  return `CW${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Refresh token -> httpOnly cookie only. It is never part of a response body. */
async function establishSession(
  res: Response,
  customer: Customer,
  context: AuthRequestContext,
): Promise<{ accessToken: string; expiresIn: number }> {
  const refresh = await tokenService.issueRefreshToken(REALM, customer.id, context);

  const accessToken = tokenService.signAccessToken(
    REALM,
    { id: customer.id },
    { sessionId: refresh.familyId },
  );

  cookieService.setAuthCookies(res, REALM, {
    accessToken,
    refreshToken: refresh.token,
    csrfToken: cookieService.newCsrfToken(),
    accessTtlMs: cookieService.accessTtlMs(REALM),
    refreshExpiresAt: refresh.expiresAt,
  });

  return { accessToken, expiresIn: tokenService.accessTokenTtlSeconds(REALM) };
}

/**
 * Prompt 8 — the guest cart follows the shopper into their account.
 *
 * Deliberately best-effort: a merge problem must never turn a successful sign-in into a failure.
 * The dynamic import keeps the auth module free of a cart dependency at load time.
 */
async function adoptGuestCart(req: Request, res: Response, customerId: string): Promise<void> {
  try {
    const [{ cartIdentity, parseCartCookie }, { cartMergeService }] = await Promise.all([
      import('../cart/cartIdentity'),
      import('../cart/cartMerge.service'),
    ]);

    const sessionId = parseCartCookie(req.cookies?.[cartIdentity.cookieName] as string | undefined);
    if (!sessionId) return;

    await cartMergeService.mergeGuestIntoCustomer(sessionId, customerId);

    // The guest identity is spent either way — it must not linger and re-attach to the next visitor.
    cartIdentity.clear(res);
  } catch (error) {
    logger.warn({ err: error, customerId }, 'guest cart merge skipped');
  }
}

function assertUsable(customer: Customer): void {
  if (customer.status === 'BLOCKED') {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been blocked');
  }
  if (customer.lockedUntil && customer.lockedUntil.getTime() > Date.now()) {
    throw new AppError(401, 'ACCOUNT_LOCKED', 'Too many attempts — this account is locked');
  }
}

export const customerAuthService = {
  toCustomerDto,

  async register(
    req: Request,
    res: Response,
    input: {
      name: string;
      email?: string;
      phone?: string;
      password?: string;
      marketingOptIn: boolean;
      acceptsWhatsapp: boolean;
    },
  ): Promise<{ customer: CustomerDto; accessToken: string; expiresIn: number }> {
    if (!input.email && !input.phone) {
      throw AppError.validation('An email address or a phone number is required');
    }

    const existing = input.email
      ? await customerRepository.findByEmail(input.email)
      : await customerRepository.findByPhone(input.phone!);

    if (existing) {
      throw AppError.conflict('An account with those details already exists');
    }

    if (input.password) {
      passwordService.assertPolicy(input.password, { email: input.email, phone: input.phone });
    }

    const customer = await customerRepository.create({
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      passwordHash: input.password ? await passwordService.hash(input.password) : null,
      status: input.email && !input.password ? 'PENDING_VERIFICATION' : 'ACTIVE',
      marketingOptIn: input.marketingOptIn,
      acceptsWhatsapp: input.acceptsWhatsapp,
      referralCode: newReferralCode(),
    });

    const session = await establishSession(res, customer, contextFromRequest(req));
    await adoptGuestCart(req, res, customer.id);

    void auditService.record({
      action: 'CREATE',
      entity: 'Customer',
      entityId: customer.id,
      actorType: PRINCIPAL,
      actorId: customer.id,
      actorEmail: customer.email,
      realm: REALM,
      requestId: req.requestId,
      ip: clientIp(req),
    });

    return { customer: toCustomerDto(customer), ...session };
  },

  async login(
    req: Request,
    res: Response,
    input: { identifier: string; password: string; deviceLabel?: string },
  ): Promise<{ customer: CustomerDto; accessToken: string; expiresIn: number }> {
    const context = { ...contextFromRequest(req), deviceLabel: input.deviceLabel ?? null };
    const customer = await customerRepository.findByIdentifier(input.identifier);

    const fail = async (reason: string): Promise<never> => {
      await loginAttemptRepository.record({
        realm: REALM,
        identifier: input.identifier.toLowerCase(),
        success: false,
        reason,
        ip: context.ip,
        userAgent: context.userAgent,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Those details did not match an account');
    };

    if (!customer?.passwordHash) {
      await passwordService.verifyDummy(input.password);
      return fail(customer ? 'NO_PASSWORD_SET' : 'NO_SUCH_ACCOUNT');
    }

    assertUsable(customer);

    if (!(await passwordService.verify(customer.passwordHash, input.password))) {
      const attempts = customer.failedLoginCount + 1;
      const locked =
        attempts >= env.LOGIN_MAX_ATTEMPTS
          ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000)
          : null;
      await customerRepository.registerFailedLogin(customer.id, locked);
      return fail(locked ? 'LOCKED_OUT' : 'BAD_PASSWORD');
    }

    await customerRepository.registerSuccessfulLogin(customer.id);
    await loginAttemptRepository.record({
      realm: REALM,
      identifier: input.identifier.toLowerCase(),
      success: true,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const session = await establishSession(res, customer, context);
    await adoptGuestCart(req, res, customer.id);

    void auditService.record({
      action: 'LOGIN',
      entity: 'Customer',
      entityId: customer.id,
      actorType: PRINCIPAL,
      actorId: customer.id,
      actorEmail: customer.email,
      realm: REALM,
      requestId: req.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { customer: toCustomerDto(customer), ...session };
  },

  async requestOtp(
    req: Request,
    input: { email?: string; phone?: string; purpose: OtpPurpose },
  ): Promise<OtpRequestResponse> {
    const destination = (input.phone ?? input.email)!;
    const existing = await customerRepository.findByIdentifier(destination);

    if (existing) assertUsable(existing);

    const issued = await otpService.issue({
      destination,
      purpose: input.purpose,
      principalType: existing ? PRINCIPAL : null,
      principalId: existing?.id ?? null,
      ip: clientIp(req),
    });

    return issued;
  },

  /** One flow for login and signup: a verified destination with no account creates one. */
  async verifyOtp(
    req: Request,
    res: Response,
    input: {
      destination: string;
      code: string;
      purpose: OtpPurpose;
      name?: string;
      deviceLabel?: string;
    },
  ): Promise<{
    customer: CustomerDto;
    accessToken: string;
    expiresIn: number;
    isNewAccount: boolean;
  }> {
    await otpService.verify(input.destination, input.code, input.purpose);

    const destination = input.destination.trim().toLowerCase();
    const isEmail = destination.includes('@');
    let customer = await customerRepository.findByIdentifier(destination);
    let isNewAccount = false;

    if (!customer) {
      customer = await customerRepository.create({
        name: input.name ?? null,
        email: isEmail ? destination : null,
        phone: isEmail ? null : destination,
        status: 'ACTIVE',
        emailVerifiedAt: isEmail ? new Date() : null,
        phoneVerifiedAt: isEmail ? null : new Date(),
        referralCode: newReferralCode(),
      });
      isNewAccount = true;
    } else {
      assertUsable(customer);
      customer = await customerRepository.update(customer.id, {
        ...(isEmail ? { emailVerifiedAt: new Date() } : { phoneVerifiedAt: new Date() }),
        ...(customer.status === 'PENDING_VERIFICATION' ? { status: 'ACTIVE' } : {}),
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      });
    }

    const context = { ...contextFromRequest(req), deviceLabel: input.deviceLabel ?? null };
    const session = await establishSession(res, customer, context);
    await adoptGuestCart(req, res, customer.id);

    await loginAttemptRepository.record({
      realm: REALM,
      identifier: destination,
      success: true,
      reason: 'OTP',
      ip: context.ip,
      userAgent: context.userAgent,
    });

    void auditService.record({
      action: isNewAccount ? 'CREATE' : 'LOGIN',
      entity: 'Customer',
      entityId: customer.id,
      actorType: PRINCIPAL,
      actorId: customer.id,
      realm: REALM,
      requestId: req.requestId,
      ip: context.ip,
      meta: { via: 'OTP', purpose: input.purpose },
    });

    return { customer: toCustomerDto(customer), ...session, isNewAccount };
  },

  /** Cookie first; the body field exists only for REST Client / tests and is barred in production. */
  async refresh(
    req: Request,
    res: Response,
    bodyToken?: string,
  ): Promise<{ customer: CustomerDto; accessToken: string; expiresIn: number }> {
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

    let rotated;
    try {
      rotated = await tokenService.rotateRefreshToken(REALM, presented, contextFromRequest(req));
    } catch (error) {
      if (error instanceof AppError && error.code === 'TOKEN_REUSE') {
        void auditService.record({
          action: 'TOKEN_REUSE_DETECTED',
          entity: 'RefreshToken',
          entityId: (error.details as { familyId?: string } | null)?.familyId ?? null,
          actorType: PRINCIPAL,
          realm: REALM,
          severity: 'CRITICAL',
          requestId: req.requestId,
          ip: clientIp(req),
        });
        cookieService.clearAuthCookies(res, REALM);
      }
      throw error;
    }

    const customer = await customerRepository.findById(rotated.principalId);
    if (!customer || customer.status === 'BLOCKED') {
      await tokenService.revokeFamily(rotated.issued.familyId, 'ACCOUNT_DISABLED');
      cookieService.clearAuthCookies(res, REALM);
      throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is not active');
    }

    const accessToken = tokenService.signAccessToken(
      REALM,
      { id: customer.id },
      { sessionId: rotated.issued.familyId },
    );

    cookieService.setAuthCookies(res, REALM, {
      accessToken,
      refreshToken: rotated.issued.token,
      csrfToken: cookieService.readCsrfCookie(req, REALM) ?? cookieService.newCsrfToken(),
      accessTtlMs: cookieService.accessTtlMs(REALM),
      refreshExpiresAt: rotated.issued.expiresAt,
    });

    return {
      customer: toCustomerDto(customer),
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
        entity: 'Customer',
        entityId: req.auth.principalId,
      });
    }
  },

  async me(customerId: string): Promise<CustomerDto> {
    const customer = await customerRepository.findById(customerId);
    if (!customer) throw AppError.notFound('Account not found');
    return toCustomerDto(customer);
  },

  async updateProfile(
    req: Request,
    input: {
      name?: string;
      email?: string;
      phone?: string;
      marketingOptIn?: boolean;
      acceptsWhatsapp?: boolean;
    },
  ): Promise<CustomerDto> {
    const auth = req.auth!;
    const customer = await customerRepository.findById(auth.principalId);
    if (!customer) throw AppError.notFound('Account not found');

    if (input.email && input.email !== customer.email) {
      const clash = await customerRepository.findByEmail(input.email);
      if (clash) throw AppError.conflict('That email address is already in use');
    }
    if (input.phone && input.phone !== customer.phone) {
      const clash = await customerRepository.findByPhone(input.phone);
      if (clash) throw AppError.conflict('That phone number is already in use');
    }

    const updated = await customerRepository.update(customer.id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.email === undefined
        ? {}
        : {
            email: input.email,
            emailVerifiedAt: input.email === customer.email ? customer.emailVerifiedAt : null,
          }),
      ...(input.phone === undefined
        ? {}
        : {
            phone: input.phone,
            phoneVerifiedAt: input.phone === customer.phone ? customer.phoneVerifiedAt : null,
          }),
      ...(input.marketingOptIn === undefined ? {} : { marketingOptIn: input.marketingOptIn }),
      ...(input.acceptsWhatsapp === undefined ? {} : { acceptsWhatsapp: input.acceptsWhatsapp }),
    });

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Customer',
      entityId: customer.id,
      changes: auditService.diff(
        { name: customer.name, email: customer.email, phone: customer.phone },
        { name: updated.name, email: updated.email, phone: updated.phone },
      ),
    });

    return toCustomerDto(updated);
  },

  async changePassword(
    req: Request,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const auth = req.auth!;
    const customer = await customerRepository.findById(auth.principalId);
    if (!customer) throw AppError.notFound('Account not found');

    if (customer.passwordHash) {
      if (!(await passwordService.verify(customer.passwordHash, input.currentPassword))) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Your current password is incorrect');
      }
    }

    passwordService.assertPolicy(input.newPassword, {
      email: customer.email,
      phone: customer.phone,
    });

    await customerRepository.update(customer.id, {
      passwordHash: await passwordService.hash(input.newPassword),
    });
    await tokenService.revokeAllForPrincipal(
      PRINCIPAL,
      customer.id,
      'PASSWORD_CHANGED',
      auth.sessionId,
    );

    void auditService.recordFromRequest(req, {
      action: 'PASSWORD_CHANGE',
      entity: 'Customer',
      entityId: customer.id,
    });
  },

  async forgotPassword(email: string): Promise<void> {
    const customer = await customerRepository.findByEmail(email);
    if (!customer || customer.status === 'BLOCKED') return;

    await verificationTokenRepository.invalidateOutstanding(
      PRINCIPAL,
      customer.id,
      'PASSWORD_RESET',
    );

    const token = newOpaqueToken();
    await verificationTokenRepository.create({
      purpose: 'PASSWORD_RESET',
      principalType: PRINCIPAL,
      principalId: customer.id,
      tokenHash: tokenService.hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });

    await mailer.send({
      to: email,
      subject: 'Reset your ClearWood password',
      text: `Use this token to set a new password (valid for one hour):\n\n${token}`,
    });
  },

  async resetPassword(req: Request, input: { token: string; newPassword: string }): Promise<void> {
    const record = await verificationTokenRepository.findByHash(
      tokenService.hashToken(input.token),
    );

    if (
      !record ||
      record.purpose !== 'PASSWORD_RESET' ||
      record.principalType !== PRINCIPAL ||
      record.consumedAt ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired');
    }

    const customer = await customerRepository.findById(record.principalId);
    if (!customer)
      throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset link is no longer valid');

    passwordService.assertPolicy(input.newPassword, {
      email: customer.email,
      phone: customer.phone,
    });

    await customerRepository.update(customer.id, {
      passwordHash: await passwordService.hash(input.newPassword),
      failedLoginCount: 0,
      lockedUntil: null,
    });
    await verificationTokenRepository.consume(record.id);
    await tokenService.revokeAllForPrincipal(PRINCIPAL, customer.id, 'PASSWORD_RESET');

    void auditService.recordFromRequest(req, {
      action: 'PASSWORD_RESET',
      entity: 'Customer',
      entityId: customer.id,
      actorType: PRINCIPAL,
      actorId: customer.id,
      realm: REALM,
    });
  },

  async sendEmailVerification(req: Request): Promise<void> {
    const auth = req.auth!;
    const customer = await customerRepository.findById(auth.principalId);
    if (!customer?.email) throw AppError.validation('Add an email address to your profile first');
    if (customer.emailVerifiedAt) return;

    await verificationTokenRepository.invalidateOutstanding(PRINCIPAL, customer.id, 'EMAIL_VERIFY');

    const token = newOpaqueToken();
    await verificationTokenRepository.create({
      purpose: 'EMAIL_VERIFY',
      principalType: PRINCIPAL,
      principalId: customer.id,
      tokenHash: tokenService.hashToken(token),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    });

    await mailer.send({
      to: customer.email,
      subject: 'Confirm your ClearWood email address',
      text: `Use this token to confirm your address (valid for 24 hours):\n\n${token}`,
    });
  },

  async verifyEmail(token: string): Promise<CustomerDto> {
    const record = await verificationTokenRepository.findByHash(tokenService.hashToken(token));

    if (
      !record ||
      record.purpose !== 'EMAIL_VERIFY' ||
      record.principalType !== PRINCIPAL ||
      record.consumedAt ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new AppError(400, 'VERIFY_TOKEN_INVALID', 'This link is invalid or has expired');
    }

    const customer = await customerRepository.update(record.principalId, {
      emailVerifiedAt: new Date(),
      status: 'ACTIVE',
    });
    await verificationTokenRepository.consume(record.id);

    return toCustomerDto(customer);
  },
};
