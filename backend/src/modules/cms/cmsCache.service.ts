import { env } from '../../config/env';
import { cache } from '../../container';
import { CATALOG_CACHE_PREFIXES, catalogCacheService } from '../catalog-admin/catalogCache.service';
import { settingService } from '../../services/setting.service';

import { DEFAULT_IFRAME_HOSTS } from './htmlSanitizer';

/**
 * CMS caching, over the one key map in catalogCache.service.
 *
 * A rendered page is cached per (slug, customer group, device) because all three change what comes
 * back: group changes prices inside product blocks, device drops whole blocks. Caching on slug
 * alone would serve a wholesale customer retail prices, which is the kind of bug that gets
 * noticed by the wrong person.
 */

export const CMS_CACHE = CATALOG_CACHE_PREFIXES;

export const cmsCacheService = {
  /** `audience` is productQueryService.pricingAudience's key: a page shows quoted card prices. */
  pageKey(slug: string, audience: string | null, device: string): string {
    return `${CMS_CACHE.cmsPage}${slug}:${audience ?? 'anon'}:${device}`;
  },

  bannerKey(placement: string, device: string): string {
    return `${CMS_CACHE.cmsBanner}${placement}:${device}`;
  },

  faqKey(scope: string): string {
    return `${CMS_CACHE.cmsFaq}${scope}`;
  },

  helpKey(scope: string): string {
    return `${CMS_CACHE.cmsHelp}${scope}`;
  },

  sitemapKey(section: string, page: number): string {
    return `${CMS_CACHE.cmsSitemap}${section}:${page}`;
  },

  ttl(): number {
    return env.CMS_CACHE_TTL_SECONDS;
  },

  /** Read-through; with CMS_CACHE_TTL_SECONDS=0 every call renders. */
  async wrap<T>(key: string, producer: () => Promise<T>): Promise<T> {
    if (env.CMS_CACHE_TTL_SECONDS === 0) return producer();
    return cache.wrap(key, env.CMS_CACHE_TTL_SECONDS, producer);
  },

  /** Hosts an embedded iframe may point at, from settings, merged with the built-in defaults. */
  async iframeHosts(): Promise<string[]> {
    const raw = await settingService.getValue('cms.whitelisted_iframe_hosts');
    const extra =
      typeof raw === 'string'
        ? raw.split(',').map((host) => host.trim()).filter(Boolean)
        : Array.isArray(raw)
          ? raw.filter((host): host is string => typeof host === 'string')
          : [];

    return [...new Set([...DEFAULT_IFRAME_HOSTS, ...extra])];
  },

  invalidatePages: () => catalogCacheService.invalidateCmsPages(),
  invalidateBanners: () => catalogCacheService.invalidateCmsBanners(),
  invalidateFaqs: () => catalogCacheService.invalidateCmsFaqs(),
  invalidateHelp: () => catalogCacheService.invalidateCmsHelp(),
  invalidateSettings: () => catalogCacheService.invalidateCmsSettings(),
};
