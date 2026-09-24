import type { Collection } from '@prisma/client';

import type { MediaUsageType } from '@shared/enums';
import type {
  AdminCollectionListQuery,
  CollectionCreateInput,
  CollectionProductsInput,
  CollectionUpdateInput,
  ReorderInput,
} from '@shared/schemas/catalogAdmin';
import type { CollectionRules } from '@shared/schemas/catalogAdmin';

import { prisma } from '../../config/prisma';
import { notDeleted, pageResult, skipTake, type PageResult } from '../../repositories/helpers';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { ensureUniqueSlug, slugify } from '../../utils/slug';
import { mediaUsageService } from '../media/media-usage.service';
import { collectionRulesService } from '../storefront/collectionRules.service';

import { catalogCacheService } from './catalogCache.service';
import { slugRedirectService } from './slugRedirect.service';

/**
 * Collections. MANUAL ones list products explicitly; AUTOMATIC ones store a validated rule tree.
 *
 * This file only validates and stores `rulesJson`. Evaluating it belongs to
 * `storefront/collectionRules.service`, which compiles the tree to a Prisma filter — one evaluator,
 * so the admin preview and the storefront listing can never disagree.
 */

const rulesColumn = jsonColumn<CollectionRules>(undefined, 'Collection.rulesJson');

const slugOwner = {
  async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const found = await prisma.collection.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  },
};

const MEDIA_FIELDS = [
  ['imageMediaId', 'COLLECTION_IMAGE'],
  ['bannerMediaId', 'COLLECTION_BANNER'],
  ['mobileBannerMediaId', 'COLLECTION_BANNER'],
] as const satisfies readonly (readonly [keyof Collection, MediaUsageType])[];

/** Keeps the usage ledger equal to the three image columns, so a hard delete stays safe. */
async function syncMediaUsage(collection: Collection, previous?: Collection): Promise<void> {
  for (const [field, usageType] of MEDIA_FIELDS) {
    const next = collection[field];
    const before = previous?.[field] ?? null;
    if (next === before) continue;
    if (before) {
      await mediaUsageService.detach({
        mediaId: before,
        usageType,
        entityId: collection.id,
        field,
      });
    }
    if (next) {
      await mediaUsageService.attach({ mediaId: next, usageType, entityId: collection.id, field });
    }
  }
}

/** An automatic collection's membership follows its rules from the moment they change. */
async function evaluateIfAutomatic(collection: Collection): Promise<void> {
  if (collection.type === 'AUTOMATIC' && collection.rulesJson && !collection.deletedAt) {
    await collectionRulesService.evaluate(collection.id);
  }
}

export const collectionAdminService = {
  async list(query: AdminCollectionListQuery): Promise<PageResult<Collection>> {
    const args = { where: query.includeDeleted ? {} : notDeleted };
    const [items, total] = await Promise.all([
      prisma.collection.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ position: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }),
      prisma.collection.count(args),
    ]);
    return pageResult(items, total, query);
  },

  async get(id: string): Promise<Collection> {
    const collection = await prisma.collection.findFirst({ where: { id, ...notDeleted } });
    if (!collection) throw AppError.notFound('Collection not found', { id });
    return collection;
  },

  async create(input: CollectionCreateInput): Promise<Collection> {
    if (input.type === 'AUTOMATIC' && !input.rules) {
      throw AppError.validation('An automatic collection needs rules', { field: 'rules' });
    }

    const slug = await ensureUniqueSlug(slugOwner, slugify(input.slug ?? input.name));
    await slugRedirectService.assertSlugFree('COLLECTION', slug, null);

    const collection = await prisma.collection.create({
      data: {
        name: input.name,
        slug,
        type: input.type,
        description: input.description ?? null,
        rulesJson: rulesColumn.serialize(input.rules ?? null),
        imageMediaId: input.imageMediaId ?? null,
        bannerMediaId: input.bannerMediaId ?? null,
        mobileBannerMediaId: input.mobileBannerMediaId ?? null,
        isActive: input.isActive,
        position: input.position,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
      },
    });

    await syncMediaUsage(collection);
    await catalogCacheService.invalidateCollection();
    await evaluateIfAutomatic(collection);
    return this.get(collection.id);
  },

  async update(id: string, input: CollectionUpdateInput): Promise<Collection> {
    const existing = await this.get(id);
    const { version, slug: requestedSlug, rules, ...rest } = input;

    const nextType = rest.type ?? existing.type;
    const nextRules = rules === undefined ? existing.rulesJson : rules;
    if (nextType === 'AUTOMATIC' && !nextRules) {
      throw AppError.validation('An automatic collection needs rules', { field: 'rules' });
    }
    const effectiveStart = rest.startsAt === undefined ? existing.startsAt : rest.startsAt;
    const effectiveEnd = rest.endsAt === undefined ? existing.endsAt : rest.endsAt;
    if (effectiveStart && effectiveEnd && effectiveEnd <= effectiveStart) {
      throw AppError.validation('endsAt must be after startsAt', { field: 'endsAt' });
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }
    if (rules !== undefined) data.rulesJson = rulesColumn.serialize(rules ?? null);

    let slug = existing.slug;
    if (requestedSlug && slugify(requestedSlug) !== existing.slug) {
      slug = await ensureUniqueSlug(slugOwner, slugify(requestedSlug), id);
      await slugRedirectService.assertSlugFree('COLLECTION', slug, id);
      data.slug = slug;
    }

    await updateVersioned(prisma.collection, 'Collection', id, version, data);

    if (slug !== existing.slug) {
      await slugRedirectService.recordSlugChange('COLLECTION', id, existing.slug, slug);
    }

    const updated = await this.get(id);
    await syncMediaUsage(updated, existing);
    await catalogCacheService.invalidateCollection();
    if (rules !== undefined || rest.type !== undefined) await evaluateIfAutomatic(updated);
    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await prisma.collection.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await mediaUsageService.detachEntity('COLLECTION_BANNER', id);
    await mediaUsageService.detachEntity('COLLECTION_IMAGE', id);
    await catalogCacheService.invalidateCollection();
  },

  /** Undoes a soft delete; the slug was never released, so it is still this collection's. */
  async restore(id: string): Promise<Collection> {
    const collection = await prisma.collection.findUnique({ where: { id } });
    if (!collection) throw AppError.notFound('Collection not found', { id });
    if (!collection.deletedAt) return collection;

    const restored = await prisma.collection.update({
      where: { id },
      data: { deletedAt: null, isActive: true, version: { increment: 1 } },
    });
    await syncMediaUsage(restored);
    await catalogCacheService.invalidateCollection();
    await evaluateIfAutomatic(restored);
    return this.get(id);
  },

  /** MANUAL collections only — an automatic one is defined by its rules. */
  async setProducts(id: string, input: CollectionProductsInput): Promise<number> {
    const collection = await this.get(id);
    if (collection.type !== 'MANUAL') {
      throw new AppError(
        409,
        'COLLECTION_NOT_MANUAL',
        'An automatic collection is defined by its rules, not by a product list',
        { id, type: collection.type },
      );
    }

    const found = await prisma.product.findMany({
      where: { id: { in: input.productIds }, ...notDeleted },
      select: { id: true },
    });
    const known = new Set(found.map((row) => row.id));
    const missing = input.productIds.filter((productId) => !known.has(productId));
    if (missing.length > 0) throw AppError.validation('Unknown product', { productIds: missing });

    await prisma.$transaction(async (tx) => {
      await tx.collectionProduct.deleteMany({ where: { collectionId: id } });
      if (input.productIds.length > 0) {
        await tx.collectionProduct.createMany({
          data: input.productIds.map((productId, index) => ({
            collectionId: id,
            productId,
            position: index,
          })),
        });
      }
    });

    await catalogCacheService.invalidateCollection();
    return input.productIds.length;
  },

  async reorderProducts(id: string, input: ReorderInput): Promise<number> {
    await this.get(id);
    await prisma.$transaction(
      input.items.map((item) =>
        prisma.collectionProduct.updateMany({
          where: { collectionId: id, productId: item.id },
          data: { position: item.position },
        }),
      ),
    );
    await catalogCacheService.invalidateCollection();
    return input.items.length;
  },
};
