import { z } from 'zod';

import {
  ADMIN_ROLE_CODES,
  ADMIN_USER_STATUSES,
  AUDIT_ACTIONS,
  AUDIT_SEVERITIES,
  AUTH_REALMS,
  CUSTOMER_STATUSES,
  OTP_CHANNELS,
  OTP_PURPOSES,
  PERMISSION_CODES,
  PRINCIPAL_TYPES,
} from '../enums';

import { booleanQuerySchema, idSchema, listQuerySchema } from './common';

/**
 * Single source of truth for auth validation: the backend validates with these, OpenAPI is
 * generated from them, and both frontends infer their types from them. Never redefine them.
 */

/* ------------------------------------------------------------ enum schemas */

export const authRealmSchema = z.enum(AUTH_REALMS);
export const principalTypeSchema = z.enum(PRINCIPAL_TYPES);
export const adminRoleCodeSchema = z.enum(ADMIN_ROLE_CODES);
export const adminUserStatusSchema = z.enum(ADMIN_USER_STATUSES);
export const customerStatusSchema = z.enum(CUSTOMER_STATUSES);
export const otpPurposeSchema = z.enum(OTP_PURPOSES);
export const otpChannelSchema = z.enum(OTP_CHANNELS);
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export const auditSeveritySchema = z.enum(AUDIT_SEVERITIES);
export const permissionSchema = z.enum(PERMISSION_CODES);

/* ------------------------------------------------------------- primitives */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export const emailSchema = z.string().trim().toLowerCase().email().max(200);

/** Indian mobile numbers, stored in E.164 without the `+` (e.g. 919999999999). */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, '').replace(/^\+/, ''))
  .pipe(z.string().regex(/^[1-9][0-9]{7,14}$/, 'invalid phone number'));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4,8}$/, 'invalid code');

/** Opaque, high-entropy token from a reset/verify email. */
export const opaqueTokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

export const displayNameSchema = z.string().trim().min(2).max(120);

/** A seeded or custom role code; whether it exists, is active and may be granted is the service's call. */
export const roleCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'code must be UPPER_SNAKE_CASE');

/* ----------------------------------------------------------- admin realm */

export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  deviceLabel: z.string().trim().max(80).optional(),
});
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: opaqueTokenSchema,
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Browsers must use the httpOnly refresh cookie. The optional body field exists only for REST
 * Client / automated tests and is rejected outright in production.
 */
export const refreshSchema = z.object({
  refreshToken: z.string().trim().min(20).max(200).optional(),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/* ------------------------------------------------ admin user + role admin */

export const adminUserCreateSchema = z.object({
  email: emailSchema,
  name: displayNameSchema,
  phone: phoneSchema.optional(),
  /** Omitted => the user is INVITED and receives a set-password link. */
  password: passwordSchema.optional(),
  roleCodes: z.array(roleCodeSchema).min(1),
});
export type AdminUserCreateInput = z.infer<typeof adminUserCreateSchema>;

export const adminUserUpdateSchema = z
  .object({
    name: displayNameSchema.optional(),
    phone: phoneSchema.nullish(),
    status: adminUserStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type AdminUserUpdateInput = z.infer<typeof adminUserUpdateSchema>;

export const adminUserListQuerySchema = listQuerySchema.extend({
  status: adminUserStatusSchema.optional(),
  search: z.string().trim().max(120).optional(),
});
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const assignRolesSchema = z.object({ roleCodes: z.array(roleCodeSchema).min(1) });
export type AssignRolesInput = z.infer<typeof assignRolesSchema>;

/** Another admin's password, set by someone allowed to manage them; they must change it at sign-in. */
export const adminPasswordSetSchema = z.object({ newPassword: passwordSchema });
export type AdminPasswordSetInput = z.infer<typeof adminPasswordSetSchema>;

export const roleCreateSchema = z.object({
  code: roleCodeSchema,
  name: displayNameSchema,
  description: z.string().trim().max(400).optional(),
  position: z.number().int().min(0).max(999).optional(),
  permissions: z.array(permissionSchema).default([]),
});
export type RoleCreateInput = z.infer<typeof roleCreateSchema>;

export const roleUpdateSchema = z
  .object({
    name: displayNameSchema.optional(),
    description: z.string().trim().max(400).nullish(),
    position: z.number().int().min(0).max(999).optional(),
    isActive: z.boolean().optional(),
    permissions: z.array(permissionSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type RoleUpdateInput = z.infer<typeof roleUpdateSchema>;

/* ----------------------------------------------------------- audit search */

export const auditLogQuerySchema = listQuerySchema.extend({
  actorId: idSchema.optional(),
  actorType: principalTypeSchema.optional(),
  action: auditActionSchema.optional(),
  entity: z.string().trim().max(80).optional(),
  entityId: idSchema.optional(),
  severity: auditSeveritySchema.optional(),
  realm: authRealmSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

/* -------------------------------------------------------- customer realm */

export const customerRegisterSchema = z
  .object({
    name: displayNameSchema,
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    password: passwordSchema.optional(),
    marketingOptIn: z.boolean().default(false),
    acceptsWhatsapp: z.boolean().default(true),
  })
  .refine((value) => Boolean(value.email ?? value.phone), {
    message: 'an email address or a phone number is required',
    path: ['email'],
  })
  .refine((value) => !value.password || Boolean(value.email), {
    message: 'a password login needs an email address',
    path: ['password'],
  });
export type CustomerRegisterInput = z.infer<typeof customerRegisterSchema>;

/** Email or phone — the service resolves which. */
export const customerLoginSchema = z.object({
  identifier: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  deviceLabel: z.string().trim().max(80).optional(),
});
export type CustomerLoginInput = z.infer<typeof customerLoginSchema>;

export const otpRequestSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    purpose: otpPurposeSchema.default('LOGIN'),
    channel: otpChannelSchema.optional(),
  })
  .refine((value) => Boolean(value.email ?? value.phone), {
    message: 'an email address or a phone number is required',
    path: ['phone'],
  });
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  destination: z.string().trim().min(3).max(200),
  code: otpCodeSchema,
  purpose: otpPurposeSchema.default('LOGIN'),
  name: displayNameSchema.optional(),
  deviceLabel: z.string().trim().max(80).optional(),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const customerProfileUpdateSchema = z
  .object({
    name: displayNameSchema.optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    marketingOptIn: z.boolean().optional(),
    acceptsWhatsapp: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type CustomerProfileUpdateInput = z.infer<typeof customerProfileUpdateSchema>;

export const customerForgotPasswordSchema = z.object({ email: emailSchema });

export const emailVerifyRequestSchema = z.object({ email: emailSchema.optional() });
export const emailVerifySchema = z.object({ token: opaqueTokenSchema });

export const sessionListQuerySchema = z.object({
  includeExpired: booleanQuerySchema.default(false),
});
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
