import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, parseUrl, TEST_DB_PREFIX, type AdminUrl } from './helpers/mysqlTemplate';

/**
 * Prompt 4 - the listing index migration on a database that already has priced search documents:
 * the storefront must keep its price order across the deploy, before any reindex runs.
 */

const MIGRATIONS = path.join(__dirname, '..', 'prisma', 'migrations');
const sql = (name: string) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

let base: AdminUrl;
let db: mysql.Connection;
const database = `${TEST_DB_PREFIX}mig_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

beforeAll(async () => {
  base = parseUrl(process.env.CLEARWOOD_TEST_ADMIN_URL!);
  const server = await connect(base);
  await server.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await server.end();

  db = await connect(base, database);
  await db.query(sql('20260921183056_mysql_initial'));
  await db.query(sql('20260923090000_catalog_integrity'));

  await db.query(`
    INSERT INTO Product (id, sku, slug, name, status, updatedAt) VALUES
      ('live', 'L1', 'live', 'Live', 'ACTIVE', NOW(3)),
      ('gone', 'G1', 'deleted-gone', 'Gone', 'ARCHIVED', NOW(3)),
      ('fresh', 'F1', 'fresh', 'Fresh', 'ACTIVE', NOW(3));
    UPDATE Product SET deletedAt = NOW(3) WHERE id = 'gone';
    INSERT INTO SearchDocument (id, entityType, entityId, title, bodyText, keywordsText,
      categoryText, attributeText, slug, minPricePaise, maxPricePaise, checksum) VALUES
      ('d1', 'PRODUCT', 'live', 'Live', '', '', '', '', 'live', 120000, 180000, 'x'),
      ('d2', 'PRODUCT', 'gone', 'Gone', '', '', '', '', 'gone', 5000, 5000, 'y'),
      ('d3', 'CATEGORY', 'live', 'Not a product', '', '', '', '', 'c', 1, 1, 'z');
  `);

  await db.query(sql('20260924090000_product_listing_index'));

  // Prompt 5: specs and variant options for the attribute projection's backfill.
  await db.query(`
    INSERT INTO Attribute (id, code, name, inputType, updatedAt) VALUES
      ('colour', 'COLOUR', 'Colour', 'SELECT', NOW(3)), ('wood', 'WOOD', 'Wood', 'SELECT', NOW(3));
    INSERT INTO AttributeValue (id, attributeId, code, label, updatedAt) VALUES
      ('red', 'colour', 'red', 'Red', NOW(3)), ('blue', 'colour', 'blue', 'Blue', NOW(3)),
      ('teak', 'wood', 'teak', 'Teak', NOW(3));
    INSERT INTO ProductAttributeValue (id, productId, attributeId, attributeValueId, updatedAt) VALUES
      ('s1', 'live', 'wood', 'teak', NOW(3)), ('s2', 'fresh', 'wood', 'teak', NOW(3));
    INSERT INTO ProductVariant (id, productId, sku, isActive, updatedAt) VALUES
      ('v1', 'live', 'L1-R', TRUE, NOW(3)), ('v2', 'live', 'L1-R2', TRUE, NOW(3)),
      ('v3', 'live', 'L1-B', FALSE, NOW(3));
    INSERT INTO VariantAttributeValue (id, variantId, attributeId, attributeValueId, updatedAt) VALUES
      ('o1', 'v1', 'colour', 'red', NOW(3)), ('o2', 'v2', 'colour', 'red', NOW(3)),
      ('o3', 'v3', 'colour', 'blue', NOW(3));
  `);
  await db.query(sql('20260924120000_maintenance_task'));
  await db.query(sql('20260924130000_product_listing_attribute'));
}, 120_000);

afterAll(async () => {
  await db?.end();
  const server = await connect(base);
  await server.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await server.end();
});

describe('product listing index migration', () => {
  it('copies product prices from the search index, and nothing else', async () => {
    const [rows] = await db.query(
      'SELECT productId, minPricePaise, maxPricePaise FROM ProductListingIndex ORDER BY productId',
    );
    // The soft-deleted product and the category document are skipped; `fresh` waits for a reindex.
    expect(rows).toEqual([{ productId: 'live', minPricePaise: 120000, maxPricePaise: 180000 }]);
  });

  it("backfills each indexed product's specs and active-variant options, once each", async () => {
    const [rows] = await db.query(
      'SELECT productId, attributeId, attributeValueId FROM ProductListingAttribute ORDER BY productId, attributeValueId',
    );
    // Two variants share `red` (one row); the inactive variant's `blue` and the unindexed
    // product's spec are left for the first refresh.
    expect(rows).toEqual([
      { productId: 'live', attributeId: 'colour', attributeValueId: 'red' },
      { productId: 'live', attributeId: 'wood', attributeValueId: 'teak' },
    ]);
  });

  it('creates the maintenance lease table with one row per job name', async () => {
    await db.query(
      "INSERT INTO MaintenanceTask (id, name, updatedAt) VALUES ('t1', 'listing-index', NOW(3))",
    );
    await expect(
      db.query(
        "INSERT INTO MaintenanceTask (id, name, updatedAt) VALUES ('t2', 'listing-index', NOW(3))",
      ),
    ).rejects.toMatchObject({ errno: 1062 });
  });

  it('keeps one row per product and follows the product on delete', async () => {
    await expect(
      db.query(
        "INSERT INTO ProductListingIndex (id, productId, computedAt, updatedAt) VALUES ('dup', 'live', NOW(3), NOW(3))",
      ),
    ).rejects.toMatchObject({ errno: 1062 });
    await expect(
      db.query(
        "INSERT INTO ProductListingAttribute (id, productId, attributeId, attributeValueId, updatedAt) VALUES ('dup', 'live', 'wood', 'teak', NOW(3))",
      ),
    ).rejects.toMatchObject({ errno: 1062 });

    await db.query("DELETE FROM Product WHERE id = 'live'");
    const [rows] = await db.query('SELECT COUNT(*) AS n FROM ProductListingIndex');
    expect(rows).toEqual([{ n: 0 }]);
    const [values] = await db.query('SELECT COUNT(*) AS n FROM ProductListingAttribute');
    expect(values).toEqual([{ n: 0 }]);
  });
});
