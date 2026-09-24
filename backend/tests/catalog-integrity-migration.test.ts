import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { combinationKeyOf } from '../src/modules/catalog-admin/variantOptions';
import { connect, parseUrl, TEST_DB_PREFIX, type AdminUrl } from './helpers/mysqlTemplate';

/**
 * Prompt 3 — the catalog-integrity migration applied to a database that already holds the
 * violations it exists to forbid. Production data predates the constraints, so the remediation
 * must leave every product valid before the unique indexes and CHECKs are created.
 */

const MIGRATIONS = path.join(__dirname, '..', 'prisma', 'migrations');
const sql = (name: string) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

let base: AdminUrl;
let db: mysql.Connection;
const database = `${TEST_DB_PREFIX}mig_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

async function rows<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await db.query(query, params);
  return result as T[];
}

beforeAll(async () => {
  base = parseUrl(process.env.CLEARWOOD_TEST_ADMIN_URL!);
  const server = await connect(base);
  await server.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await server.end();

  db = await connect(base, database);
  await db.query(sql('20260921183056_mysql_initial'));

  // Legacy state: every violation the new constraints forbid, in one product.
  await db.query(`
    INSERT INTO Category (id, name, slug, path, updatedAt) VALUES
      ('c1', 'One', 'one', '/one', NOW(3)), ('c2', 'Two', 'two', '/two', NOW(3));
    INSERT INTO Product (id, sku, slug, name, updatedAt) VALUES ('p1', 'P1', 'live', 'Live', NOW(3));
    INSERT INTO Product (id, sku, slug, name, deletedAt, updatedAt)
      VALUES ('p2', 'P2', 'old-bench', 'Old', NOW(3), NOW(3));
    INSERT INTO Attribute (id, code, name, inputType, updatedAt) VALUES
      ('Zed', 'zed', 'Zed', 'SELECT', NOW(3)), ('abc', 'abc', 'Abc', 'SELECT', NOW(3));
    INSERT INTO AttributeValue (id, attributeId, code, label, updatedAt) VALUES
      ('Zed-1', 'Zed', 'z1', 'Z1', NOW(3)),
      ('abc-1', 'abc', 'a1', 'A1', NOW(3)),
      ('abc-2', 'abc', 'a2', 'A2', NOW(3));
    INSERT INTO ProductVariant (id, productId, sku, position, isDefault, deletedAt, updatedAt) VALUES
      ('v1', 'p1', 'V1', 0, true, NULL, NOW(3)),
      ('v2', 'p1', 'V2', 1, true, NULL, NOW(3)),
      ('v3', 'p1', 'V3', 2, true, NOW(3), NOW(3)),
      ('v5', 'p1', 'V5', 3, false, NULL, NOW(3));
    INSERT INTO VariantAttributeValue (id, variantId, attributeId, attributeValueId, updatedAt) VALUES
      ('x1', 'v1', 'abc', 'abc-1', NOW(3)), ('x2', 'v1', 'Zed', 'Zed-1', NOW(3)),
      ('x3', 'v2', 'Zed', 'Zed-1', NOW(3)), ('x4', 'v2', 'abc', 'abc-1', NOW(3)),
      ('x5', 'v3', 'abc', 'abc-2', NOW(3)),
      ('x6', 'v5', 'abc', 'abc-2', NOW(3));
    INSERT INTO ProductCategory (id, productId, categoryId, isPrimary, position, updatedAt) VALUES
      ('pc1', 'p1', 'c1', true, 0, NOW(3)), ('pc2', 'p1', 'c2', true, 1, NOW(3));
    INSERT INTO Media (id, disk, path, kind, mimeType, originalName, sizeBytes, updatedAt) VALUES
      ('m1', 'local', 'a.png', 'IMAGE', 'image/png', 'a.png', 1, NOW(3)),
      ('m2', 'local', 'b.png', 'IMAGE', 'image/png', 'b.png', 1, NOW(3));
    INSERT INTO ProductMedia (id, productId, mediaId, role, position, updatedAt) VALUES
      ('pm1', 'p1', 'm1', 'PRIMARY', 0, NOW(3)), ('pm2', 'p1', 'm2', 'PRIMARY', 1, NOW(3));
  `);

  await db.query(sql('20260923090000_catalog_integrity'));
}, 120_000);

afterAll(async () => {
  await db?.end();
  const server = await connect(base);
  await server.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await server.end();
});

describe('catalog-integrity migration on legacy data', () => {
  it('keeps one default variant per product: the first by position, never a deleted one', async () => {
    const variants = await rows<{ id: string; isDefault: number; defaultMark: number | null }>(
      'SELECT id, isDefault, defaultMark FROM ProductVariant ORDER BY id',
    );
    expect(variants).toEqual([
      { id: 'v1', isDefault: 1, defaultMark: 1 },
      { id: 'v2', isDefault: 0, defaultMark: null },
      { id: 'v3', isDefault: 0, defaultMark: null },
      { id: 'v5', isDefault: 0, defaultMark: null },
    ]);
  });

  it('computes the same combination key as the application, in binary attribute order', async () => {
    const keys = Object.fromEntries(
      (
        await rows<{ id: string; combinationKey: string | null }>(
          'SELECT id, combinationKey FROM ProductVariant',
        )
      ).map((row) => [row.id, row.combinationKey]),
    );

    expect(keys.v1).toBe(
      combinationKeyOf([
        { attributeId: 'abc', attributeValueId: 'abc-1' },
        { attributeId: 'Zed', attributeValueId: 'Zed-1' },
      ]),
    );
    expect(keys.v5).toBe(combinationKeyOf([{ attributeId: 'abc', attributeValueId: 'abc-2' }]));
    // v2 duplicates v1 and loses its key rather than the migration failing; v3 is deleted.
    expect(keys.v2).toBeNull();
    expect(keys.v3).toBeNull();
  });

  it('keeps one primary category and one primary image, demoting the rest', async () => {
    expect(
      await rows('SELECT id, isPrimary, primaryMark FROM ProductCategory ORDER BY id'),
    ).toEqual([
      { id: 'pc1', isPrimary: 1, primaryMark: 1 },
      { id: 'pc2', isPrimary: 0, primaryMark: null },
    ]);
    expect(await rows('SELECT id, role, primaryMark FROM ProductMedia ORDER BY id')).toEqual([
      { id: 'pm1', role: 'PRIMARY', primaryMark: 1 },
      { id: 'pm2', role: 'GALLERY', primaryMark: null },
    ]);
  });

  it('releases the slugs of soft-deleted products, remembering the original', async () => {
    expect(await rows("SELECT slug, deletedSlug FROM Product WHERE id = 'p2'")).toEqual([
      { slug: 'deleted-p2', deletedSlug: 'old-bench' },
    ]);
    expect(await rows("SELECT slug, deletedSlug FROM Product WHERE id = 'p1'")).toEqual([
      { slug: 'live', deletedSlug: null },
    ]);
  });

  it('leaves the database refusing new violations', async () => {
    await expect(
      db.query(
        "INSERT INTO ProductVariant (id, productId, sku, isDefault, defaultMark, updatedAt) VALUES ('v9', 'p1', 'V9', true, true, NOW(3))",
      ),
    ).rejects.toMatchObject({ errno: 1062 });
    await expect(
      db.query(
        "INSERT INTO ProductVariant (id, productId, sku, isDefault, defaultMark, updatedAt) VALUES ('v9', 'p1', 'V9', true, NULL, NOW(3))",
      ),
    ).rejects.toMatchObject({ errno: 3819 });
    await expect(
      db.query("UPDATE ProductMedia SET role = 'PRIMARY' WHERE id = 'pm2'"),
    ).rejects.toMatchObject({ errno: 3819 });
    await expect(
      db.query('UPDATE ProductVariant SET combinationKey = ? WHERE id = ?', [
        (
          await rows<{ k: string }>(
            "SELECT combinationKey AS k FROM ProductVariant WHERE id = 'v1'",
          )
        )[0]!.k,
        'v2',
      ]),
    ).rejects.toMatchObject({ errno: 1062 });
  });
});
