import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AuthRealm, Permission } from '@shared/enums';

import { adminUserRepository } from '../repositories/adminUser.repository';
import { customerRepository } from '../repositories/customer.repository';
import { cookieService } from '../modules/auth/cookie.service';
import { rbacService } from '../modules/auth/rbac.service';
import { tokenService, type AccessTokenClaims } from '../modules/auth/token.service';
import { AppError } from '../utils/AppError';

import type { AuthContext } from '../types/express';

/**
 * One guard, two realms. The realm decides which secret, audience and cookie are accepted, so an
 * admin token presented to a storefront route fails signature/audience verification outright.
 */

function readToken(req: Request, realm: AuthRealm): string | null {
  const header = req.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  return cookieService.readAccessToken(req, realm);
}

async function loadAdminContext(claims: AccessTokenClaims): Promise<AuthContext> {
  const user = await adminUserRepository.findById(claims.sub);
  if (!user) throw new AppError(401, 'TOKEN_INVALID', 'Account no longer exists');

  if (user.status === 'DISABLED' || user.status === 'SUSPENDED') {
    throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is not active');
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AppError(401, 'ACCOUNT_LOCKED', 'This account is temporarily locked');
  }
  if (claims.ver !== user.permissionVersion) {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Your permissions changed — please sign in again');
  }

  const resolved = await rbacService.resolvePermissions(user.id);

  return {
    realm: 'ADMIN',
    principalType: 'ADMIN_USER',
    principalId: user.id,
    principal: user as unknown as Record<string, unknown>,
    permissions: resolved.permissions,
    roles: resolved.roles,
    isSuperAdmin: resolved.isSuperAdmin,
    sessionId: claims.sid,
    displayName: user.name,
    email: user.email,
  };
}

async function loadCustomerContext(claims: AccessTokenClaims): Promise<AuthContext> {
  const customer = await customerRepository.findById(claims.sub);
  if (!customer) throw new AppError(401, 'TOKEN_INVALID', 'Account no longer exists');

  if (customer.status === 'BLOCKED') {
    throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is not active');
  }
  if (customer.lockedUntil && customer.lockedUntil.getTime() > Date.now()) {
    throw new AppError(401, 'ACCOUNT_LOCKED', 'This account is temporarily locked');
  }

  return {
    realm: 'CUSTOMER',
    principalType: 'CUSTOMER',
    principalId: customer.id,
    principal: customer as unknown as Record<string, unknown>,
    permissions: [] as Permission[],
    roles: [],
    isSuperAdmin: false,
    sessionId: claims.sid,
    displayName: customer.name,
    email: customer.email,
  };
}

export async function resolveAuthContext(req: Request, realm: AuthRealm): Promise<AuthContext> {
  const token = readToken(req, realm);
  if (!token) throw new AppError(401, 'NOT_AUTHENTICATED', 'Authentication required');

  const claims = tokenService.verifyAccessToken(realm, token);
  return realm === 'ADMIN' ? loadAdminContext(claims) : loadCustomerContext(claims);
}

export function authenticate(realm: AuthRealm): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    resolveAuthContext(req, realm)
      .then((auth) => {
        req.auth = auth;
        next();
      })
      .catch(next);
  };
}
