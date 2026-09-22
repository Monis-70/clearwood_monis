import { mediaIdsIn } from '@shared/cms/blockRegistry';
import { isBlockType, type BlockType, type DeviceKind } from '@shared/enums';

import { logger } from '../../config/logger';
import { cmsHydrationRepository, type CmsMediaRow } from '../../repositories/cms.repository';
import { pageRepository, type PageWithBlocks } from '../../repositories/page.repository';
import { storefrontRepository, type ProductCardRow } from '../../repositories/storefront.repository';
import { jsonColumn } from '../../utils/jsonColumn';
import { AppError } from '../../utils/AppError';
import { toProductCard } from '../storefront/card.mapper';
import { productQueryService } from '../storefront/productQuery.service';

import { bannerService } from './banner.service';
import { cmsCacheService } from './cmsCache.service';
import { pageService } from './page.service';

const blockConfig = jsonColumn<Record<string, unknown>>(undefined, 'PageBlock.configJson');

/**
 * THE public read path.
 *
 * The rule that shapes this entire file: hydration costs a FIXED number of queries regardless of
 * how many blocks the page has. A naive renderer loops the blocks and fetches what each one needs,
 * and the homepage — which is the single most requested URL on the site — then costs forty
 * queries. So this works in phases: collect what every block wants, fetch it all in batches, then
 * map. `cms-hydration.test.ts` counts the queries and fails if the budget regresses.
 *
 * Unknown block types are FILTERED, never thrown. A page saved by a newer deployment must not take
 * the storefront down after a rollback.
 */

export interface RenderOptions {
  device?: DeviceKind;
  customerId?: string | null;
  customerGroupId?: string | null;
  /** Admin preview: render drafts and ignore scheduling. */
  preview?: boolean;
}

export interface RenderedBlock {
  id: string;
  type: BlockType;
  position: number;
  anchorId: string | null;
  cssClass: string | null;
  config: Record<string, unknown>;
  data: Record<string, unknown>;
}

export interface RenderedPage {
  id: string;
  slug: string;
  title: string;
  type: string;
  status: string;
  excerpt: string | null;
  seo: {
    title: string;
    description: string | null;
    keywords: string | null;
    canonicalUrl: string | null;
    noIndex: boolean;
    ogMedia: unknown;
  };
  heroMedia: unknown;
  publishedAt: string | null;
  updatedAt: string;
  pricingBasis: string;
  blocks: RenderedBlock[];
}

function mediaDto(row: CmsMediaRow | undefined) {
  if (!row) return null;

  return {
    id: row.id,
    url: row.url,
    width: row.width,
    height: row.height,
    altText: row.altText,
    blurhash: row.blurhash,
    lqip: row.lqipDataUri,
    dominantColorHex: row.dominantColorHex,
    mimeType: row.mimeType,
    sources: row.variants.map((variant) => ({
      label: variant.label,
      path: variant.path,
      width: variant.width,
      height: variant.height,
      format: variant.format,
      deviceTarget: variant.deviceTarget,
    })),
  };
}

function inWindow(startsAt: Date | null, endsAt: Date | null, now: Date): boolean {
  if (startsAt && startsAt > now) return false;
  if (endsAt && endsAt <= now) return false;
  return true;
}

function matchesDevice(visibility: string, device: DeviceKind): boolean {
  if (visibility === 'ALL') return true;
  return visibility === (device === 'MOBILE' ? 'MOBILE_ONLY' : 'DESKTOP_ONLY');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export const pageRendererService = {
  async renderHome(options: RenderOptions = {}): Promise<RenderedPage> {
    const page = await pageRepository.findHome();
    if (!page) throw AppError.notFound('No published home page');

    return this.hydrate(page, options);
  },

  async renderBySlug(slug: string, options: RenderOptions = {}): Promise<RenderedPage> {
    const cacheKey = cmsCacheService.pageKey(
      slug,
      options.customerGroupId ?? null,
      options.device ?? 'DESKTOP',
    );

    if (!options.preview) {
      const cached = await cmsCacheService.get<RenderedPage>(cacheKey);
      if (cached) return cached;
    }

    const page = await pageRepository.findBySlug(slug);
    if (!page) throw AppError.notFound('Page not found', { slug });

    if (!options.preview && !pageService.isLive(page)) {
      // A scheduled page must be invisible before its time, and indistinguishable from absent.
      throw AppError.notFound('Page not found', { slug });
    }

    const rendered = await this.hydrate(page, options);
    if (!options.preview) await cmsCacheService.set(cacheKey, rendered);

    return rendered;
  },

  /* ------------------------------------------------------------ hydrate */

  async hydrate(page: PageWithBlocks, options: RenderOptions = {}): Promise<RenderedPage> {
    const now = new Date();
    const device = options.device ?? 'DESKTOP';

    /* Phase 0 — decide which blocks are in play at all. */
    const live = page.blocks.filter((block) => {
      if (!options.preview && !block.isActive) return false;
      if (!options.preview && !inWindow(block.startsAt, block.endsAt, now)) return false;
      if (!matchesDevice(block.deviceVisibility, device)) return false;

      return true;
    });

    const parsed = live
      .map((block) => ({ block, config: blockConfig.parse(block.configJson, {}) }))
      .filter((entry) => {
        // Filtered, not thrown: a block type this deployment does not know is not an outage.
        if (isBlockType(entry.block.type)) return true;
        logger.warn({ type: entry.block.type }, 'cms: unknown block type filtered out');
        return false;
      });

    /* Phase 1 — collect what every block wants, before fetching anything. */
    const want = {
      media: new Set<string>(),
      categories: new Set<string>(),
      collections: new Set<string>(),
      products: new Set<string>(),
      faqs: new Set<string>(),
      faqVisibilities: new Set<string>(),
      brands: new Set<string>(),
      bannerPlacements: new Set<string>(),
      needsTestimonials: false,
      needsStores: false,
      perCollection: 8,
      perCategory: 8,
      testimonialLimit: 6,
      faqLimit: 6,
    };

    if (page.heroMediaId) want.media.add(page.heroMediaId);
    if (page.ogMediaId) want.media.add(page.ogMediaId);

    for (const { block, config } of parsed) {
      const type = block.type as BlockType;

      for (const id of mediaIdsIn(type, config)) want.media.add(id);

      switch (type) {
        case 'CATEGORY_CIRCLES':
          for (const id of asStrings(config.categoryIds)) want.categories.add(id);
          break;

        case 'FEATURED_COLLECTION':
        case 'COUNTDOWN_DEAL': {
          const id = asString(config.collectionId);
          if (id) want.collections.add(id);
          want.perCollection = Math.max(want.perCollection, asNumber(config.limit, 8));
          break;
        }

        case 'PRODUCT_GRID':
        case 'PRODUCT_CAROUSEL': {
          for (const id of asStrings(config.productIds)) want.products.add(id);

          const collectionId = asString(config.collectionId);
          if (collectionId) want.collections.add(collectionId);

          const categoryId = asString(config.categoryId);
          if (categoryId) want.categories.add(categoryId);

          want.perCollection = Math.max(want.perCollection, asNumber(config.limit, 8));
          want.perCategory = Math.max(want.perCategory, asNumber(config.limit, 8));
          break;
        }

        case 'FAQ_ACCORDION': {
          for (const id of asStrings(config.faqIds)) want.faqs.add(id);

          const visibility = asString(config.visibility);
          if (visibility) want.faqVisibilities.add(visibility);

          want.faqLimit = Math.max(want.faqLimit, asNumber(config.limit, 6));
          break;
        }

        case 'TESTIMONIALS':
          want.needsTestimonials = true;
          want.testimonialLimit = Math.max(want.testimonialLimit, asNumber(config.limit, 6));
          break;

        case 'STORE_LOCATOR':
          want.needsStores = true;
          break;

        case 'BRAND_STRIP':
          for (const id of asStrings(config.brandIds)) want.brands.add(id);
          break;

        case 'HERO_SLIDER':
          want.bannerPlacements.add('HOME_HERO');
          break;

        default:
          break;
      }
    }

    /* Phase 2 — membership lookups, so product ids are known before cards are fetched. */
    const [collectionMembers, categoryMembers] = await Promise.all([
      cmsHydrationRepository.collectionMembers([...want.collections], want.perCollection),
      cmsHydrationRepository.categoryMembers([...want.categories], want.perCategory),
    ]);

    const byCollection = new Map<string, string[]>();
    for (const row of collectionMembers) {
      const list = byCollection.get(row.collectionId) ?? [];
      if (list.length < want.perCollection) list.push(row.productId);
      byCollection.set(row.collectionId, list);
    }

    const byCategory = new Map<string, string[]>();
    for (const row of categoryMembers) {
      const list = byCategory.get(row.categoryId) ?? [];
      if (list.length < want.perCategory) list.push(row.productId);
      byCategory.set(row.categoryId, list);
    }

    for (const ids of [...byCollection.values(), ...byCategory.values()]) {
      for (const id of ids) want.products.add(id);
    }

    /* Phase 3 — every entity the page needs, in parallel batches. */
    const productIds = [...want.products];

    const [cards, media, categories, collections, faqsById, faqsByVisibility, testimonials, stores, brands, banners] =
      await Promise.all([
        productIds.length > 0 ? storefrontRepository.findCards(productIds) : Promise.resolve([]),
        cmsHydrationRepository.mediaByIds([...want.media]),
        cmsHydrationRepository.categoriesByIds([...want.categories]),
        cmsHydrationRepository.collectionsByIds([...want.collections]),
        cmsHydrationRepository.faqsByIds([...want.faqs]),
        cmsHydrationRepository.faqsByVisibility([...want.faqVisibilities], want.faqLimit),
        want.needsTestimonials
          ? cmsHydrationRepository.testimonials(want.testimonialLimit)
          : Promise.resolve([]),
        want.needsStores ? cmsHydrationRepository.stores() : Promise.resolve([]),
        cmsHydrationRepository.brandsByIds([...want.brands]),
        want.bannerPlacements.size > 0
          ? bannerService.forPlacements([...want.bannerPlacements], device, now)
          : Promise.resolve([]),
      ]);

    /* Phase 4 — one batched quote for every product on the page (P6 is the only price path). */
    const identity = { customerId: options.customerId ?? null };

    const [displayPrices, pricingBasis] = await Promise.all([
      productQueryService.resolveDisplayPrices(cards as ProductCardRow[], identity),
      productQueryService.pricingBasis(identity.customerId),
    ]);

    const cardById = new Map(
      (cards as ProductCardRow[]).map((row) => [
        row.id,
        toProductCard(row, {
          pricePaise: displayPrices.get(row.id) ?? row.basePricePaise,
          indexed: { minPricePaise: null, maxPricePaise: null },
        }),
      ]),
    );

    const mediaById = new Map(media.map((row) => [row.id, row]));
    const categoryById = new Map(categories.map((row) => [row.id, row]));
    const collectionById = new Map(collections.map((row) => [row.id, row]));
    const faqById = new Map(faqsById.map((row) => [row.id, row]));
    const brandById = new Map(brands.map((row) => [row.id, row]));

    const cardsFor = (ids: string[], limit: number) =>
      ids
        .map((id) => cardById.get(id))
        .filter((card): card is NonNullable<typeof card> => card !== undefined)
        .slice(0, limit);

    /* Phase 5 — map. No queries beyond this point. */
    const blocks: RenderedBlock[] = parsed.map(({ block, config }) => {
      const type = block.type as BlockType;
      let data: Record<string, unknown> = {};

      switch (type) {
        case 'HERO_SLIDER':
          data = {
            slides: (Array.isArray(config.slides) ? config.slides : []).map((slide) => {
              const entry = slide as Record<string, unknown>;
              return {
                ...entry,
                media: mediaDto(mediaById.get(String(entry.mediaId))),
                mobileMedia: mediaDto(mediaById.get(String(entry.mobileMediaId))),
              };
            }),
            banners,
          };
          break;

        case 'CATEGORY_CIRCLES':
          data = {
            categories: asStrings(config.categoryIds)
              .map((id) => categoryById.get(id))
              .filter((row): row is NonNullable<typeof row> => row !== undefined)
              .map((row) => ({
                id: row.id,
                slug: row.slug,
                name: row.name,
                path: row.path,
                productCount: row.productCountCache,
                icon: mediaDto(mediaById.get(String(row.iconMediaId))),
              })),
          };
          break;

        case 'FEATURED_COLLECTION':
        case 'COUNTDOWN_DEAL': {
          const collectionId = asString(config.collectionId) ?? '';
          const collection = collectionById.get(collectionId);
          const limit = asNumber(config.limit, 8);

          data = {
            collection: collection
              ? {
                  id: collection.id,
                  slug: collection.slug,
                  name: collection.name,
                  description: collection.description,
                  banner: mediaDto(mediaById.get(String(collection.bannerMediaId))),
                }
              : null,
            products: cardsFor(byCollection.get(collectionId) ?? [], limit),
          };
          break;
        }

        case 'PRODUCT_GRID':
        case 'PRODUCT_CAROUSEL': {
          const limit = asNumber(config.limit, 8);
          const explicit = asStrings(config.productIds);

          const ids =
            explicit.length > 0
              ? explicit
              : (byCollection.get(asString(config.collectionId) ?? '') ??
                 byCategory.get(asString(config.categoryId) ?? '') ??
                 []);

          data = { products: cardsFor(ids, limit) };
          break;
        }

        case 'FAQ_ACCORDION': {
          const explicit = asStrings(config.faqIds);
          const limit = asNumber(config.limit, 6);

          const items =
            explicit.length > 0
              ? explicit.map((id) => faqById.get(id)).filter(Boolean)
              : faqsByVisibility.filter((faq) => faq.visibility === asString(config.visibility));

          data = { faqs: items.slice(0, limit) };
          break;
        }

        case 'TESTIMONIALS':
          data = {
            testimonials: testimonials.slice(0, asNumber(config.limit, 6)).map((row) => ({
              id: row.id,
              authorName: row.authorName,
              authorLocation: row.authorLocation,
              authorRole: row.authorRole,
              quote: row.quote,
              ratingBp: row.ratingBp,
              isFeatured: row.isFeatured,
              avatar: mediaDto(mediaById.get(String(row.avatarMediaId))),
            })),
          };
          break;

        case 'STORE_LOCATOR':
          data = { stores };
          break;

        case 'BRAND_STRIP':
          data = {
            brands: asStrings(config.brandIds)
              .map((id) => brandById.get(id))
              .filter(Boolean)
              .map((row) => ({ ...row, logo: mediaDto(mediaById.get(String(row!.logoMediaId))) })),
          };
          break;

        case 'BANNER_FULL':
        case 'IMAGE_WITH_TEXT':
        case 'LEAD_FORM_CTA':
        case 'VIDEO_EMBED':
          data = {
            media: mediaDto(mediaById.get(String(config.mediaId ?? config.posterMediaId))),
            mobileMedia: mediaDto(mediaById.get(String(config.mobileMediaId))),
          };
          break;

        case 'BANNER_SPLIT':
          data = {
            panels: (Array.isArray(config.panels) ? config.panels : []).map((panel) => {
              const entry = panel as Record<string, unknown>;
              return { ...entry, media: mediaDto(mediaById.get(String(entry.mediaId))) };
            }),
          };
          break;

        case 'USP_STRIP':
        case 'TRUST_BADGES':
        case 'INSTAGRAM_GRID':
          data = {
            items: (Array.isArray(config.items) ? config.items : []).map((item) => {
              const entry = item as Record<string, unknown>;
              return {
                ...entry,
                media: mediaDto(mediaById.get(String(entry.mediaId ?? entry.iconMediaId))),
              };
            }),
          };
          break;

        default:
          data = {};
          break;
      }

      return {
        id: block.id,
        type,
        position: block.position,
        anchorId: block.anchorId,
        cssClass: block.cssClass,
        config,
        data,
      };
    });

    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      type: page.type,
      status: page.status,
      excerpt: page.excerpt,
      seo: {
        title: page.seoTitle ?? page.title,
        description: page.seoDescription,
        keywords: page.seoKeywords,
        canonicalUrl: page.canonicalUrl,
        noIndex: page.noIndex,
        ogMedia: mediaDto(mediaById.get(String(page.ogMediaId))),
      },
      heroMedia: mediaDto(mediaById.get(String(page.heroMediaId))),
      publishedAt: page.publishedAt?.toISOString() ?? null,
      updatedAt: page.updatedAt.toISOString(),
      pricingBasis,
      blocks,
    };
  },
};
