import { randomBytes } from 'node:crypto';

import type { Request } from 'express';

import type {
  AdminUserCreateInput,
  AdminUserListQuery,
  AdminUserUpdateInput,
} from '@shared/schemas/auth';
import type { AdminUserDto } from '@shared/types/auth';

import { mailer } from '../../container';
import { adminUserRepository } from '../../repositories/adminUser.repository';
import type { PageResult } from '../../repositories/helpers';
import { verificationTokenRepository } from '../../repositories/otpChallenge.repository';
import { roleRepository } from '../../repositories/role.repository';
import { AppError } from '../../utils/AppError';

import { toAdminUserDto } from './admin-auth.service';
import { auditService } from './audit.service';
import { passwordService } from './password.service';
import { rbacService } from './rbac.service';
import { tokenService } from './token.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

    const roles = await Promise.all(input.roleCodes.map((code) => roleRepository.findByCode(code)));
    const missing = input.roleCodes.filter((_, index) => !roles[index]);
    if (missing.length > 0) throw AppError.validation('Unknown role', { roleCodes: missing });

    const user = await adminUserRepository.create({
      email: input.email,
      name: input.name,
      phone: input.phone ?? null,
      passwordHash: await passwordService.hash(
        input.password ?? randomBytes(24).toString('base64url'),
      ),
      status: input.password ? 'ACTIVE' : 'INVITED',
      mustChangePassword: !input.password,
      invitedById: req.auth?.principalId ?? null,
      invitedAt: new Date(),
    });

    for (const role of roles) {
      await roleRepository.assignRole(user.id, role!.id, req.auth?.principalId ?? null);
    }
    await rbacService.invalidateFor(user.id);

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
    const existing = await adminUserRepository.findById(id);
    if (!existing) throw AppError.notFound('Admin user not found', { id });

    const updated = await adminUserRepository.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.phone === undefined ? {} : { phone: input.phone ?? null }),
      ...(input.status === undefined ? {} : { status: input.status }),
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
    const existing = await adminUserRepository.findById(id);
    if (!existing) throw AppError.notFound('Admin user not found', { id });

    if (req.auth?.principalId === id) {
      throw AppError.forbidden('You cannot delete your own account');
    }
    if (existing.roles.some((assignment) => assignment.role.code === 'SUPER_ADMIN')) {
      const superAdmins = await roleRepository.findByCode('SUPER_ADMIN');
      const holders = superAdmins ? await roleRepository.adminUserIdsWithRole(superAdmins.id) : [];
      if (holders.length <= 1) {
        throw AppError.forbidden('The last SUPER_ADMIN cannot be removed');
      }
    }

    await adminUserRepository.softDelete(id);
    await tokenService.revokeAllForPrincipal('ADMIN_USER', id, 'ACCOUNT_DELETED');
    await rbacService.invalidateFor(id);

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
    const user = await adminUserRepository.findById(id);
    if (!user) throw AppError.notFound('Admin user not found', { id });

    const roles = await Promise.all(roleCodes.map((code) => roleRepository.findByCode(code)));
    const missing = roleCodes.filter((_, index) => !roles[index]);
    if (missing.length > 0) throw AppError.validation('Unknown role', { roleCodes: missing });

    const before = user.roles.map((assignment) => assignment.role.code).sort();

    for (const role of roles) {
      await roleRepository.assignRole(id, role!.id, req.auth?.principalId ?? null);
    }
    const revoked = await roleRepository.revokeRolesExcept(
      id,
      roles.map((role) => role!.id),
    );
    await rbacService.invalidateFor(id);

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
