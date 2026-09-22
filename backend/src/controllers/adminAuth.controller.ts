import type { Request, Response } from 'express';

import type {
  AdminLoginInput,
  AdminUserCreateInput,
  AdminUserListQuery,
  AdminUserUpdateInput,
  AssignRolesInput,
  AuditLogQuery,
  ChangePasswordInput,
  ForgotPasswordInput,
  RefreshInput,
  ResetPasswordInput,
  RoleCreateInput,
  RoleUpdateInput,
  SessionListQuery,
} from '@shared/schemas/auth';
import type { CategoryTreeQuery } from '@shared/schemas/catalog';
import type { IdParam } from '@shared/schemas/common';

import { adminAuthService } from '../modules/auth/admin-auth.service';
import { adminUserService } from '../modules/auth/admin-user.service';
import { auditService } from '../modules/auth/audit.service';
import { roleService } from '../modules/auth/role.service';
import { categoryService } from '../services/category.service';
import { ok, paginated } from '../utils/response';

/** R1 — thin: validated input in, service call, envelope out. */
export const adminAuthController = {
  async login(req: Request, res: Response): Promise<void> {
    const input = req.body as AdminLoginInput;
    const result = await adminAuthService.login(req, res, input);

    ok(res, {
      user: result.user,
      roles: result.roles,
      permissions: result.permissions,
      mustChangePassword: result.mustChangePassword,
      tokens: { accessToken: result.accessToken, expiresIn: result.expiresIn, tokenType: 'Bearer' },
    });
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const { refreshToken } = (req.body ?? {}) as RefreshInput;
    const result = await adminAuthService.refresh(req, res, refreshToken);

    ok(res, {
      user: result.user,
      roles: result.roles,
      permissions: result.permissions,
      mustChangePassword: result.mustChangePassword,
      tokens: { accessToken: result.accessToken, expiresIn: result.expiresIn, tokenType: 'Bearer' },
    });
  },

  async logout(req: Request, res: Response): Promise<void> {
    await adminAuthService.logout(req, res);
    ok(res, { loggedOut: true });
  },

  async logoutAll(req: Request, res: Response): Promise<void> {
    const revoked = await adminAuthService.logoutAll(req, res);
    ok(res, { loggedOut: true, sessionsRevoked: revoked });
  },

  async me(req: Request, res: Response): Promise<void> {
    ok(res, await adminAuthService.me(req.auth!.principalId));
  },

  async changePassword(req: Request, res: Response): Promise<void> {
    await adminAuthService.changePassword(req, res, req.body as ChangePasswordInput);
    ok(res, { changed: true });
  },

  /** Always 200 — the response must be identical whether or not the account exists. */
  async forgotPassword(req: Request, res: Response): Promise<void> {
    await adminAuthService.forgotPassword(req, (req.body as ForgotPasswordInput).email);
    ok(res, { sent: true });
  },

  async resetPassword(req: Request, res: Response): Promise<void> {
    await adminAuthService.resetPassword(req, req.body as ResetPasswordInput);
    ok(res, { reset: true });
  },

  async listSessions(req: Request, res: Response): Promise<void> {
    const { includeExpired } = req.query as unknown as SessionListQuery;
    ok(
      res,
      await adminAuthService.listSessions(
        req.auth!.principalId,
        req.auth!.sessionId,
        includeExpired,
      ),
    );
  },

  async revokeSession(req: Request, res: Response): Promise<void> {
    await adminAuthService.revokeSession(req, (req.params as unknown as IdParam).id);
    ok(res, { revoked: true });
  },
};

export const adminManagementController = {
  async listUsers(req: Request, res: Response): Promise<void> {
    const page = await adminUserService.list(req.query as unknown as AdminUserListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async createUser(req: Request, res: Response): Promise<void> {
    ok(res, await adminUserService.create(req, req.body as AdminUserCreateInput), null, 201);
  },

  async updateUser(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await adminUserService.update(req, id, req.body as AdminUserUpdateInput));
  },

  async deleteUser(req: Request, res: Response): Promise<void> {
    await adminUserService.remove(req, (req.params as unknown as IdParam).id);
    ok(res, { deleted: true });
  },

  async assignRoles(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const { roleCodes } = req.body as AssignRolesInput;
    ok(res, await adminUserService.assignRoles(req, id, roleCodes));
  },

  async listRoles(_req: Request, res: Response): Promise<void> {
    ok(res, await roleService.list());
  },

  async createRole(req: Request, res: Response): Promise<void> {
    ok(res, await roleService.create(req, req.body as RoleCreateInput), null, 201);
  },

  async updateRole(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await roleService.update(req, id, req.body as RoleUpdateInput));
  },

  async deleteRole(req: Request, res: Response): Promise<void> {
    await roleService.remove(req, (req.params as unknown as IdParam).id);
    ok(res, { deleted: true });
  },

  async listPermissions(_req: Request, res: Response): Promise<void> {
    ok(res, await roleService.listPermissions());
  },

  async listAuditLogs(req: Request, res: Response): Promise<void> {
    const page = await auditService.list(req.query as unknown as AuditLogQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  /** Proves the guard chain end to end by reusing Prompt 2's service — no new query logic. */
  async categories(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as CategoryTreeQuery;
    ok(res, await categoryService.getTree({ ...query, includeInactive: true }));
  },
};
