import type { AdminUserRole, Permission, Prisma, Role } from '@prisma/client';

import { prisma } from '../config/prisma';

const withPermissions = {
  permissions: { include: { permission: true } },
} satisfies Prisma.RoleInclude;

export type RoleWithPermissions = Prisma.RoleGetPayload<{ include: typeof withPermissions }>;

/** Roles, permissions and their joins — one aggregate, one repository (R1). */
export const roleRepository = {
  findById(id: string): Promise<RoleWithPermissions | null> {
    return prisma.role.findUnique({ where: { id }, include: withPermissions });
  },

  findByCode(code: string): Promise<RoleWithPermissions | null> {
    return prisma.role.findUnique({ where: { code }, include: withPermissions });
  },

  findAll(includeInactive = false): Promise<RoleWithPermissions[]> {
    return prisma.role.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: withPermissions,
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },

  create(data: Prisma.RoleUncheckedCreateInput): Promise<RoleWithPermissions> {
    return prisma.role.create({ data, include: withPermissions });
  },

  update(id: string, data: Prisma.RoleUncheckedUpdateInput): Promise<RoleWithPermissions> {
    return prisma.role.update({ where: { id }, data, include: withPermissions });
  },

  delete(id: string): Promise<Role> {
    return prisma.role.delete({ where: { id } });
  },

  async replacePermissions(roleId: string, permissionIds: string[]): Promise<void> {
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId } }),
      prisma.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      }),
    ]);
  },

  /** Used by the seed: adds missing grants without touching the ones an admin curated. */
  async addPermissions(roleId: string, permissionIds: string[]): Promise<number> {
    const existing = await prisma.rolePermission.findMany({
      where: { roleId },
      select: { permissionId: true },
    });
    const have = new Set(existing.map((row) => row.permissionId));
    const missing = permissionIds.filter((id) => !have.has(id));

    if (missing.length === 0) return 0;

    await prisma.rolePermission.createMany({
      data: missing.map((permissionId) => ({ roleId, permissionId })),
    });
    return missing.length;
  },

  findAllPermissions(): Promise<Permission[]> {
    return prisma.permission.findMany({ orderBy: [{ group: 'asc' }, { code: 'asc' }] });
  },

  findPermissionsByCodes(codes: string[]): Promise<Permission[]> {
    return prisma.permission.findMany({ where: { code: { in: codes } } });
  },

  upsertPermission(data: {
    code: string;
    name: string;
    group: string;
    isDangerous: boolean;
  }): Promise<Permission> {
    return prisma.permission.upsert({
      where: { code: data.code },
      update: { group: data.group, isDangerous: data.isDangerous },
      create: data,
    });
  },

  upsertRole(data: {
    code: string;
    name: string;
    description: string;
    isSystem: boolean;
    position: number;
  }): Promise<Role> {
    return prisma.role.upsert({
      where: { code: data.code },
      update: { isSystem: data.isSystem, position: data.position },
      create: data,
    });
  },

  /** Every permission code granted to an admin user, across all of their roles. */
  async permissionCodesFor(
    adminUserId: string,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<{ roles: string[]; permissions: string[] }> {
    const assignments = await tx.adminUserRole.findMany({
      where: { adminUserId },
      include: { role: { include: withPermissions } },
    });

    const roles = assignments.map((assignment) => assignment.role.code);
    const permissions = new Set<string>();

    for (const assignment of assignments) {
      if (!assignment.role.isActive) continue;
      for (const grant of assignment.role.permissions) permissions.add(grant.permission.code);
    }

    return { roles, permissions: [...permissions].sort() };
  },

  assignRole(
    adminUserId: string,
    roleId: string,
    assignedById: string | null,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<AdminUserRole> {
    return tx.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId, roleId } },
      update: { assignedById },
      create: { adminUserId, roleId, assignedById },
    });
  },

  async revokeRolesExcept(
    adminUserId: string,
    keepRoleIds: string[],
    tx: Prisma.TransactionClient = prisma,
  ): Promise<number> {
    const result = await tx.adminUserRole.deleteMany({
      where: { adminUserId, roleId: { notIn: keepRoleIds } },
    });
    return result.count;
  },

  /**
   * Runs `work` in one transaction that first takes a row lock on the role, so every decision of
   * the form "how many holders would remain" is serialised. Without it two requests that each
   * remove a different holder both count "one other remains" and both proceed.
   */
  withRoleLock<T>(code: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Role WHERE code = ${code} FOR UPDATE`;
      return work(tx);
    });
  },

  /** Holders who can actually sign in: ACTIVE and not soft-deleted. */
  countActiveHolders(
    code: string,
    excludeAdminUserId: string,
    tx: Prisma.TransactionClient = prisma,
  ): Promise<number> {
    return tx.adminUser.count({
      where: {
        id: { not: excludeAdminUserId },
        status: 'ACTIVE',
        deletedAt: null,
        roles: { some: { role: { code } } },
      },
    });
  },

  adminUserIdsWithRole(roleId: string): Promise<{ adminUserId: string }[]> {
    return prisma.adminUserRole.findMany({ where: { roleId }, select: { adminUserId: true } });
  },

  countRoles(): Promise<number> {
    return prisma.role.count();
  },

  countPermissions(): Promise<number> {
    return prisma.permission.count();
  },
};
