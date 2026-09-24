import type { SearchEntityType } from '@shared/enums';
import type { ResolveResultDto } from '@shared/types/storefront';

import { logger } from '../../config/logger';
import {
  resolveRepository,
  slugRedirectRepository,
} from '../../repositories/searchAnalytics.repository';
import { isReachable } from '../../repositories/storefront.repository';
import { categoryService } from '../../services/category.service';

/**
 * One endpoint that tells the router what a path is.
 *
 * Prompt 5 has been writing SlugRedirect rows since the first rename; this is what finally serves
 * them. Chains were already flattened on write, so a lookup is one hop — but the loop guard below
 * stays, because a redirect table is exactly the kind of thing that grows a cycle one day.
 */

const MAX_HOPS = 3;

const ENTITY_PREFIX: Record<SearchEntityType, string> = {
  PRODUCT: '/products',
  CATEGORY: '',
  COLLECTION: '/collections',
  BRAND: '/brands',
  PAGE: '',
  HELP_ARTICLE: '/help/articles',
};

/** Entity kinds the storefront router has a page for. */
const RESOLVABLE = new Set<SearchEntityType>(['PRODUCT', 'CATEGORY', 'COLLECTION', 'PAGE']);

function lastSegment(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

export const redirectService = {
  async resolvePath(path: string): Promise<ResolveResultDto> {
    const normalised = path.startsWith('/') ? path : `/${path}`;
    const slug = lastSegment(normalised);

    if (!slug) {
      return {
        type: 'NOT_FOUND',
        path: normalised,
        entity: null,
        redirectTo: null,
        statusCode: 404,
      };
    }

    const direct = await this.findEntity(slug);
    if (direct) {
      return {
        // BRAND and HELP_ARTICLE have no router entry of their own yet.
        type: RESOLVABLE.has(direct.type) ? (direct.type as ResolveResultDto['type']) : 'NOT_FOUND',
        path: normalised,
        entity: direct,
        redirectTo: null,
        statusCode: 200,
      };
    }

    let currentSlug = slug;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const redirect = await slugRedirectRepository.findAnyBySlug(currentSlug);
      if (!redirect) break;

      void slugRedirectRepository
        .touch(redirect.id)
        .catch((error: unknown) => logger.debug({ err: error }, 'redirect hit counter skipped'));

      const target = await this.findEntity(redirect.toSlug);
      if (target) {
        return {
          type: 'REDIRECT',
          path: normalised,
          entity: target,
          redirectTo: `${ENTITY_PREFIX[target.type]}/${target.slug}`,
          statusCode: redirect.statusCode,
        };
      }

      currentSlug = redirect.toSlug;
    }

    return { type: 'NOT_FOUND', path: normalised, entity: null, redirectTo: null, statusCode: 404 };
  },

  async findEntity(
    slug: string,
  ): Promise<{ id: string; slug: string; name: string; type: SearchEntityType } | null> {
    const product = await resolveRepository.findProductBySlug(slug);
    if (product && isReachable(product)) {
      return { id: product.id, slug: product.slug, name: product.name, type: 'PRODUCT' };
    }

    const category = await resolveRepository.findCategoryBySlug(slug);
    if (category && (await categoryService.liveIds()).has(category.id)) {
      return { ...category, type: 'CATEGORY' };
    }

    const collection = await resolveRepository.findCollectionBySlug(slug);
    if (collection) return { ...collection, type: 'COLLECTION' };

    return null;
  },
};
