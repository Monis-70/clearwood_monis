import { randomBytes } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import type { Request } from 'express';

import type {
  AdminUserCreateInput,
  AdminUserListQuery,
  AdminUserUpdateInput,
} from '@shared/schemas/auth';
import type { AdminUserDto } from '@shared/types/auth';

import { mailer } from '../../container';
import {
  adminUserRepository,
  type AdminUserWithRoles,
} from '../../repositories/adminUser.repository';
import type { PageResult } from '../../repositories/helpers';
import { verificationTokenRepository } from '../../repositories/otpChallenge.repository';
import { roleRepository, type RoleWithPermissions } from '../../repositories/role.repository';
import { AppError } from '../../utils/AppError';

import { toAdminUserDto } from './admin-auth.service';
import { auditService } from './audit.service';
import { passwordService } from './password.service';
import { rbacService, SUPER_ADMIN_ROLE, type Privilege } from './rbac.service';
import { tokenService } from './token.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every admin-user write runs under a row lock on the SUPER_ADMIN role, so "is another active
 * SUPER_ADMIN left?" cannot be answered twice at once by two requests that each remove one.
 * Admin management is rare; serialising it costs nothing measurable.
 */
function underSuperAdminLock<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return roleRepository.withRoleLock(SUPER_ADMIN_ROLE, work);
}

async function loadRoles(codes: string[]): Promise<RoleWithPermissions[]> {
  const roles = await Promise.all(codes.map((code) => roleRepository.findByCode(code)));
  const missing = codes.filter((_, index) => !roles[index]);
  if (missing.length > 0) throw AppError.validation('Unknown role', { roleCodes: missing });
  return roles as RoleWithPermissions[];
}

/** The caller's privilege, read from MySQL: the permission cache never decides an escalation. */
async function actorPrivilege(req: Request): Promise<Privilege> {
  const actorId = req.auth?.principalId;
  if (!actorId) throw new AppError(401, 'NOT_AUTHENTICATED', 'Authentication required');
  return rbacService.privilegeOfUser(actorId);
}

/** A role may be granted only if everything it confers, the actor already holds. */
function assertGrantable(
  req: Request,
  actor: Privilege,
  roles: RoleWithPermissions[],
  targetId: string | null,
): void {
  const refused = roles.filter(
    (role) => !rbacService.covers(actor, rbacService.privilegeOfRoles([role])),
  );
  if (refused.length === 0) return;

  throw rbacService.refuse(req, {
    code: 'ROLE_NOT_GRANTABLE',
    message: 'You cannot grant a role that carries permissions you do not hold',
    entity: 'AdminUser',
    entityId: targetId,
    details: { roleCodes: refused.map((role) => role.code) },
  });
}

/** An account may be changed only by somebody who holds everything it holds. */
async function assertManageable(
  req: Request,
  actor: Privilege,
  target: AdminUserWithRoles,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (actor.isSuperAdmin) return;
  if (rbacService.covers(actor, await rbacService.privilegeOfUser(target.id, tx))) return;

  throw rbacService.refuse(req, {
    code: 'ADMIN_USER_NOT_MANAGEABLE',
    message: 'You cannot change an admin who holds permissions you do not',
    entity: 'AdminUser',
    entityId: target.id,
  });
}

function isActiveSuperAdmin(user: AdminUserWithRoles): boolean {
  return (
    user.status === 'ACTIVE' &&
    !user.deletedAt &&
    user.roles.some((assignment) => assignment.role.code === SUPER_ADMIN_ROLE)
  );
}

/** Nobody - the SUPER_ADMIN themselves included - may leave the platform without one. */
async function assertAnotherSuperAdmin(
  req: Request,
  target: AdminUserWithRoles,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if ((await roleRepository.countActiveHolders(SUPER_ADMIN_ROLE, target.id, tx)) > 0) return;

  throw rbacService.refuse(req, {
    code: 'LAST_SUPER_ADMIN',
    message: 'The last active SUPER_ADMIN cannot be disabled, suspended, deleted or demoted',
    entity: 'AdminUser',
    entityId: target.id,
  });
}

export const adminUserService = {
  async list(query: AdminUserListQuery): Promise<PageResult<AdminUserDto>> {
    const page = await adminUserRepository.list(query);
    return { ...page, items: page.items.map(toAdminUserDto) };
  },

  async get(id: string): Promise<AdminUserDto> {
    const user = await adminUserRepository.findById(id);
    if (!user) throw AppError.notFound('Admin user not found', { id });
    return toAdminUserDto(user);
  },

  /** Without a password the user is INVITED and receives a single-use set-password token. */
  async create(req: Request, input: AdminUserCreateInput): Promise<AdminUserDto> {
    const existing = await adminUserRepository.findByEmail(input.email);
    if (existing) throw AppError.conflict('An admin with that email already exists');

    if (input.password) {
      passwordService.assertPolicy(input.password, { email: input.email, phone: input.phone });
    }

    const roles = await loadRoles(input.roleCodes);
    assertGrantable(req, await actorPrivilege(req), roles, null);

    const actorId = req.auth?.principalId ?? null;
    const passwordHash = await passwordService.hash(
      input.password ?? randomBytes(24).toString('base64url'),
    );

    // One transaction: an account never exists without the roles it was created with. A second
    // request for the same email loses on the unique index and answers 409.
    const user = await underSuperAdminLock(async (tx) => {
      const created = await adminUserRepository.create(
        {
          email: input.email,
          name: input.name,
          phone: input.phone ?? null,
          passwordHash,
          status: input.password ? 'ACTIVE' : 'INVITED',
          mustChangePassword: !input.password,
          invitedById: actorId,
          invitedAt: new Date(),
        },
        tx,
      );

      for (const role of roles) {
        await roleRepository.assignRole(created.id, role.id, actorId, tx);
      }
      await rbacService.invalidateFor(created.id, tx);

      return created;
    });

    if (!input.password) {
      const token = randomBytes(32).toString('base64url');
      await verificationTokenRepository.create({
        purpose: 'ADMIN_INVITE',
        principalType: 'ADMIN_USER',
        principalId: user.id,
        tokenHash: tokenService.hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });

      await mailer.send({
        to: user.email,
        subject: 'You have been invited to the ClearWood admin panel',
        text: [
          `Hello ${user.name},`,
          '',
          'Use this token on the reset-password screen to set your password. It is valid for 7 days.',
          '',
          token,
        ].join('\n'),
      });
    }

    void auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'AdminUser',
      entityId: user.id,
      meta: { email: user.email, roles: input.roleCodes, invited: !input.password },
    });

    return this.get(user.id);
  },

  async update(req: Request, id: string, input: AdminUserUpdateInput): Promise<AdminUserDto> {
    const actor = await actorPrivilege(req);

    const { existing, updated } = await underSuperAdminLock(async (tx) => {
      const existing = await adminUserRepository.findById(id, tx);
      if (!existing) throw AppError.notFound('Admin user not found', { id });

      await assertManageable(req, actor, existing, tx);

      if (input.status !== undefined && input.status !== 'ACTIVE' && isActiveSuperAdmin(existing)) {
        await assertAnotherSuperAdmin(req, existing, tx);
      }

      const updated = await adminUserRepository.update(
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.phone === undefined ? {} : { phone: input.phone ?? null }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        tx,
      );

      return { existing, updated };
    });

    if (input.status && input.status !== 'ACTIVE') {
      await tokenService.revokeAllForPrincipal('ADMIN_USER', id, `STATUS_${input.status}`);
    }

    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'AdminUser',
      entityId: id,
      changes: auditService.diff(
        { name: existing.name, phone: existing.phone, status: existing.status },
        { name: updated.name, phone: updated.phone, status: updated.status },
      ),
    });

    return toAdminUserDto(updated);
  },

  async remove(req: Request, id: string): Promise<void> {
    if (req.auth?.principalId === id) {
      throw AppError.forbidden('You cannot delete your own account');
    }

    const actor = await actorPrivilege(req);

    const existing = await underSuperAdminLock(async (tx) => {
      const existing = await adminUserRepository.findById(id, tx);
      if (!existing) throw AppError.notFound('Admin user not found', { id });

      await assertManageable(req, actor, existing, tx);
      if (isActiveSuperAdmin(existing)) await assertAnotherSuperAdmin(req, existing, tx);

      await adminUserRepository.softDelete(id, tx);
      await rbacService.invalidateFor(id, tx);

      return existing;
    });

    await tokenService.revokeAllForPrincipal('ADMIN_USER', id, 'ACCOUNT_DELETED');

    void auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'AdminUser',
      entityId: id,
      severity: 'WARNING',
      meta: { email: existing.email },
    });
  },

  /** Replaces the whole role set; every live access token for that user dies immediately. */
  async assignRoles(req: Request, id: string, roleCodes: string[]): Promise<AdminUserDto> {
    const roles = await loadRoles(roleCodes);
    const actor = await actorPrivilege(req);
    assertGrantable(req, actor, roles, id);

    const actorId = req.auth?.principalId ?? null;
    const keepsSuperAdmin = roles.some((role) => role.code === SUPER_ADMIN_ROLE);

    const { before, revoked } = await underSuperAdminLock(async (tx) => {
      const user = await adminUserRepository.findById(id, tx);
      if (!user) throw AppError.notFound('Admin user not found', { id });

      await assertManageable(req, actor, user, tx);
      if (!keepsSuperAdmin && isActiveSuperAdmin(user)) {
        await assertAnotherSuperAdmin(req, user, tx);
      }

      for (const role of roles) {
        await roleRepository.assignRole(id, role.id, actorId, tx);
      }
      const revoked = await roleRepository.revokeRolesExcept(
        id,
        roles.map((role) => role.id),
        tx,
      );
      // Same transaction: the new grants and the death of every old token commit together.
      await rbacService.invalidateFor(id, tx);

      return { before: user.roles.map((assignment) => assignment.role.code).sort(), revoked };
    });

    const after = [...roleCodes].sort();

    void auditService.recordFromRequest(req, {
      action: 'ROLE_ASSIGNED',
      entity: 'AdminUser',
      entityId: id,
      changes: { before: { roles: before }, after: { roles: after } },
      meta: { revoked },
    });

    return this.get(id);
  },
};
