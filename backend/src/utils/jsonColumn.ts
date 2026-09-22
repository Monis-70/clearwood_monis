import type { ZodType } from 'zod';

import { logger } from '../config/logger';

/**
 * D3 — Prisma's `Json` scalar is forbidden because it behaves differently on SQLite and MySQL.
 * JSON-shaped data lives in a plain `String` column and is read/written through these helpers,
 * optionally guarded by a Zod schema so the shape is validated on the way out of the database.
 */

export interface JsonColumn<T> {
  /** Parses a column value, falling back when it is null/blank/corrupt. */
  parse(raw: string | null | undefined, fallback: T): T;
  /** Parses a column value, returning null when it is absent or invalid. */
  parseOrNull(raw: string | null | undefined): T | null;
  /** Serialises a value for storage; `null`/`undefined` stay null so the column can be optional. */
  serialize(value: T | null | undefined): string | null;
}

export function jsonColumn<T>(schema?: ZodType<T>, label = 'json column'): JsonColumn<T> {
  const decode = (raw: string | null | undefined): T | null => {
    if (raw === null || raw === undefined || raw === '') return null;

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      logger.warn({ label }, 'stored JSON could not be parsed');
      return null;
    }

    if (!schema) return decoded as T;

    const result = schema.safeParse(decoded);
    if (!result.success) {
      logger.warn({ label, issues: result.error.issues }, 'stored JSON failed schema validation');
      return null;
    }
    return result.data;
  };

  return {
    parse(raw, fallback) {
      const value = decode(raw);
      return value === null ? fallback : value;
    },
    parseOrNull: decode,
    serialize(value) {
      if (value === null || value === undefined) return null;
      return JSON.stringify(schema ? schema.parse(value) : value);
    },
  };
}
