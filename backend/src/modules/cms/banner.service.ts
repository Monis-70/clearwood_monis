import type {
  AnnouncementCreateInput,
  AnnouncementUpdateInput,
  BannerCreateInput,
  BannerListQuery,
  BannerUpdateInput,
  CmsReorderInput,
} from '@shared/schemas/cms';
import type { DeviceKind } from '@shared/enums';

import { prisma } from '../../config/prisma';
import {
  announcementRepository,
  bannerRepository,
  contentViewRepository,
} from '../../repositories/banner.repository';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { mediaUsageService } from '../media/media-usage.service';

import { cmsCacheService } from './cmsCache.service';

const idList = jsonColumn<string[]>(undefined, 'Banner targets');

function matchesDevice(visibility: string, device: DeviceKind): boolean {
  if (visibility === 'ALL') return true;
  return visibility === (device === 'MOBILE' ? 'MOBILE_ONLY' : 'DESKTOP_ONLY');
}

/**
 * Banners, their placements and the counters behind them.
 *
 * Impressions and clicks are counted into a daily ContentView rollup rather than a row per event:
 * the hero banner on the homepage would otherwise be the fastest-growing table in the database,
 * for a number nobody reads per-second.
 */
export const bannerService = {
  list(query: BannerListQuery) {
    return bannerRepository.list(query);
  },

  async get(id: string) {
    const banner = await bannerRepository.findById(id);
    if (!banner) throw AppError.notFound('Banner not found', { id });
    return banner;
  },

  async create(input: BannerCreateInput) {
    const { targetCategoryIds, targetCollectionIds, ...rest } = input;

    const banner = await bannerRepository.create({
      ...rest,
      mediaId: rest.mediaId ?? null,
      mobileMediaId: rest.mobileMediaId ?? null,
      altText: rest.altText ?? null,
      headline: rest.headline ?? null,
      subheadline: rest.subheadline ?? null,
      ctaLabel: rest.ctaLabel ?? null,
      ctaUrl: rest.ctaUrl ?? null,
      ctaStyle: rest.ctaStyle ?? null,
      backgroundHex: rest.backgroundHex ?? null,
      textHex: rest.textHex ?? null,
      startsAt: rest.startsAt ?? null,
      endsAt: rest.endsAt ?? null,
      targetCategoryIdsJson: idList.serialize(targetCategoryIds ?? null),
      targetCollectionIdsJson: idList.serialize(targetCollectionIds ?? null),
    });

    await this.syncMedia(banner.id, [banner.mediaId, banner.mobileMediaId]);
    await cmsCacheService.invalidateBanners();

    return banner;
  },

  async update(id: string, input: BannerUpdateInput) {
    await this.get(id);
    const { version, targetCategoryIds, targetCollectionIds, ...rest } = input;

    await updateVersioned(prisma.banner, 'Banner', id, version, {
      ...rest,
      ...(targetCategoryIds !== undefined
        ? { targetCategoryIdsJson: idList.serialize(targetCategoryIds ?? null) }
        : {}),
      ...(targetCollectionIds !== undefined
        ? { targetCollectionIdsJson: idList.serialize(targetCollectionIds ?? null) }
        : {}),
    });

    const banner = await this.get(id);
    await this.syncMedia(id, [banner.mediaId, banner.mobileMediaId]);
    await cmsCacheService.invalidateBanners();

    return banner;
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await bannerRepository.softDelete(id);
    await mediaUsageService.detachEntity('CMS_BANNER', id);
    await cmsCacheService.invalidateBanners();
  },

  async reorder(input: CmsReorderInput): Promise<void> {
    await bannerRepository.reorder(input.order);
    await cmsCacheService.invalidateBanners();
  },

  async syncMedia(bannerId: string, ids: (string | null)[]): Promise<void> {
    await mediaUsageService.sync(
      'CMS_BANNER',
      bannerId,
      [...new Set(ids.filter((id): id is string => Boolean(id)))],
    );
  },

  /* ------------------------------------------------------------- public */

  /** Live banners for one placement, filtered by schedule, device and targeting. */
  async forPlacement(
    placement: string,
    device: DeviceKind = 'DESKTOP',
    now = new Date(),
    target: { categoryId?: string; collectionId?: string } = {},
  ) {
    const rows = await bannerRepository.liveForPlacements([placement], now);

    return rows
      .filter((banner) => matchesDevice(banner.deviceVisibility, device))
      .filter((banner) => {
        const categories = idList.parseOrNull(banner.targetCategoryIdsJson);
        const collections = idList.parseOrNull(banner.targetCollectionIdsJson);

        // An empty target list means "everywhere in this placement", not "nowhere".
        if (categories?.length && (!target.categoryId || !categories.includes(target.categoryId))) {
          return false;
        }
        if (
          collections?.length &&
          (!target.collectionId || !collections.includes(target.collectionId))
        ) {
          return false;
        }

        return true;
      })
      .map((banner) => this.toDto(banner));
  },

  /** Several placements in one query, for the page renderer's fixed query budget. */
  async forPlacements(placements: string[], device: DeviceKind, now = new Date()) {
    const rows = await bannerRepository.liveForPlacements(placements, now);

    return rows
      .filter((banner) => matchesDevice(banner.deviceVisibility, device))
      .map((banner) => this.toDto(banner));
  },

  toDto(banner: Awaited<ReturnType<typeof bannerRepository.findById>>) {
    if (!banner) return null;

    return {
      id: banner.id,
      name: banner.name,
      placement: banner.placement,
      mediaId: banner.mediaId,
      mobileMediaId: banner.mobileMediaId,
      altText: banner.altText,
      headline: banner.headline,
      subheadline: banner.subheadline,
      ctaLabel: banner.ctaLabel,
      ctaUrl: banner.ctaUrl,
      ctaStyle: banner.ctaStyle,
      backgroundHex: banner.backgroundHex,
      textHex: banner.textHex,
      position: banner.position,
      deviceVisibility: banner.deviceVisibility,
    };
  },

  /** Fire-and-forget: a counter must never delay or fail the page it was counted on. */
  async recordImpression(id: string): Promise<void> {
    await contentViewRepository.bump('BANNER_IMPRESSION', id);
    await bannerRepository.bumpImpression(id);
  },

  async recordClick(id: string): Promise<void> {
    await contentViewRepository.bump('BANNER_CLICK', id);
    await bannerRepository.bumpClick(id);
  },

  async stats(id: string) {
    const banner = await this.get(id);
    const daily = await contentViewRepository.listFor(['BANNER_IMPRESSION', 'BANNER_CLICK'], id);

    return {
      id: banner.id,
      name: banner.name,
      impressionCount: banner.impressionCount,
      clickCount: banner.clickCount,
      clickThroughBp:
        banner.impressionCount === 0
          ? 0
          : Math.round((banner.clickCount / banner.impressionCount) * 10_000),
      daily,
    };
  },
};

/* ------------------------------------------------------- announcement bar */

export const announcementService = {
  list() {
    return announcementRepository.list();
  },

  async get(id: string) {
    const row = await announcementRepository.findById(id);
    if (!row) throw AppError.notFound('Announcement not found', { id });
    return row;
  },

  async create(input: AnnouncementCreateInput) {
    const row = await announcementRepository.create({
      ...input,
      linkUrl: input.linkUrl ?? null,
      linkLabel: input.linkLabel ?? null,
      backgroundHex: input.backgroundHex ?? null,
      textHex: input.textHex ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    });

    await cmsCacheService.invalidateBanners();
    return row;
  },

  async update(id: string, input: AnnouncementUpdateInput) {
    await this.get(id);
    const { version, ...data } = input;

    await updateVersioned(prisma.announcementBar, 'Announcement', id, version, data);
    await cmsCacheService.invalidateBanners();

    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await announcementRepository.softDelete(id);
    await cmsCacheService.invalidateBanners();
  },

  /** The one bar showing right now, or null. Position breaks ties. */
  async current(device: DeviceKind = 'DESKTOP', now = new Date()) {
    const rows = await announcementRepository.live(now);
    const match = rows.find((row) => matchesDevice(row.deviceVisibility, device));

    if (!match) return null;

    return {
      id: match.id,
      message: match.message,
      linkUrl: match.linkUrl,
      linkLabel: match.linkLabel,
      backgroundHex: match.backgroundHex,
      textHex: match.textHex,
      isDismissible: match.isDismissible,
    };
  },
};
