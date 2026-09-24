import { execSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { passwordService } from '../src/modules/auth/password.service';

/**
 * The suite's database is created by tests/global-setup.ts, which runs the seed once. This file
 * runs it a second time and proves nothing is duplicated and nothing editorial is overwritten.
 */

const SEEDED_MODELS = [
  'appSetting',
  'taxClass',
  'attributeGroup',
  'attribute',
  'attributeValue',
  'category',
  'categoryAttribute',
  'collection',
  'navigationMenu',
  'navigationItem',
  'media',
  'product',
  'productCategory',
  'productAttributeValue',
  'productVariant',
  'variantAttributeValue',
  'productMedia',
  'priceAdjustment',
  'adminUser',
  'adminUserRole',
  'customerGroup',
  'brand',
  'searchSynonym',
] as const;

type SeededModel = (typeof SEEDED_MODELS)[number];

async function rowCounts(): Promise<Record<SeededModel, number>> {
  const entries = await Promise.all(
    SEEDED_MODELS.map(async (model) => {
      const delegate = prisma[model] as unknown as { count(): Promise<number> };
      return [model, await delegate.count()] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SeededModel, number>;
}

function runSeed(): void {
  execSync('npx prisma db seed', {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Inherited, never hardcoded: global-setup allocates a unique database per run.
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      SEED_DEMO: 'true',
      LOG_LEVEL: 'silent',
    },
    stdio: 'pipe',
  });
}

const EDITED_NAME = 'Sofas — edited by an admin';
let originalName = 'Sofas';

/** Structural edits an admin makes between two deploys; the re-seed must keep every one. */
const ADMIN_EDITS = {
  deactivated: 'gaming-chairs',
  reordered: 'diwans',
  moved: 'swing-sofas',
  movedTo: 'chairs',
  deleted: 'furniture-hooks',
  unlinkedFrom: 'furniture-pillows',
  unlinkedAttribute: 'PACK_SIZE',
  retunedAttribute: 'ARM_STYLE',
} as const;
const REORDERED_POSITION = 97;

/** Catalog and pricing configuration an admin retuned or removed between two deploys. */
const CONFIG_EDITS = {
  retunedTaxClass: 'GST_12',
  formerDefaultTaxClass: 'GST_18',
  deletedTaxClass: 'GST_0',
  retunedGroup: 'TRADE',
  formerDefaultGroup: 'RETAIL',
  deletedGroup: 'VIP',
  repositionedBrand: 'clearwood-signature',
  deletedBrand: 'clearwood-outdoor',
  editedSynonym: 'sofa',
  deletedSynonym: 'teak',
  setting: 'catalog.new_arrival_days',
  renamedCollection: { from: 'deals-of-the-week', to: 'weekly-deals' },
} as const;

interface ConfigSnapshot {
  deletedNavItemIds: string[];
  deletedNavTargets: { menuId: string; categoryId: string | null; url: string | null }[];
  deletedAttributeGroupCode: string;
  unbrandedProductId: string;
}
let config: ConfigSnapshot;

/** The bootstrap admin comes from the same env the seed read. */
const BOOTSTRAP_EMAIL = env.ADMIN_SEED_EMAIL.trim().toLowerCase();
const OPERATOR_RENAME = 'Owner renamed by an operator';

interface BootstrapSnapshot {
  id: string;
  name: string;
  status: string;
  mustChangePassword: boolean;
  passwordHash: string;
  roles: string[];
}

/**
 * Every admin-owned knob the seed also writes on a fresh install, changed or removed the way the
 * admin API would. Hard deletes (menu items, attribute groups, synonyms) leave no row behind, which
 * is exactly the case a seed can mistake for "missing".
 */
async function retuneConfiguration(): Promise<ConfigSnapshot> {
  await prisma.taxClass.update({
    where: { code: CONFIG_EDITS.retunedTaxClass },
    data: { rateBp: 1250, hsnCode: '9999', isDefault: true },
  });
  await prisma.taxClass.update({
    where: { code: CONFIG_EDITS.formerDefaultTaxClass },
    data: { isDefault: false },
  });
  await prisma.taxClass.update({
    where: { code: CONFIG_EDITS.deletedTaxClass },
    data: { deletedAt: new Date(), isActive: false },
  });

  await prisma.customerGroup.update({
    where: { code: CONFIG_EDITS.formerDefaultGroup },
    data: { isDefault: false },
  });
  await prisma.customerGroup.update({
    where: { code: CONFIG_EDITS.retunedGroup },
    data: { isDefault: true, priority: REORDERED_POSITION },
  });
  await prisma.customerGroup.update({
    where: { code: CONFIG_EDITS.deletedGroup },
    data: { deletedAt: new Date(), isActive: false },
  });

  await prisma.brand.update({
    where: { slug: CONFIG_EDITS.repositionedBrand },
    data: { position: REORDERED_POSITION },
  });
  await prisma.brand.update({
    where: { slug: CONFIG_EDITS.deletedBrand },
    data: { deletedAt: new Date(), isActive: false },
  });
  const branded = await prisma.product.findFirstOrThrow({
    where: { brandId: { not: null }, deletedAt: null },
    select: { id: true },
    orderBy: { sku: 'asc' },
  });
  await prisma.product.update({ where: { id: branded.id }, data: { brandId: null } });

  await prisma.appSetting.update({ where: { key: CONFIG_EDITS.setting }, data: { value: '7' } });

  await prisma.searchSynonym.update({
    where: { term: CONFIG_EDITS.editedSynonym },
    data: { synonymsJson: JSON.stringify(['couch']) },
  });
  await prisma.searchSynonym.delete({ where: { term: CONFIG_EDITS.deletedSynonym } });

  const { from, to } = CONFIG_EDITS.renamedCollection;
  const collection = await prisma.collection.update({
    where: { slug: from },
    data: { slug: to },
  });
  await prisma.slugRedirect.create({
    data: { entityType: 'COLLECTION', fromSlug: from, toSlug: to, entityId: collection.id },
  });

  // Leaves only, so a delete removes exactly one row: a mega-menu category and a footer page.
  const leaves = await Promise.all([
    prisma.navigationItem.findFirstOrThrow({
      where: {
        menu: { key: 'MAIN' },
        type: 'CATEGORY',
        parentId: { not: null },
        categoryId: { not: null },
        children: { none: {} },
      },
      orderBy: { id: 'asc' },
    }),
    prisma.navigationItem.findFirstOrThrow({
      where: { menu: { key: 'FOOTER_PRIMARY' }, url: '/track-order', children: { none: {} } },
    }),
  ]);
  await prisma.navigationItem.deleteMany({ where: { id: { in: leaves.map((row) => row.id) } } });

  // An admin empties a group, then deletes it (the API hard-deletes groups).
  const group = await prisma.attributeGroup.findFirstOrThrow({ orderBy: { code: 'asc' } });
  await prisma.attribute.updateMany({ where: { groupId: group.id }, data: { groupId: null } });
  await prisma.attributeGroup.delete({ where: { id: group.id } });

  return {
    deletedNavItemIds: leaves.map((row) => row.id),
    deletedNavTargets: leaves.map((row) => ({
      menuId: row.menuId,
      categoryId: row.categoryId,
      url: row.url,
    })),
    deletedAttributeGroupCode: group.code,
    unbrandedProductId: branded.id,
  };
}

async function bootstrapAdmin(): Promise<BootstrapSnapshot> {
  const row = await prisma.adminUser.findUniqueOrThrow({
    where: { email: BOOTSTRAP_EMAIL },
    include: { roles: { include: { role: true } } },
  });

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    passwordHash: row.passwordHash,
    roles: row.roles.map((assignment) => assignment.role.code).sort(),
  };
}

describe('seed idempotency', () => {
  let before: Record<SeededModel, number>;
  let asSeeded: BootstrapSnapshot;
  let superAdminHoldersAsSeeded = -1;

  beforeAll(async () => {
    asSeeded = await bootstrapAdmin();
    superAdminHoldersAsSeeded = await prisma.adminUserRole.count({
      where: { role: { code: 'SUPER_ADMIN' } },
    });

    // An operator renames the bootstrap account and moves it to another role before the re-seed.
    const contentManager = await prisma.role.findUniqueOrThrow({
      where: { code: 'CONTENT_MANAGER' },
    });
    await prisma.adminUser.update({ where: { id: asSeeded.id }, data: { name: OPERATOR_RENAME } });
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: asSeeded.id } });
    await prisma.adminUserRole.create({
      data: { adminUserId: asSeeded.id, roleId: contentManager.id },
    });

    before = await rowCounts();

    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    originalName = sofas.name;
    await prisma.category.update({ where: { id: sofas.id }, data: { name: EDITED_NAME } });

    // Structure, not just copy: the create-only seed must leave all of this alone.
    const bySlug = (slug: string) => prisma.category.findUniqueOrThrow({ where: { slug } });
    await prisma.category.update({
      where: { slug: ADMIN_EDITS.deactivated },
      data: { isActive: false },
    });
    await prisma.category.update({
      where: { slug: ADMIN_EDITS.reordered },
      data: { position: REORDERED_POSITION },
    });
    const target = await bySlug(ADMIN_EDITS.movedTo);
    await prisma.category.update({
      where: { slug: ADMIN_EDITS.moved },
      data: {
        parentId: target.id,
        path: `${target.path}/${ADMIN_EDITS.moved}`,
        depth: target.depth + 1,
      },
    });
    await prisma.category.update({
      where: { slug: ADMIN_EDITS.deleted },
      data: { deletedAt: new Date(), isActive: false },
    });
    const pillows = await bySlug(ADMIN_EDITS.unlinkedFrom);
    const packSize = await prisma.attribute.findUniqueOrThrow({
      where: { code: ADMIN_EDITS.unlinkedAttribute },
    });
    await prisma.categoryAttribute.delete({
      where: { categoryId_attributeId: { categoryId: pillows.id, attributeId: packSize.id } },
    });
    await prisma.attribute.update({
      where: { code: ADMIN_EDITS.retunedAttribute },
      data: { isFilterable: false, position: REORDERED_POSITION },
    });
    before = { ...before, categoryAttribute: before.categoryAttribute - 1 };

    config = await retuneConfiguration();
    before = {
      ...before,
      navigationItem: before.navigationItem - config.deletedNavItemIds.length,
      attributeGroup: before.attributeGroup - 1,
      searchSynonym: before.searchSynonym - 1,
    };

    runSeed();
  }, 180_000);

  afterAll(async () => {
    await prisma.category.update({ where: { slug: 'sofas' }, data: { name: originalName } });
  });

  it('does not create a single duplicate row in any seeded table', async () => {
    /**
     * G1: `after === before` also holds when every table is empty and the seed silently did
     * nothing. Prove the snapshot describes a populated database first.
     */
    const empty = Object.entries(before)
      .filter(([, count]) => count === 0)
      .map(([model]) => model);

    expect(Object.keys(before).length, 'no tables were counted').toBeGreaterThanOrEqual(18);
    expect(empty, 'these seeded tables have no rows, so comparing them proves nothing').toEqual([]);

    expect(await rowCounts()).toStrictEqual(before);
  });

  it('seeded the expected number of categories from the site map', () => {
    expect(before.category).toBe(160);
  });

  it('preserves an admin-edited category name (R8)', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    expect(sofas.name).toBe(EDITED_NAME);
  });

  it('leaves the structure an admin changed exactly as the admin left it', async () => {
    const row = (slug: string) => prisma.category.findUniqueOrThrow({ where: { slug } });

    expect((await row(ADMIN_EDITS.deactivated)).isActive).toBe(false);
    expect((await row(ADMIN_EDITS.reordered)).position).toBe(REORDERED_POSITION);

    const moved = await row(ADMIN_EDITS.moved);
    expect(moved.path).toBe(`${ADMIN_EDITS.movedTo}/${ADMIN_EDITS.moved}`);
    expect(moved.depth).toBe(1);

    // A deleted category is not resurrected, and no second row takes its slug.
    const deleted = await row(ADMIN_EDITS.deleted);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isActive).toBe(false);

    // A removed attribute link stays removed; a retuned attribute keeps its flags.
    const pillows = await row(ADMIN_EDITS.unlinkedFrom);
    const packSize = await prisma.attribute.findUniqueOrThrow({
      where: { code: ADMIN_EDITS.unlinkedAttribute },
    });
    expect(
      await prisma.categoryAttribute.count({
        where: { categoryId: pillows.id, attributeId: packSize.id },
      }),
    ).toBe(0);
    const retuned = await prisma.attribute.findUniqueOrThrow({
      where: { code: ADMIN_EDITS.retunedAttribute },
    });
    expect(retuned.isFilterable).toBe(false);
    expect(retuned.position).toBe(REORDERED_POSITION);
  });

  it('keeps retuned tax classes, their single default and a deleted class as the admin left them', async () => {
    const byCode = (code: string) => prisma.taxClass.findUniqueOrThrow({ where: { code } });

    const retuned = await byCode(CONFIG_EDITS.retunedTaxClass);
    expect(retuned.rateBp).toBe(1250);
    expect(retuned.hsnCode).toBe('9999');
    expect(retuned.isDefault).toBe(true);
    expect((await byCode(CONFIG_EDITS.formerDefaultTaxClass)).isDefault).toBe(false);
    expect(await prisma.taxClass.count({ where: { isDefault: true, deletedAt: null } })).toBe(1);

    const deleted = await byCode(CONFIG_EDITS.deletedTaxClass);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isActive).toBe(false);
  });

  it('keeps the default customer group, a retuned priority and a deleted group', async () => {
    const byCode = (code: string) => prisma.customerGroup.findUniqueOrThrow({ where: { code } });

    const retuned = await byCode(CONFIG_EDITS.retunedGroup);
    expect(retuned.isDefault).toBe(true);
    expect(retuned.priority).toBe(REORDERED_POSITION);
    expect((await byCode(CONFIG_EDITS.formerDefaultGroup)).isDefault).toBe(false);
    expect(await prisma.customerGroup.count({ where: { isDefault: true, deletedAt: null } })).toBe(
      1,
    );
    expect((await byCode(CONFIG_EDITS.deletedGroup)).deletedAt).not.toBeNull();
  });

  it('never re-adds a menu entry an admin deleted', async () => {
    expect(
      await prisma.navigationItem.count({ where: { id: { in: config.deletedNavItemIds } } }),
    ).toBe(0);

    for (const target of config.deletedNavTargets) {
      expect(
        await prisma.navigationItem.count({
          where: {
            menuId: target.menuId,
            ...(target.categoryId ? { categoryId: target.categoryId } : { url: target.url }),
          },
        }),
        `menu entry for ${target.categoryId ?? target.url}`,
      ).toBe(0);
    }
  });

  it('keeps setting values, edited and deleted synonyms, brands and a renamed collection', async () => {
    const setting = await prisma.appSetting.findUniqueOrThrow({
      where: { key: CONFIG_EDITS.setting },
    });
    expect(setting.value).toBe('7');

    const synonym = await prisma.searchSynonym.findUniqueOrThrow({
      where: { term: CONFIG_EDITS.editedSynonym },
    });
    expect(JSON.parse(synonym.synonymsJson)).toEqual(['couch']);
    expect(await prisma.searchSynonym.count({ where: { term: CONFIG_EDITS.deletedSynonym } })).toBe(
      0,
    );

    const repositioned = await prisma.brand.findUniqueOrThrow({
      where: { slug: CONFIG_EDITS.repositionedBrand },
    });
    expect(repositioned.position).toBe(REORDERED_POSITION);
    const deletedBrand = await prisma.brand.findUniqueOrThrow({
      where: { slug: CONFIG_EDITS.deletedBrand },
    });
    expect(deletedBrand.deletedAt).not.toBeNull();
    const unbranded = await prisma.product.findUniqueOrThrow({
      where: { id: config.unbrandedProductId },
    });
    expect(unbranded.brandId).toBeNull();

    const { from, to } = CONFIG_EDITS.renamedCollection;
    expect(await prisma.collection.count({ where: { slug: from } })).toBe(0);
    expect(await prisma.collection.count({ where: { slug: to } })).toBe(1);

    expect(
      await prisma.attributeGroup.count({ where: { code: config.deletedAttributeGroupCode } }),
    ).toBe(0);
  });

  it('still gives the untouched site map its seeded shape', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    expect(sofas.path).toBe('sofas');
    expect(sofas.depth).toBe(0);
    expect(sofas.kind).toBe('STANDARD');

    const contract = await prisma.category.findUniqueOrThrow({
      where: { slug: 'contract-based-work' },
    });
    expect(contract.kind).toBe('SERVICE');
    expect(contract.leadFormKey).toBe('contract-work');
  });

  it('created exactly one bootstrap admin from env, as an ordinary ADMIN', async () => {
    expect(asSeeded.roles).toEqual(['ADMIN']);
    expect(asSeeded.status).toBe('ACTIVE');
    expect(asSeeded.mustChangePassword).toBe(true);
    expect(asSeeded.name).toBe(env.ADMIN_SEED_NAME.trim());
    expect(await passwordService.verify(asSeeded.passwordHash, env.ADMIN_SEED_PASSWORD)).toBe(true);

    // Nobody is SUPER_ADMIN on a freshly seeded database.
    expect(superAdminHoldersAsSeeded).toBe(0);
  });

  it('leaves an existing bootstrap admin exactly as the operator left it', async () => {
    const after = await bootstrapAdmin();

    expect(after.id).toBe(asSeeded.id);
    expect(after.name).toBe(OPERATOR_RENAME);
    // Not re-granted ADMIN, and certainly not SUPER_ADMIN.
    expect(after.roles).toEqual(['CONTENT_MANAGER']);
    // The password was not reset back to ADMIN_SEED_PASSWORD's hash.
    expect(after.passwordHash).toBe(asSeeded.passwordHash);

    expect(await prisma.adminUser.count({ where: { email: BOOTSTRAP_EMAIL } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: 'CREATE', entity: 'AdminUser', entityId: asSeeded.id },
      }),
    ).toBe(1);
  });
});
