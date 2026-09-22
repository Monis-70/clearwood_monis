import type { AuthRealm, Permission, PrincipalType } from '@shared/enums';

/** Attached by the `authenticate(realm)` / `optionalAuth(realm)` middleware. */
export interface AuthContext {
  realm: AuthRealm;
  principalType: PrincipalType;
  principalId: string;
  /** The loaded AdminUser or Customer row — never serialised straight into a response. */
  principal: Record<string, unknown>;
  permissions: Permission[];
  roles: string[];
  isSuperAdmin: boolean;
  /** Refresh-token family id: the stable session identifier. */
  sessionId: string;
  displayName: string | null;
  email: string | null;
}

/** Correlation id attached by the requestId middleware and echoed as `traceId` in every error. */
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
    }
  }
}

export {};
