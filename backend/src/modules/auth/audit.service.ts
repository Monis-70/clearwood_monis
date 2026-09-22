import type { Request } from 'express';

import type { AuditAction, AuditSeverity, AuthRealm, PrincipalType } from '@shared/enums';
import { isDangerousPermission } from '@shared/enums';
import type { AuditLogQuery } from '@shared/schemas/auth';
import type { AuditLogDto } from '@shared/types/auth';

import { logger } from '../../config/logger';
import { auditLogRepository } from '../../repositories/auditLog.repository';
import type { PageResult } from '../../repositories/helpers';
import { jsonColumn } from '../../utils/jsonColumn';

/**
 * Append-only trail. Writes are fire-and-forget: an audit failure is logged but must never break
 * the request that triggered it.
 */

export interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  severity?: AuditSeverity;
  meta?: Record<string, unknown> | null;
  changes?: AuditChanges | null;
  actorType?: PrincipalType;
  actorId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  realm?: AuthRealm | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditChanges {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

const metaColumn = jsonColumn<Record<string, unknown>>(undefined, 'AuditLog.meta');
const changesColumn = jsonColumn<AuditChanges>(undefined, 'AuditLog.changesJson');

const DEFAULT_SEVERITY: Partial<Record<AuditAction, AuditSeverity>> = {
  DELETE: 'WARNING',
  LOGIN_FAILED: 'NOTICE',
  PERMISSION_DENIED: 'WARNING',
  TOKEN_REUSE_DETECTED: 'CRITICAL',
  ROLE_ASSIGNED: 'NOTICE',
  ROLE_REVOKED: 'NOTICE',
  PASSWORD_RESET: 'NOTICE',
  SESSION_REVOKED: 'NOTICE',
  EXPORT: 'NOTICE',
};

export function clientIp(req: Request): string | null {
  return req.ip ?? req.socket.remoteAddress ?? null;
}

/** Shallow before/after diff — only the keys that actually changed reach `changesJson`. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditChanges | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key.toLowerCase().includes('password') || key.toLowerCase().includes('secret')) continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;

    changedBefore[key] = before[key] ?? null;
    changedAfter[key] = after[key] ?? null;
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : { before: changedBefore, after: changedAfter };
}

export const auditService = {
  diff,

  async record(entry: AuditEntry): Promise<void> {
    try {
      await auditLogRepository.create({
        actorType: entry.actorType ?? 'SYSTEM',
        actorId: entry.actorId ?? null,
        actorName: entry.actorName ?? null,
        actorEmail: entry.actorEmail ?? null,
        realm: entry.realm ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        severity: entry.severity ?? DEFAULT_SEVERITY[entry.action] ?? 'INFO',
        requestId: entry.requestId ?? null,
        meta: metaColumn.serialize(entry.meta ?? null),
        changesJson: changesColumn.serialize(entry.changes ?? null),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      });
    } catch (error) {
      logger.error(
        { err: error, entry: { action: entry.action, entity: entry.entity } },
        'audit write failed',
      );
    }
  },

  /** Fills actor, realm, ip, user agent and traceId from the request. */
  async recordFromRequest(req: Request, entry: AuditEntry): Promise<void> {
    const auth = req.auth;

    await this.record({
      actorType: auth?.principalType ?? entry.actorType ?? 'SYSTEM',
      actorId: auth?.principalId ?? entry.actorId ?? null,
      actorName: auth?.displayName ?? entry.actorName ?? null,
      actorEmail: auth?.email ?? entry.actorEmail ?? null,
      realm: auth?.realm ?? entry.realm ?? null,
      requestId: req.requestId ?? null,
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? null,
      ...entry,
    });
  },

  /**
   * Wraps a write so Prompt 5's CRUD services get an audit row for free:
   * `withAudit(req, { action: 'UPDATE', entity: 'Category' }, before, () => repo.update(...))`.
   */
  async withAudit<T extends Record<string, unknown>>(
    req: Request,
    entry: Omit<AuditEntry, 'changes'>,
    before: Record<string, unknown>,
    write: () => Promise<T>,
  ): Promise<T> {
    const after = await write();

    void this.recordFromRequest(req, {
      ...entry,
      entityId: entry.entityId ?? (after.id as string | undefined) ?? null,
      changes: diff(before, after),
    });

    return after;
  },

  severityForPermission(code: string): AuditSeverity {
    return isDangerousPermission(code) ? 'CRITICAL' : 'WARNING';
  },

  async list(query: AuditLogQuery): Promise<PageResult<AuditLogDto>> {
    const page = await auditLogRepository.list(query);

    return {
      ...page,
      items: page.items.map((row) => ({
        id: row.id,
        actorType: row.actorType as PrincipalType,
        actorId: row.actorId,
        actorName: row.actorName,
        actorEmail: row.actorEmail,
        realm: row.realm as AuthRealm | null,
        action: row.action as AuditAction,
        entity: row.entity,
        entityId: row.entityId,
        severity: row.severity as AuditSeverity,
        requestId: row.requestId,
        ip: row.ip,
        userAgent: row.userAgent,
        meta: metaColumn.parseOrNull(row.meta),
        changes: changesColumn.parseOrNull(row.changesJson),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  },
};
