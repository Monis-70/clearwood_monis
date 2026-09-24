import type { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { PERMISSION_CODES, type Permission } from '@shared/enums';

import { logger } from '../../config/logger';
import { MemoryCacheDriver } from '../../drivers/cache';
import { adminUserRepository } from '../../repositories/adminUser.repository';
import { roleRepository } from '../../repositories/role.repository';
import { AppError } from '../../utils/AppError';

import { auditService } from './audit.service';

/**
 * Effective permissions are the union of every active role's grants.
 * SUPER_ADMIN short-circuits to allow-all so a newly added permission works without a re-grant.
 *
 * CACHE CONTRACT (MySQL stays the source of truth):
 *  - key        `rbac:perms:{adminUserId}:v{permissionVersion}`; namespace `rbac:perms:`
 *  - value      plain JSON (role codes, permission codes, a boolean)
 *  - TTL        300 s
 *  - invalidate every role or permission change bumps `permissionVersion` (in the same
 *               transaction for an admin's own role changes; straight after the commit for an
 *               edit to a role's grants), which moves the key; the old keys are deleted
 *               best-effort and are unreachable anyway, because a token carrying the old version
 *               is refused by `authenticate`. Keying on the version is what keeps one PM2 worker
 *               from serving another worker's stale grants when the cache is per-process.
 *  - where      in this process, whatever CACHE_DRIVER says. The version read from MySQL on every
 *               request already propagates a change to every worker, so sharing the entries buys
 *               nothing - and keeping them here keeps Redis out of every authorization decision.
 *  - failure    a cache error is logged and the answer is read from MySQL; authorization never
 *               depends on the cache being up.
 */

const CACHE_PREFIX = 'rbac:perms:';
const TTL_SECONDS = 300;
const permissionCache = new MemoryCacheDriver(1_000);

export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

export interface ResolvedPermissions {
  roles: string[];
  permissions: Permission[];
  isSuperAdmin: boolean;
}

/** A permission set to compare against another. */
export interface Privilege {
  isSuperAdmin: boolean;
  permissions: ReadonlySet<string>;
}

/** The shape `roleRepository` returns roles in: a code and its grants. */
interface RoleGrants {
  code: string;
  permissions: { permission: { code: string } }[];
}

function cacheKey(adminUserId: string, permissionVersion: number): string {
  return `${CACHE_PREFIX}${adminUserId}:v${permissionVersion}`;
}

export const rbacService = {
  /** Uncached, straight from MySQL. Privilege comparisons (who may grant what) use this. */
  async effectivePermissions(
    adminUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ResolvedPermissions> {
    const { roles, permissions } = await roleRepository.permissionCodesFor(adminUserId, tx);
    const isSuperAdmin = roles.includes(SUPER_ADMIN_ROLE);

    return {
      roles,
      isSuperAdmin,
      permissions: isSuperAdmin ? [...PERMISSION_CODES] : (permissions as Permission[]),
    };
  },

  async resolvePermissions(user: {
    id: string;
    permissionVersion: number;
  }): Promise<ResolvedPermissions> {
    const key = cacheKey(user.id, user.permissionVersion);

    try {
      const cached = await permissionCache.get<ResolvedPermissions>(key);
      if (cached) return cached;
    } catch (error) {
      logger.warn({ err: error }, 'permission cache read failed — resolving from the database');
    }

    const resolved = await this.effectivePermissions(user.id);

    try {
      await permissionCache.set(key, resolved, TTL_SECONDS);
    } catch (error) {
      logger.warn({ err: error }, 'permission cache write failed — continuing uncached');
    }

    return resolved;
  },

  can(resolved: Pick<ResolvedPermissions, 'permissions' | 'isSuperAdmin'>, code: string): boolean {
    return resolved.isSuperAdmin || (resolved.permissions as string[]).includes(code);
  },

  canAny(
    resolved: Pick<ResolvedPermissions, 'permissions' | 'isSuperAdmin'>,
    codes: readonly string[],
  ): boolean {
    return codes.some((code) => this.can(resolved, code));
  },

  /**
   * Pass `tx` when the role change runs in a transaction: the bump then commits atomically with
   * the change, so no token can outlive the grants it was issued against.
   */
  async invalidateFor(adminUserId: string, tx?: Prisma.TransactionClient): Promise<void> {
    // The version bump is what kills access tokens that were already handed out.
    await adminUserRepository.bumpPermissionVersion(adminUserId, tx);

    try {
      await permissionCache.delByPrefix(`${CACHE_PREFIX}${adminUserId}:`);
    } catch (error) {
      logger.warn({ err: error }, 'permission cache cleanup failed — old keys expire on their own');
    }
  },

  /** A role's permissions changed — every holder must be re-evaluated immediately. */
  async invalidateRole(roleId: string): Promise<number> {
    const holders = await roleRepository.adminUserIdsWithRole(roleId);
    await Promise.all(holders.map((holder) => this.invalidateFor(holder.adminUserId)));
    return holders.length;
  },

  /* ------------------------------------------------------------ no amplification */

  /**
   * THE rule behind every admin-user and role write: holding `system.user.*` or `system.role.*`
   * lets an admin manage what is at or below their own level, never lift anybody - themselves
   * included - above it. `actor` covers `other` when every permission `other` confers, the actor
   * already holds. SUPER_ADMIN is allow-all, including codes that do not exist yet, so only a
   * SUPER_ADMIN covers a SUPER_ADMIN.
   */
  covers(actor: Privilege, other: Privilege): boolean {
    if (actor.isSuperAdmin) return true;
    if (other.isSuperAdmin) return false;
    for (const code of other.permissions) {
      if (!actor.permissions.has(code)) return false;
    }
    return true;
  },

  /** What an admin holds right now, read from MySQL rather than the cache. */
  async privilegeOfUser(adminUserId: string, tx?: Prisma.TransactionClient): Promise<Privilege> {
    const resolved = await this.effectivePermissions(adminUserId, tx);
    return { isSuperAdmin: resolved.isSuperAdmin, permissions: new Set(resolved.permissions) };
  },

  /** What holding these roles would confer. Inactive roles count: reactivating one must not escalate. */
  privilegeOfRoles(roles: readonly RoleGrants[]): Privilege {
    return {
      isSuperAdmin: roles.some((role) => role.code === SUPER_ADMIN_ROLE),
      permissions: new Set(
        roles.flatMap((role) => role.permissions.map((grant) => grant.permission.code)),
      ),
    };
  },

  /** Audits a refused privilege change and returns the 403 to throw. */
  refuse(
    req: Request,
    refusal: {
      code:
        | 'ROLE_NOT_GRANTABLE'
        | 'ROLE_NOT_MANAGEABLE'
        | 'ADMIN_USER_NOT_MANAGEABLE'
        | 'LAST_SUPER_ADMIN';
      message: string;
      entity: 'AdminUser' | 'Role';
      entityId: string | null;
      details?: Record<string, unknown>;
    },
  ): AppError {
    void auditService.recordFromRequest(req, {
      action: 'PERMISSION_DENIED',
      entity: refusal.entity,
      entityId: refusal.entityId,
      // An attempted escalation is an incident; protecting the last SUPER_ADMIN is housekeeping.
      severity: refusal.code === 'LAST_SUPER_ADMIN' ? 'WARNING' : 'CRITICAL',
      meta: { reason: refusal.code, ...(refusal.details ?? {}) },
    });

    return new AppError(403, refusal.code, refusal.message, refusal.details ?? null);
  },
};
