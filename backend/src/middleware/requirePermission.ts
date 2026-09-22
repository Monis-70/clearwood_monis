import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Permission } from '@shared/enums';

import { auditService } from '../modules/auth/audit.service';
import { rbacService } from '../modules/auth/rbac.service';
import { AppError } from '../utils/AppError';

/**
 * Permission codes come from the seeded registry — a guard never inspects a role name.
 * Every denial is audited so "why could they/couldn't they" is always answerable.
 */

function deny(req: Request, required: readonly string[]): AppError {
  void auditService.recordFromRequest(req, {
    action: 'PERMISSION_DENIED',
    entity: 'Permission',
    entityId: required.join(','),
    severity: auditService.severityForPermission(required[0] ?? ''),
    meta: { required, method: req.method, path: req.originalUrl, held: req.auth?.roles ?? [] },
  });

  return AppError.forbidden('You do not have permission to do that', { required });
}

function guard(check: (req: Request) => boolean, required: readonly string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(new AppError(401, 'NOT_AUTHENTICATED', 'Authentication required'));
      return;
    }
    if (!check(req)) {
      next(deny(req, required));
      return;
    }
    next();
  };
}

export function requirePermission(permission: Permission): RequestHandler {
  return guard((req) => rbacService.can(req.auth!, permission), [permission]);
}

export function requireAnyPermission(permissions: readonly Permission[]): RequestHandler {
  return guard((req) => rbacService.canAny(req.auth!, permissions), permissions);
}

export function requireAllPermissions(permissions: readonly Permission[]): RequestHandler {
  return guard(
    (req) => permissions.every((permission) => rbacService.can(req.auth!, permission)),
    permissions,
  );
}

export function requireRole(...roles: string[]): RequestHandler {
  return guard(
    (req) => req.auth!.isSuperAdmin || roles.some((role) => req.auth!.roles.includes(role)),
    roles,
  );
}
