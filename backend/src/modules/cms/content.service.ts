import type {
  CmsReorderInput,
  ContentSettingsInput,
  NavigationItemCreateInput,
  NavigationItemUpdateInput,
  StoreCreateInput,
  StoreUpdateInput,
  TestimonialCreateInput,
  TestimonialUpdateInput,
} from '@shared/schemas/cms';

import { prisma } from '../../config/prisma';
import {
  navigationAdminRepository,
  settingWriteRepository,
  storeRepository,
  testimonialRepository,
} from '../../repositories/content.repository';
import { updateVersioned } from '../../repositories/versioned';
import { settingService } from '../../services/setting.service';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { catalogCacheService } from '../catalog-admin/catalogCache.service';
import { mediaUsageService } from '../media/media-usage.service';

import { cmsCacheService } from './cmsCache.service';

const idList = jsonColumn<string[]>(undefined, 'media id list');
const hours = jsonColumn<unknown[]>(undefined, 'StoreLocation.openingHoursJson');

const MAX_NAV_DEPTH = 3;

export const testimonialService = {
  list(filter: { featured?: boolean; includeInactive?: boolean } = {}) {
    return testimonialRepository.list(filter);
  },

  async get(id: string) {
    const row = await testimonialRepository.findById(id);
    if (!row) throw AppError.notFound('Testimonial not found', { id });
    return row;
  },

  async create(input: TestimonialCreateInput) {
    const { mediaIds, ...rest } = input;

    const row = await testimonialRepository.create({
      ...rest,
      authorLocation: rest.authorLocation ?? null,
      authorRole: rest.authorRole ?? null,
      avatarMediaId: rest.avatarMediaId ?? null,
      ratingBp: rest.ratingBp ?? null,
      productId: rest.productId ?? null,
      capturedAt: rest.capturedAt ?? null,
      mediaIdsJson: idList.serialize(mediaIds ?? null),
    });

    await this.syncMedia(row.id, [row.avatarMediaId, ...(mediaIds ?? [])]);
    await cmsCacheService.invalidatePages();

    return row;
  },

  async update(id: string, input: TestimonialUpdateInput) {
    await this.get(id);
    const { version, mediaIds, ...rest } = input;

    await updateVersioned(prisma.testimonial, 'Testimonial', id, version, {
      ...rest,
      ...(mediaIds !== undefined ? { mediaIdsJson: idList.serialize(mediaIds ?? null) } : {}),
    });

    const row = await this.get(id);
    await this.syncMedia(id, [row.avatarMediaId, ...(idList.parseOrNull(row.mediaIdsJson) ?? [])]);
    await cmsCacheService.invalidatePages();

    return row;
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await testimonialRepository.softDelete(id);
    await mediaUsageService.detachEntity('CMS_PAGE', id);
    await cmsCacheService.invalidatePages();
  },

  async reorder(input: CmsReorderInput): Promise<void> {
    await testimonialRepository.reorder(input.order);
    await cmsCacheService.invalidatePages();
  },

  async syncMedia(id: string, ids: (string | null | undefined)[]): Promise<void> {
    await mediaUsageService.sync(
      'CMS_PAGE',
      id,
      [...new Set(ids.filter((entry): entry is string => Boolean(entry)))],
    );
  },
};

export const storeService = {
  list(includeInactive = false) {
    return storeRepository.list(includeInactive);
  },

  async get(id: string) {
    const row = await storeRepository.findById(id);
    if (!row) throw AppError.notFound('Store not found', { id });
    return row;
  },

  async create(input: StoreCreateInput) {
    const clash = await storeRepository.slugExists(input.slug, null);
    if (clash) throw new AppError(409, 'SLUG_TAKEN', `Another store uses "${input.slug}"`, input);

    const { openingHours, mediaIds, ...rest } = input;

    const row = await storeRepository.create({
      ...rest,
      addressLine2: rest.addressLine2 ?? null,
      phone: rest.phone ?? null,
      email: rest.email ?? null,
      mapsUrl: rest.mapsUrl ?? null,
      latitude: rest.latitude ?? null,
      longitude: rest.longitude ?? null,
      openingHoursJson: hours.serialize(openingHours ?? null),
      mediaIdsJson: idList.serialize(mediaIds ?? null),
    });

    await cmsCacheService.invalidatePages();
    return row;
  },

  async update(id: string, input: StoreUpdateInput) {
    const existing = await this.get(id);
    const { version, openingHours, mediaIds, ...rest } = input;

    if (rest.slug && rest.slug !== existing.slug) {
      const clash = await storeRepository.slugExists(rest.slug, id);
      if (clash) throw new AppError(409, 'SLUG_TAKEN', `Another store uses "${rest.slug}"`, rest);
    }

    await updateVersioned(prisma.storeLocation, 'StoreLocation', id, version, {
      ...rest,
      ...(openingHours !== undefined ? { openingHoursJson: hours.serialize(openingHours ?? null) } : {}),
      ...(mediaIds !== undefined ? { mediaIdsJson: idList.serialize(mediaIds ?? null) } : {}),
    });

    await cmsCacheService.invalidatePages();
    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await storeRepository.softDelete(id);
    await cmsCacheService.invalidatePages();
  },

  async reorder(input: CmsReorderInput): Promise<void> {
    await storeRepository.reorder(input.order);
    await cmsCacheService.invalidatePages();
  },
};

/* ------------------------------------------------------------- navigation */

/**
 * Admin CRUD over the EXISTING NavigationMenu / NavigationItem models from Prompt 2.
 *
 * The validation here is the whole point of the service: a menu item is a link a customer will
 * click, so it must point at something that exists. A CATEGORY item with a deleted category, or a
 * PAGE item pointing at a draft, is a 404 in the main navigation — the most visible place on the
 * site to have one.
 */
export const navigationAdminService = {
  listMenus() {
    return navigationAdminRepository.listMenus();
  },

  async menu(key: string) {
    const menu = await navigationAdminRepository.findMenu(key);
    if (!menu) throw AppError.notFound('Navigation menu not found', { key });

    return { ...menu, items: await navigationAdminRepository.itemsForMenu(menu.id) };
  },

  /** Resolves and checks the target, returning the columns to store. */
  async resolveTarget(
    input: NavigationItemCreateInput | NavigationItemUpdateInput,
    currentType?: string,
  ): Promise<Record<string, unknown>> {
    const type = input.type ?? currentType;

    switch (type) {
      case 'CATEGORY': {
        if (!input.categoryId) throw AppError.validation('A CATEGORY item needs a categoryId');

        const category = await navigationAdminRepository.categoryExists(input.categoryId);
        if (!category) {
          throw AppError.validation('That category does not exist or is not live', {
            categoryId: input.categoryId,
          });
        }

        return { categoryId: input.categoryId, collectionId: null, url: null, leadFormKey: null };
      }

      case 'COLLECTION': {
        if (!input.collectionId) throw AppError.validation('A COLLECTION item needs a collectionId');

        const collection = await navigationAdminRepository.collectionExists(input.collectionId);
        if (!collection) {
          throw AppError.validation('That collection does not exist or is not live', {
            collectionId: input.collectionId,
          });
        }

        return { collectionId: input.collectionId, categoryId: null, url: null, leadFormKey: null };
      }

      case 'PAGE': {
        if (!input.pageSlug) throw AppError.validation('A PAGE item needs a pageSlug');

        const page = await navigationAdminRepository.publishedPage(input.pageSlug);
        if (!page) {
          throw AppError.validation('That page is not published', { pageSlug: input.pageSlug });
        }

        // The existing model has no pageId column, so the slug is stored as the url (D-rule: wire
        // the existing columns, add none).
        return {
          url: `/${page.slug}`,
          categoryId: null,
          collectionId: null,
          leadFormKey: null,
        };
      }

      case 'LEAD_FORM': {
        if (!input.leadFormKey) throw AppError.validation('A LEAD_FORM item needs a leadFormKey');

        // 10B registers the forms; any non-empty key is accepted until then.
        return {
          leadFormKey: input.leadFormKey,
          categoryId: null,
          collectionId: null,
          url: null,
        };
      }

      case 'URL': {
        if (!input.url) throw AppError.validation('A URL item needs a url');

        // The schema already refuses anything that is not relative or https, which is what keeps
        // `javascript:` out of the navigation.
        return { url: input.url, categoryId: null, collectionId: null, leadFormKey: null };
      }

      default:
        throw AppError.validation(`Unknown navigation item type "${String(type)}"`);
    }
  },

  async depthOf(parentId: string | null): Promise<number> {
    let depth = 0;
    let cursor = parentId;

    while (cursor) {
      const parent = await navigationAdminRepository.findItem(cursor);
      if (!parent) break;

      depth += 1;
      cursor = parent.parentId;

      if (depth > MAX_NAV_DEPTH + 1) break;
    }

    return depth;
  },

  async createItem(key: string, input: NavigationItemCreateInput) {
    const menu = await navigationAdminRepository.findMenu(key);
    if (!menu) throw AppError.notFound('Navigation menu not found', { key });

    const depth = await this.depthOf(input.parentId ?? null);
    if (depth >= MAX_NAV_DEPTH) {
      throw AppError.validation(`Navigation may nest ${MAX_NAV_DEPTH} levels deep`, {
        depth: depth + 1,
        max: MAX_NAV_DEPTH,
      });
    }

    const target = await this.resolveTarget(input);
    // pageSlug is consumed by resolveTarget (it becomes `url`); it is not a column.
    const { pageSlug: _pageSlug, ...rest } = input;

    const item = await navigationAdminRepository.createItem({
      ...rest,
      menuId: menu.id,
      parentId: input.parentId ?? null,
      badgeText: input.badgeText ?? null,
      badgeColor: input.badgeColor ?? null,
      iconMediaId: input.iconMediaId ?? null,
      menuColumn: input.menuColumn ?? null,
      ...target,
    } as never);

    await catalogCacheService.invalidateNavigation();
    return item;
  },

  async updateItem(id: string, input: NavigationItemUpdateInput) {
    const existing = await navigationAdminRepository.findItem(id);
    if (!existing) throw AppError.notFound('Navigation item not found', { id });

    const touchesTarget =
      input.type !== undefined ||
      input.categoryId !== undefined ||
      input.collectionId !== undefined ||
      input.url !== undefined ||
      input.leadFormKey !== undefined ||
      input.pageSlug !== undefined;

    const target = touchesTarget ? await this.resolveTarget(input, existing.type) : {};
    const { pageSlug: _pageSlug, parentId, ...rest } = input;

    if (parentId !== undefined && parentId !== existing.parentId) {
      const depth = await this.depthOf(parentId ?? null);
      if (depth >= MAX_NAV_DEPTH) {
        throw AppError.validation(`Navigation may nest ${MAX_NAV_DEPTH} levels deep`, {
          depth: depth + 1,
          max: MAX_NAV_DEPTH,
        });
      }
      if (parentId === id) {
        throw new AppError(409, 'NAVIGATION_CYCLE', 'An item cannot be its own parent', { id });
      }
    }

    const item = await navigationAdminRepository.updateItem(id, {
      ...rest,
      ...(parentId !== undefined ? { parentId: parentId ?? null } : {}),
      ...target,
    } as never);

    await catalogCacheService.invalidateNavigation();
    return item;
  },

  async removeItem(id: string): Promise<void> {
    const existing = await navigationAdminRepository.findItem(id);
    if (!existing) throw AppError.notFound('Navigation item not found', { id });

    // Cascade would take the children silently; saying so is better than surprising an editor.
    const children = await navigationAdminRepository.childCount(id);
    if (children > 0) {
      throw new AppError(409, 'NAVIGATION_HAS_CHILDREN', 'Move or delete the sub-items first', {
        children,
      });
    }

    await navigationAdminRepository.deleteItem(id);
    await catalogCacheService.invalidateNavigation();
  },

  async reorder(key: string, input: CmsReorderInput): Promise<void> {
    const menu = await navigationAdminRepository.findMenu(key);
    if (!menu) throw AppError.notFound('Navigation menu not found', { key });

    await navigationAdminRepository.reorder(menu.id, input.order);
    await catalogCacheService.invalidateNavigation();
  },
};

/* ---------------------------------------------------------- site settings */

/** The keys an admin may write through the content screen. Anything else is refused. */
const WRITABLE_SETTINGS = new Set([
  'site.contact_phone',
  'site.whatsapp_number',
  'site.support_email',
  'site.address',
  'site.gstin_display',
  'site.social.instagram',
  'site.social.facebook',
  'site.social.youtube',
  'site.social.pinterest',
  'site.social.linkedin',
  'site.business_hours',
  'site.announcement_enabled',
  'site.newsletter_enabled',
  'site.usp_lines',
  'seo.default_title_template',
  'seo.default_description',
  'seo.og_default_media_id',
  'seo.robots_extra',
  'seo.google_site_verification',
  'cms.whitelisted_iframe_hosts',
]);

export const siteSettingsService = {
  async get(): Promise<Record<string, unknown>> {
    const [content, seo, cms] = await Promise.all([
      settingService.getGroup('content'),
      settingService.getGroup('seo'),
      settingService.getGroup('cms'),
    ]);

    return { ...content, ...seo, ...cms };
  },

  /**
   * Writes only whitelisted keys. An open key/value writer over AppSetting would let the content
   * screen change the payment or pricing configuration, which is emphatically not content.
   */
  async set(input: ContentSettingsInput): Promise<Record<string, unknown>> {
    const rejected = Object.keys(input).filter((key) => !WRITABLE_SETTINGS.has(key));

    if (rejected.length > 0) {
      throw AppError.validation('These settings are not editable from the content screen', {
        rejected,
        writable: [...WRITABLE_SETTINGS],
      });
    }

    const existing = await settingWriteRepository.findByKeys(Object.keys(input));
    const typeOf = new Map(existing.map((row) => [row.key, row]));

    for (const [key, value] of Object.entries(input)) {
      const current = typeOf.get(key);
      const valueType =
        current?.valueType ??
        (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string');

      const serialised =
        valueType === 'json' ? JSON.stringify(value) : value === null ? '' : String(value);

      await settingWriteRepository.upsert(
        key,
        serialised,
        valueType,
        current?.group ?? (key.startsWith('seo.') ? 'seo' : key.startsWith('cms.') ? 'cms' : 'content'),
        current?.isPublic ?? !key.startsWith('cms.'),
      );
    }

    await settingService.invalidate();
    await cmsCacheService.invalidateSettings();

    return this.get();
  },
};
