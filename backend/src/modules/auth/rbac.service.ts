import { PERMISSION_CODES, type Permission } from '@shared/enums';

import { cache } from '../../container';
import { adminUserRepository } from '../../repositories/adminUser.repository';
import { roleRepository } from '../../repositories/role.repository';

/**
 * Effective permissions are the union of every active role's grants, cached per admin user.
 * SUPER_ADMIN short-circuits to allow-all so a newly added permission works without a re-grant.
 */

const CACHE_PREFIX = 'rbac:perms:';
const TTL_SECONDS = 300;

export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

export interface ResolvedPermissions {
  roles: string[];
  permissions: Permission[];
  isSuperAdmin: boolean;
}

export const rbacService = {
  async resolvePermissions(adminUserId: string): Promise<ResolvedPermissions> {
    return cache.wrap(`${CACHE_PREFIX}${adminUserId}`, TTL_SECONDS, async () => {
      const { roles, permissions } = await roleRepository.permissionCodesFor(adminUserId);
      const isSuperAdmin = roles.includes(SUPER_ADMIN_ROLE);

      return {
        roles,
        isSuperAdmin,
        permissions: isSuperAdmin ? [...PERMISSION_CODES] : (permissions as Permission[]),
      };
    });
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

  async invalidateFor(adminUserId: string): Promise<void> {
    await cache.del(`${CACHE_PREFIX}${adminUserId}`);
    // The version bump is what kills access tokens that were already handed out.
    await adminUserRepository.bumpPermissionVersion(adminUserId);
  },

  /** A role's permissions changed — every holder must be re-evaluated immediately. */
  async invalidateRole(roleId: string): Promise<number> {
    const holders = await roleRepository.adminUserIdsWithRole(roleId);
    await Promise.all(holders.map((holder) => this.invalidateFor(holder.adminUserId)));
    return holders.length;
  },

  async invalidateAll(): Promise<void> {
    await cache.delByPrefix(CACHE_PREFIX);
  },
};
