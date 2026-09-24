import type { Brand } from '@prisma/client';

import type {
  BrandCreateInput,
  BrandListQuery,
  BrandUpdateInput,
} from '@shared/schemas/catalogAdmin';

import { prisma } from '../../config/prisma';
import { catalogEvents } from '../../events/catalogEvents';
import { notDeleted, pageResult, skipTake, type PageResult } from '../../repositories/helpers';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';
import { ensureUniqueSlug, slugify } from '../../utils/slug';
import { mediaUsageService } from '../media/media-usage.service';

import { catalogCacheService } from './catalogCache.service';

const slugOwner = {
  async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const found = await prisma.brand.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  },
};

export const brandAdminService = {
  async list(query: BrandListQuery): Promise<PageResult<Brand>> {
    const args = {
      where: {
        ...notDeleted,
        ...(query.includeInactive ? {} : { isActive: true }),
        ...(query.q
          ? { OR: [{ name: { contains: query.q } }, { slug: { contains: query.q } }] }
          : {}),
      },
    };

    const [items, total] = await Promise.all([
      prisma.brand.findMany({
        ...args,
        ...skipTake(query),
        orderBy: [{ position: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }),
      prisma.brand.count(args),
    ]);

    return pageResult(items, total, query);
  },

  async get(id: string): Promise<Brand> {
    const brand = await prisma.brand.findFirst({ where: { id, ...notDeleted } });
    if (!brand) throw AppError.notFound('Brand not found', { id });
    return brand;
  },

  async create(input: BrandCreateInput): Promise<Brand> {
    const slug = await ensureUniqueSlug(slugOwner, slugify(input.slug ?? input.name));

    const brand = await prisma.brand.create({
      data: {
        name: input.name,
        slug,
        logoMediaId: input.logoMediaId ?? null,
        description: input.description ?? null,
        isActive: input.isActive,
        position: input.position,
      },
    });

    if (brand.logoMediaId) {
      await mediaUsageService.attach({
        mediaId: brand.logoMediaId,
        usageType: 'BRAND_LOGO',
        entityId: brand.id,
        field: 'logoMediaId',
      });
    }

    await catalogCacheService.invalidateProduct();
    catalogEvents.emit('brand.changed', { brandId: brand.id, reason: 'create' });
    return brand;
  },

  async update(id: string, input: BrandUpdateInput): Promise<Brand> {
    const existing = await this.get(id);
    const { version, slug: requestedSlug, ...rest } = input;

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) data[key] = value;
    }
    if (requestedSlug && slugify(requestedSlug) !== existing.slug) {
      data.slug = await ensureUniqueSlug(slugOwner, slugify(requestedSlug), id);
    }

    await updateVersioned(prisma.brand, 'Brand', id, version, data);
    const updated = await this.get(id);

    if (updated.logoMediaId !== existing.logoMediaId) {
      if (existing.logoMediaId) {
        await mediaUsageService.detach({
          mediaId: existing.logoMediaId,
          usageType: 'BRAND_LOGO',
          entityId: id,
          field: 'logoMediaId',
        });
      }
      if (updated.logoMediaId) {
        await mediaUsageService.attach({
          mediaId: updated.logoMediaId,
          usageType: 'BRAND_LOGO',
          entityId: id,
          field: 'logoMediaId',
        });
      }
    }

    await catalogCacheService.invalidateProduct();
    catalogEvents.emit('brand.changed', { brandId: id, reason: 'update' });
    return updated;
  },

  async remove(id: string): Promise<void> {
    await this.get(id);

    const products = await prisma.product.count({ where: { brandId: id, ...notDeleted } });
    if (products > 0) {
      throw new AppError(409, 'BRAND_IN_USE', 'Products are still assigned to this brand', {
        id,
        products,
      });
    }

    await prisma.brand.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await catalogCacheService.invalidateProduct();
    catalogEvents.emit('brand.changed', { brandId: id, reason: 'delete' });
  },
};
