import type { Request } from 'express';

import { permissionGroup } from '@shared/enums';
import type { RoleCreateInput, RoleUpdateInput } from '@shared/schemas/auth';
import type { PermissionDto, RoleDto } from '@shared/types/auth';

import { roleRepository, type RoleWithPermissions } from '../../repositories/role.repository';
import { AppError } from '../../utils/AppError';

import { auditService } from './audit.service';
import { rbacService } from './rbac.service';

function toRoleDto(role: RoleWithPermissions, includePermissions = false): RoleDto {
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    position: role.position,
    isActive: role.isActive,
    permissionCount: role.permissions.length,
    ...(includePermissions
      ? { permissions: role.permissions.map((grant) => grant.permission.code).sort() }
      : {}),
  };
}

async function resolvePermissionIds(codes: string[]): Promise<string[]> {
  if (codes.length === 0) return [];

  const rows = await roleRepository.findPermissionsByCodes(codes);
  const found = new Set(rows.map((row) => row.code));
  const missing = codes.filter((code) => !found.has(code));

  if (missing.length > 0) throw AppError.validation('Unknown permission', { permissions: missing });
  return rows.map((row) => row.id);
}

/**
 * No amplification applies to role DEFINITIONS too: `system.role.*` lets an admin shape roles at
 * or below their own level - never edit one above it (SUPER_ADMIN included), and never make a
 * role confer a permission they do not hold themselves, which would be a self-grant by proxy.
 */
async function assertRoleManageable(
  req: Request,
  role: RoleWithPermissions | null,
  permissions: readonly string[] | undefined,
): Promise<void> {
  const actorId = req.auth?.principalId;
  if (!actorId) throw new AppError(401, 'NOT_AUTHENTICATED', 'Authentication required');

  const actor = await rbacService.privilegeOfUser(actorId);
  if (actor.isSuperAdmin) return;

  if (role && !rbacService.covers(actor, rbacService.privilegeOfRoles([role]))) {
    throw rbacService.refuse(req, {
      code: 'ROLE_NOT_MANAGEABLE',
      message: 'You cannot change a role that carries permissions you do not hold',
      entity: 'Role',
      entityId: role.id,
      details: { role: role.code },
    });
  }

  const notHeld = (permissions ?? []).filter((code) => !actor.permissions.has(code));
  if (notHeld.length > 0) {
    throw rbacService.refuse(req, {
      code: 'ROLE_NOT_MANAGEABLE',
      message: 'You cannot give a role permissions you do not hold',
      entity: 'Role',
      entityId: role?.id ?? null,
      details: { permissions: notHeld },
    });
  }
}

export const roleService = {
  async list(): Promise<RoleDto[]> {
    const roles = await roleRepository.findAll(true);
    return roles.map((role) => toRoleDto(role));
  },

  async get(id: string): Promise<RoleDto> {
    const role = await roleRepository.findById(id);
    if (!role) throw AppError.notFound('Role not found', { id });
    return toRoleDto(role, true);
  },

  /** Grouped for the admin UI's permission matrix. */
  async listPermissions(): Promise<Record<string, PermissionDto[]>> {
    const permissions = await roleRepository.findAllPermissions();
    const grouped: Record<string, PermissionDto[]> = {};

    for (const permission of permissions) {
      const group = permission.group || permissionGroup(permission.code);
      grouped[group] ??= [];
      grouped[group].push({
        id: permission.id,
        code: permission.code,
        name: permission.name,
        group,
        description: permission.description,
        isDangerous: permission.isDangerous,
      });
    }

    return grouped;
  },

  async create(req: Request, input: RoleCreateInput): Promise<RoleDto> {
    if (await roleRepository.findByCode(input.code)) {
      throw AppError.conflict('A role with that code already exists');
    }

    const permissionIds = await resolvePermissionIds(input.permissions);
    await assertRoleManageable(req, null, input.permissions);

    const role = await roleRepository.create({
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      position: input.position ?? 100,
      isSystem: false,
    });

    if (permissionIds.length > 0) {
      await roleRepository.replacePermissions(role.id, permissionIds);
    }

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Role',
      entityId: role.id,
      severity: 'NOTICE',
      meta: { code: role.code, permissions: input.permissions },
    });

    return this.get(role.id);
  },

  async update(req: Request, id: string, input: RoleUpdateInput): Promise<RoleDto> {
    const role = await roleRepository.findById(id);
    if (!role) throw AppError.notFound('Role not found', { id });

    if (role.isSystem && input.isActive === false) {
      throw AppError.forbidden('A system role cannot be deactivated');
    }

    await assertRoleManageable(req, role, input.permissions);

    const before = role.permissions.map((grant) => grant.permission.code).sort();

    await roleRepository.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description ?? null }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    });

    if (input.permissions) {
      await roleRepository.replacePermissions(id, await resolvePermissionIds(input.permissions));
    }

    const holders = await rbacService.invalidateRole(id);

    void auditService.recordFromRequest(req, {
      action: input.permissions ? 'ROLE_ASSIGNED' : 'UPDATE',
      entity: 'Role',
      entityId: id,
      severity: 'NOTICE',
      changes: input.permissions
        ? { before: { permissions: before }, after: { permissions: [...input.permissions].sort() } }
        : auditService.diff(
            { name: role.name, position: role.position, isActive: role.isActive },
            {
              name: input.name ?? role.name,
              position: input.position ?? role.position,
              isActive: input.isActive ?? role.isActive,
            },
          ),
      meta: { holdersInvalidated: holders },
    });

    return this.get(id);
  },

  async remove(req: Request, id: string): Promise<void> {
    const role = await roleRepository.findById(id);
    if (!role) throw AppError.notFound('Role not found', { id });
    if (role.isSystem) throw AppError.forbidden('A system role cannot be deleted');

    await assertRoleManageable(req, role, undefined);

    const holders = await roleRepository.adminUserIdsWithRole(id);
    if (holders.length > 0) {
      throw AppError.conflict('Unassign this role from every admin before deleting it', {
        holders: holders.length,
      });
    }

    await roleRepository.delete(id);

    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Role',
      entityId: id,
      severity: 'WARNING',
      meta: { code: role.code },
    });
  },
};
