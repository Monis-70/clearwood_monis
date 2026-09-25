import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import {
  adminLoginSchema,
  adminPasswordSetSchema,
  adminUserCreateSchema,
  adminUserListQuerySchema,
  adminUserUpdateSchema,
  assignRolesSchema,
  auditLogQuerySchema,
  changePasswordSchema,
  forgotPasswordSchema,
  refreshSchema,
  resetPasswordSchema,
  roleCreateSchema,
  roleUpdateSchema,
  sessionListQuerySchema,
} from '@shared/schemas/auth';
import { idParamSchema } from '@shared/schemas/common';

import {
  adminAuthController,
  adminManagementController,
} from '../controllers/adminAuth.controller';
import {
  commonErrorResponses,
  errorBodySchema,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import {
  asyncHandler,
  authenticate,
  authRateLimit,
  optionalAuth,
  requirePermission,
  validate,
} from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

const ADMIN_PREFIX = `${API_PREFIX}/admin`;

const guard = [authenticate('ADMIN'), csrfProtection('ADMIN')];

/**
 * Self-service only: who am I, change my password, list or end my sessions. These are the routes an
 * admin who still has to replace their initial password may reach; every other admin route answers
 * 403 PASSWORD_CHANGE_REQUIRED until they do.
 */
const selfService = authenticate('ADMIN', { allowPendingPasswordChange: true });
const selfServiceGuard = [selfService, csrfProtection('ADMIN')];

const unauthorised = { 401: jsonContent(errorBodySchema, 'Not authenticated') };
const forbidden = {
  403: jsonContent(
    errorBodySchema,
    'Missing permission, CSRF token, or a password change is still pending',
  ),
};

const adminUserSchema = registry.register(
  'AdminUser',
  z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    phone: z.string().nullable(),
    status: z.string(),
    avatarMediaId: z.string().nullable(),
    mustChangePassword: z.boolean(),
    lastLoginAt: z.string().nullable(),
    createdAt: z.string(),
    roles: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  }),
);

const tokensSchema = registry.register(
  'AuthTokens',
  z
    .object({
      accessToken: z.string(),
      expiresIn: z.number().int(),
      tokenType: z.literal('Bearer'),
    })
    .openapi({
      description:
        'The refresh token is NEVER in the body — it is set as an httpOnly cookie. Browsers must ' +
        'rely on that cookie; the body field on /refresh exists only for REST Client and tests.',
    }),
);

const adminMeSchema = registry.register(
  'AdminMe',
  z.object({
    user: adminUserSchema,
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
    mustChangePassword: z.boolean(),
  }),
);

const adminSessionSchema = registry.register(
  'AdminSession',
  z.object({
    id: z.string(),
    familyId: z.string(),
    deviceLabel: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
    lastUsedAt: z.string().nullable(),
    isCurrent: z.boolean(),
  }),
);

const roleSchema = registry.register(
  'Role',
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isSystem: z.boolean(),
    position: z.number().int(),
    isActive: z.boolean(),
    permissionCount: z.number().int(),
    permissions: z.array(z.string()).optional(),
  }),
);

const auditLogSchema = registry.register(
  'AuditLogEntry',
  z.object({
    id: z.string(),
    actorType: z.string(),
    actorId: z.string().nullable(),
    actorName: z.string().nullable(),
    actorEmail: z.string().nullable(),
    realm: z.string().nullable(),
    action: z.string(),
    entity: z.string(),
    entityId: z.string().nullable(),
    severity: z.string(),
    requestId: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    meta: z.any().nullable(),
    changes: z.any().nullable(),
    createdAt: z.string(),
  }),
);

const loginResponseSchema = adminMeSchema.extend({ tokens: tokensSchema });

function path(suffix: string): string {
  return `${ADMIN_PREFIX}${suffix}`;
}

registry.registerPath({
  method: 'post',
  path: path('/auth/login'),
  tags: ['Admin auth'],
  summary: 'Sign in to the admin panel',
  description:
    'Sets cw_adm_at / cw_adm_rt (httpOnly) and cw_adm_csrf (readable) on the /api/v1/admin path. ' +
    'Responses are identical for unknown accounts and wrong passwords.',
  request: { body: { content: { 'application/json': { schema: adminLoginSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(loginResponseSchema), 'Signed in'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/auth/refresh'),
  tags: ['Admin auth'],
  summary: 'Rotate the admin session',
  description:
    'Reads the httpOnly cw_adm_rt cookie. A used token revokes the entire family (401 TOKEN_REUSE). ' +
    'The optional body field is for REST Client/tests only and is rejected in production.',
  request: { body: { content: { 'application/json': { schema: refreshSchema } } } },
  responses: {
    200: jsonContent(successBodySchema(loginResponseSchema), 'Rotated'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/auth/me'),
  tags: ['Admin auth'],
  summary: 'The signed-in admin, their roles and effective permissions',
  responses: {
    200: jsonContent(successBodySchema(adminMeSchema), 'Current admin'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/auth/sessions'),
  tags: ['Admin auth'],
  summary: 'Active sessions for the signed-in admin',
  request: { query: sessionListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(adminSessionSchema)), 'Sessions'),
    ...unauthorised,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/users'),
  tags: ['Admin management'],
  summary: 'List admin users',
  description: 'Requires `system.user.read`.',
  request: { query: adminUserListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(adminUserSchema)), 'Admin users (paginated)'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/roles'),
  tags: ['Admin management'],
  summary: 'List roles',
  description: 'Requires `system.role.read`.',
  responses: {
    200: jsonContent(successBodySchema(z.array(roleSchema)), 'Roles'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/roles/{id}'),
  tags: ['Admin management'],
  summary: 'One role with the permission codes it grants',
  description: 'Requires `system.role.read`.',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(roleSchema), 'Role, `permissions` included'),
    ...unauthorised,
    ...forbidden,
    404: jsonContent(errorBodySchema, 'No such role'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'post',
  path: path('/users/{id}/password'),
  tags: ['Admin management'],
  summary: "Set another admin's password",
  description:
    'Requires `system.user.update` and holding every permission the target holds (so only a ' +
    'SUPER_ADMIN can set a SUPER_ADMIN\u2019s password). Not for your own account \u2014 use ' +
    '/auth/change-password. Ends all of the target\u2019s sessions and requires them to choose a ' +
    'new password at sign-in. Audited as CRITICAL.',
  request: {
    params: idParamSchema,
    body: jsonContent(adminPasswordSetSchema, 'The new password (password policy applies)'),
  },
  responses: {
    200: jsonContent(successBodySchema(adminUserSchema), 'Updated admin user'),
    ...unauthorised,
    ...forbidden,
    404: jsonContent(errorBodySchema, 'No such admin user'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/permissions'),
  tags: ['Admin management'],
  summary: 'The permission registry, grouped for the UI',
  description: 'Requires `system.role.read`.',
  responses: {
    200: jsonContent(successBodySchema(z.record(z.any())), 'Permissions by group'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: path('/audit-logs'),
  tags: ['Admin management'],
  summary: 'Search the audit trail',
  description: 'Requires `system.audit.read`.',
  request: { query: auditLogQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(auditLogSchema)), 'Audit entries (paginated)'),
    ...unauthorised,
    ...forbidden,
    ...commonErrorResponses,
  },
});

export const adminRouter: Router = Router();

/* ------------------------------------------------------------ public auth */

adminRouter.post(
  '/auth/login',
  authRateLimit('admin-login'),
  validate({ body: adminLoginSchema }),
  asyncHandler(adminAuthController.login),
);

// `/auth/refresh` is deliberately CSRF-exempt: SameSite=Lax already blocks a cross-site POST with
// cookies, the response is unreadable cross-origin, and a replayed token kills the whole family.
adminRouter.post(
  '/auth/refresh',
  authRateLimit('admin-refresh'),
  validate({ body: refreshSchema }),
  asyncHandler(adminAuthController.refresh),
);

adminRouter.post(
  '/auth/logout',
  optionalAuth('ADMIN'),
  csrfProtection('ADMIN'),
  asyncHandler(adminAuthController.logout),
);

adminRouter.post(
  '/auth/forgot-password',
  authRateLimit('admin-forgot'),
  validate({ body: forgotPasswordSchema }),
  asyncHandler(adminAuthController.forgotPassword),
);

adminRouter.post(
  '/auth/reset-password',
  authRateLimit('admin-reset'),
  validate({ body: resetPasswordSchema }),
  asyncHandler(adminAuthController.resetPassword),
);

/* --------------------------------------------------------- authenticated */

adminRouter.get('/auth/me', selfService, asyncHandler(adminAuthController.me));

adminRouter.post(
  '/auth/logout-all',
  ...selfServiceGuard,
  asyncHandler(adminAuthController.logoutAll),
);

adminRouter.post(
  '/auth/change-password',
  ...selfServiceGuard,
  validate({ body: changePasswordSchema }),
  asyncHandler(adminAuthController.changePassword),
);

adminRouter.get(
  '/auth/sessions',
  selfService,
  validate({ query: sessionListQuerySchema }),
  asyncHandler(adminAuthController.listSessions),
);

adminRouter.delete(
  '/auth/sessions/:id',
  ...selfServiceGuard,
  validate({ params: idParamSchema }),
  asyncHandler(adminAuthController.revokeSession),
);

/* ------------------------------------------------------ user + role admin */

adminRouter.get(
  '/users',
  authenticate('ADMIN'),
  requirePermission('system.user.read'),
  validate({ query: adminUserListQuerySchema }),
  asyncHandler(adminManagementController.listUsers),
);

adminRouter.post(
  '/users',
  ...guard,
  requirePermission('system.user.create'),
  validate({ body: adminUserCreateSchema }),
  asyncHandler(adminManagementController.createUser),
);

adminRouter.patch(
  '/users/:id',
  ...guard,
  requirePermission('system.user.update'),
  validate({ params: idParamSchema, body: adminUserUpdateSchema }),
  asyncHandler(adminManagementController.updateUser),
);

adminRouter.delete(
  '/users/:id',
  ...guard,
  requirePermission('system.user.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminManagementController.deleteUser),
);

adminRouter.post(
  '/users/:id/roles',
  ...guard,
  requirePermission('system.user.update'),
  requirePermission('system.role.read'),
  validate({ params: idParamSchema, body: assignRolesSchema }),
  asyncHandler(adminManagementController.assignRoles),
);

adminRouter.post(
  '/users/:id/password',
  ...guard,
  requirePermission('system.user.update'),
  validate({ params: idParamSchema, body: adminPasswordSetSchema }),
  asyncHandler(adminManagementController.setPassword),
);

adminRouter.get(
  '/roles',
  authenticate('ADMIN'),
  requirePermission('system.role.read'),
  asyncHandler(adminManagementController.listRoles),
);

adminRouter.get(
  '/roles/:id',
  authenticate('ADMIN'),
  requirePermission('system.role.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminManagementController.getRole),
);

adminRouter.post(
  '/roles',
  ...guard,
  requirePermission('system.role.create'),
  validate({ body: roleCreateSchema }),
  asyncHandler(adminManagementController.createRole),
);

adminRouter.patch(
  '/roles/:id',
  ...guard,
  requirePermission('system.role.update'),
  validate({ params: idParamSchema, body: roleUpdateSchema }),
  asyncHandler(adminManagementController.updateRole),
);

adminRouter.delete(
  '/roles/:id',
  ...guard,
  requirePermission('system.role.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(adminManagementController.deleteRole),
);

adminRouter.get(
  '/permissions',
  authenticate('ADMIN'),
  requirePermission('system.role.read'),
  asyncHandler(adminManagementController.listPermissions),
);

adminRouter.get(
  '/audit-logs',
  authenticate('ADMIN'),
  requirePermission('system.audit.read'),
  validate({ query: auditLogQuerySchema }),
  asyncHandler(adminManagementController.listAuditLogs),
);
