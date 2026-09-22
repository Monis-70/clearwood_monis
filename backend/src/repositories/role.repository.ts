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
  ): Promise<{ roles: string[]; permissions: string[] }> {
    const assignments = await prisma.adminUserRole.findMany({
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
  ): Promise<AdminUserRole> {
    return prisma.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId, roleId } },
      update: { assignedById },
      create: { adminUserId, roleId, assignedById },
    });
  },

  async revokeRolesExcept(adminUserId: string, keepRoleIds: string[]): Promise<number> {
    const result = await prisma.adminUserRole.deleteMany({
      where: { adminUserId, roleId: { notIn: keepRoleIds } },
    });
    return result.count;
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
