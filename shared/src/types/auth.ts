import type {
  AdminUserStatus,
  AuditAction,
  AuditSeverity,
  AuthRealm,
  CustomerStatus,
  Permission,
  PrincipalType,
} from '../enums';

/** Auth DTOs — the exact shapes the API returns and both frontends consume. */

export interface PermissionDto {
  id: string;
  code: string;
  name: string;
  group: string;
  description: string | null;
  isDangerous: boolean;
}

export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  position: number;
  isActive: boolean;
  permissionCount: number;
  permissions?: string[];
}

export interface AdminUserDto {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: AdminUserStatus;
  avatarMediaId: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { id: string; code: string; name: string }[];
}

export interface AdminMeDto {
  user: AdminUserDto;
  roles: string[];
  /** Effective union across every assigned role; SUPER_ADMIN receives the full list. */
  permissions: Permission[];
  mustChangePassword: boolean;
}

export interface CustomerDto {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: CustomerStatus;
  emailVerified: boolean;
  phoneVerified: boolean;
  marketingOptIn: boolean;
  acceptsWhatsapp: boolean;
  avatarMediaId: string | null;
  referralCode: string | null;
  createdAt: string;
}

export interface CustomerMeDto {
  customer: CustomerDto;
}

export interface SessionDto {
  id: string;
  familyId: string;
  deviceLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  isCurrent: boolean;
}

export interface AuditLogDto {
  id: string;
  actorType: PrincipalType;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  realm: AuthRealm | null;
  action: AuditAction;
  entity: string;
  entityId: string | null;
  severity: AuditSeverity;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  meta: unknown | null;
  changes: unknown | null;
  createdAt: string;
}

/** Returned by every login/refresh. The refresh token itself is NEVER in the body. */
export interface AuthTokensDto {
  accessToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface AdminLoginResponse extends AdminMeDto {
  tokens: AuthTokensDto;
}

export interface CustomerLoginResponse extends CustomerMeDto {
  tokens: AuthTokensDto;
  isNewAccount?: boolean;
}

export interface OtpRequestResponse {
  destination: string;
  channel: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  /** Development convenience only — never present when NODE_ENV=production. */
  devCode?: string;
}
