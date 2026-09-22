import {
  BLOCK_REGISTRY,
  mediaIdsIn,
  publishSchemaFor,
  referencesIn,
  type ReferenceKind,
} from '@shared/cms/blockRegistry';
import { isBlockType, type BlockType } from '@shared/enums';

import { logger } from '../../config/logger';
import { cmsReferenceRepository } from '../../repositories/cms.repository';
import { AppError } from '../../utils/AppError';

import { sanitizeRichHtml } from './htmlSanitizer';

/**
 * Block config validation, in one place, for all twenty-two types.
 *
 * Nothing here switches on the block type. The registry declares where each type keeps its media
 * ids and entity references as config PATHS, so this file walks those paths generically. That is
 * the whole reason the registry stores paths rather than the services storing knowledge: a new
 * block type gets referential integrity and MediaUsage syncing for free.
 */

/** Config keys whose value is markup and must be sanitised before storage. */
const HTML_FIELDS: Partial<Record<BlockType, string[]>> = {
  CUSTOM_HTML: ['html'],
  RICH_TEXT: ['html'],
};

export interface ValidatedBlock {
  type: BlockType;
  config: Record<string, unknown>;
  /** The admin's original input, kept only when sanitising changed something. */
  rawConfig: Record<string, unknown> | null;
  mediaIds: string[];
  references: Record<ReferenceKind, string[]>;
}

export interface ValidateOptions {
  iframeHosts?: readonly string[];
  /** Apply the stricter publish schema and check that every reference still exists. */
  forPublish?: boolean;
}

export const blockValidator = {
  /**
   * Parses and sanitises one block config. Throws 422 with the failing path on a bad config.
   *
   * Does NOT hit the database — reference existence is checked by `assertReferencesExist`, which
   * is batched across a whole page so publishing forty blocks is a handful of queries, not forty.
   */
  validate(type: string, rawInput: unknown, options: ValidateOptions = {}): ValidatedBlock {
    if (!isBlockType(type)) {
      throw AppError.validation(`Unknown block type "${type}"`, {
        type,
        known: Object.keys(BLOCK_REGISTRY),
      });
    }

    const schema = options.forPublish ? publishSchemaFor(type) : BLOCK_REGISTRY[type].configSchema;
    const parsed = schema.safeParse(rawInput ?? {});

    if (!parsed.success) {
      throw AppError.validation(`Block ${type} has an invalid config`, {
        type,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const config = parsed.data as Record<string, unknown>;
    let rawConfig: Record<string, unknown> | null = null;

    for (const field of HTML_FIELDS[type] ?? []) {
      const value = config[field];
      if (typeof value !== 'string' || value === '') continue;

      const clean = sanitizeRichHtml(value, { iframeHosts: options.iframeHosts });
      if (clean !== value) {
        // Keep what they wrote so the editor does not silently rewrite their work under them.
        rawConfig = { ...(rawConfig ?? {}), [field]: value };
        logger.info({ type, field }, 'cms: block markup was sanitised on save');
      }
      config[field] = clean;
    }

    return {
      type,
      config,
      rawConfig,
      mediaIds: mediaIdsIn(type, config),
      references: referencesIn(type, config),
    };
  },

  /**
   * One batched existence check across every block on a page.
   *
   * An admin must not be able to publish a page whose hero points at a deleted product: the
   * storefront would render a gap, or worse a 500, and nobody would know until a customer said so.
   */
  async assertReferencesExist(blocks: ValidatedBlock[]): Promise<void> {
    const wanted: Record<ReferenceKind, Set<string>> = {
      categoryIds: new Set(),
      collectionIds: new Set(),
      productIds: new Set(),
      faqIds: new Set(),
    };

    for (const block of blocks) {
      for (const kind of Object.keys(wanted) as ReferenceKind[]) {
        for (const id of block.references[kind]) wanted[kind].add(id);
      }
    }

    const [categories, collections, products, faqs] = await Promise.all([
      cmsReferenceRepository.liveCategoryIds([...wanted.categoryIds]),
      cmsReferenceRepository.liveCollectionIds([...wanted.collectionIds]),
      cmsReferenceRepository.liveProductIds([...wanted.productIds]),
      cmsReferenceRepository.liveFaqIds([...wanted.faqIds]),
    ]);

    const found: Record<ReferenceKind, Set<string>> = {
      categoryIds: new Set(categories),
      collectionIds: new Set(collections),
      productIds: new Set(products),
      faqIds: new Set(faqs),
    };

    const missing: { kind: ReferenceKind; blockType: BlockType; ids: string[] }[] = [];

    for (const block of blocks) {
      for (const kind of Object.keys(found) as ReferenceKind[]) {
        const gone = block.references[kind].filter((id) => !found[kind].has(id));
        if (gone.length > 0) missing.push({ kind, blockType: block.type, ids: gone });
      }
    }

    if (missing.length > 0) {
      throw AppError.validation(
        'Some blocks point at entities that no longer exist or are no longer live',
        { missing },
      );
    }
  },

  /** Every media id on a page, for one MediaUsage sync per page rather than one per block. */
  mediaIdsFor(blocks: ValidatedBlock[]): string[] {
    return [...new Set(blocks.flatMap((block) => block.mediaIds))];
  },

  /** Refuses a page with more of one block type than the registry allows. */
  assertWithinPerTypeCaps(blocks: { type: BlockType }[]): void {
    const counts = new Map<BlockType, number>();
    for (const block of blocks) counts.set(block.type, (counts.get(block.type) ?? 0) + 1);

    for (const [type, count] of counts) {
      const max = BLOCK_REGISTRY[type].maxPerPage;
      if (max !== undefined && count > max) {
        throw AppError.validation(`A page may have at most ${max} ${type} block(s)`, {
          type,
          count,
          max,
        });
      }
    }
  },
};
