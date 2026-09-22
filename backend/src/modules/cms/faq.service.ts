import MarkdownIt from 'markdown-it';

import type {
  CmsReorderInput,
  FaqCategoryCreateInput,
  FaqCategoryUpdateInput,
  FaqCreateInput,
  FaqPublicQuery,
  FaqUpdateInput,
  HelpArticleCreateInput,
  HelpArticleUpdateInput,
  HelpCategoryCreateInput,
  HelpCategoryUpdateInput,
} from '@shared/schemas/cms';

import { prisma } from '../../config/prisma';
import { faqRepository, helpRepository } from '../../repositories/faq.repository';
import { updateVersioned } from '../../repositories/versioned';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';
import { buildPath, depthFor, recomputeSubtree } from '../../utils/materializedPath';
import { mediaUsageService } from '../media/media-usage.service';

import { cmsCacheService } from './cmsCache.service';
import { sanitizeRichHtml, toPlainText } from './htmlSanitizer';

const idList = jsonColumn<string[]>(undefined, 'FAQ/help targets');

const MAX_HELP_DEPTH = 2;

/** The help tree uses the same materialised-path machinery as the category tree (Prompt 2). */
const HELP_PATH_OPTIONS = {
  maxDepth: MAX_HELP_DEPTH,
  entity: 'Help category',
  cycleCode: 'HELP_CATEGORY_CYCLE',
};

const helpPathAdapter = {
  async load(id: string) {
    const row = await helpRepository.findCategory(id);
    return row
      ? { id: row.id, slug: row.slug, parentId: row.parentId, path: row.path, depth: row.depth }
      : null;
  },
  async children(parentId: string) {
    const rows = await helpRepository.categoryChildren(parentId);
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      parentId: row.parentId,
      path: row.path,
      depth: row.depth,
    }));
  },
  save(id: string, path: string, depth: number) {
    return helpRepository.updateCategory(id, { path, depth });
  },
};

/** `html: false` — markdown is admin input, so raw HTML in it goes through the sanitiser anyway. */
const markdown = new MarkdownIt({ html: true, linkify: true, breaks: false });

export const faqService = {
  /* --------------------------------------------------------- categories */

  listCategories(includeInactive = false) {
    return faqRepository.listCategories(includeInactive);
  },

  async createCategory(input: FaqCategoryCreateInput) {
    const row = await faqRepository.createCategory({
      ...input,
      description: input.description ?? null,
      iconMediaId: input.iconMediaId ?? null,
    });

    await cmsCacheService.invalidateFaqs();
    return row;
  },

  async updateCategory(id: string, input: FaqCategoryUpdateInput) {
    const existing = await faqRepository.findCategory(id);
    if (!existing) throw AppError.notFound('FAQ category not found', { id });

    const { version, ...data } = input;
    await updateVersioned(prisma.faqCategory, 'FaqCategory', id, version, data);
    await cmsCacheService.invalidateFaqs();

    return faqRepository.findCategory(id);
  },

  async removeCategory(id: string): Promise<void> {
    const existing = await faqRepository.findCategory(id);
    if (!existing) throw AppError.notFound('FAQ category not found', { id });

    await faqRepository.softDeleteCategory(id);
    await cmsCacheService.invalidateFaqs();
  },

  /* --------------------------------------------------------------- faqs */

  async get(id: string) {
    const faq = await faqRepository.findById(id);
    if (!faq) throw AppError.notFound('FAQ not found', { id });
    return faq;
  },

  list(filter: { visibility?: string; categoryId?: string; includeInactive?: boolean }) {
    return faqRepository.list(filter);
  },

  async create(input: FaqCreateInput) {
    const { targetProductIds, targetCategoryIds, ...rest } = input;

    const faq = await faqRepository.create({
      ...rest,
      faqCategoryId: rest.faqCategoryId ?? null,
      // An answer is rendered as text, not markup: a FAQ is not a place to embed an iframe.
      answer: toPlainText(rest.answer, 8_000) || rest.answer,
      targetProductIdsJson: idList.serialize(targetProductIds ?? null),
      targetCategoryIdsJson: idList.serialize(targetCategoryIds ?? null),
    });

    await cmsCacheService.invalidateFaqs();
    return faq;
  },

  async update(id: string, input: FaqUpdateInput) {
    await this.get(id);
    const { version, targetProductIds, targetCategoryIds, ...rest } = input;

    await updateVersioned(prisma.faq, 'Faq', id, version, {
      ...rest,
      ...(rest.answer ? { answer: toPlainText(rest.answer, 8_000) || rest.answer } : {}),
      ...(targetProductIds !== undefined
        ? { targetProductIdsJson: idList.serialize(targetProductIds ?? null) }
        : {}),
      ...(targetCategoryIds !== undefined
        ? { targetCategoryIdsJson: idList.serialize(targetCategoryIds ?? null) }
        : {}),
    });

    await cmsCacheService.invalidateFaqs();
    return this.get(id);
  },

  async remove(id: string): Promise<void> {
    await this.get(id);
    await faqRepository.softDelete(id);
    await cmsCacheService.invalidateFaqs();
  },

  async reorder(input: CmsReorderInput): Promise<void> {
    await faqRepository.reorder(input.order);
    await cmsCacheService.invalidateFaqs();
  },

  /**
   * Which FAQs apply here.
   *
   * Targeting is deliberately inclusive: a FAQ with no targets applies everywhere in its
   * visibility, and one with targets applies only where listed. The alternative — empty means
   * nowhere — would silently hide every FAQ an admin forgot to target.
   */
  async publicList(query: FaqPublicQuery) {
    if (query.q) {
      return (await faqRepository.search(query.q, query.limit)).map((faq) => this.toDto(faq));
    }

    const [all, product, category] = await Promise.all([
      faqRepository.listAllLive(),
      query.productSlug
        ? prisma.product.findFirst({
            where: { slug: query.productSlug, deletedAt: null },
            select: { id: true, categories: { select: { categoryId: true } } },
          })
        : Promise.resolve(null),
      query.categorySlug
        ? prisma.category.findFirst({
            where: { slug: query.categorySlug, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    const categoryIds = new Set<string>([
      ...(category ? [category.id] : []),
      ...(product?.categories.map((entry) => entry.categoryId) ?? []),
    ]);

    const matched = all.filter((faq) => {
      if (query.visibility && faq.visibility !== query.visibility) return false;

      const products = idList.parseOrNull(faq.targetProductIdsJson);
      const categories = idList.parseOrNull(faq.targetCategoryIdsJson);

      if (!products?.length && !categories?.length) {
        // Untargeted: applies everywhere, unless the caller asked about a specific thing and
        // wants only what is specific to it.
        return true;
      }

      if (products?.length && product && products.includes(product.id)) return true;
      if (categories?.length && [...categoryIds].some((id) => categories.includes(id))) return true;

      return false;
    });

    return matched.slice(0, query.limit).map((faq) => this.toDto(faq));
  },

  toDto(faq: Awaited<ReturnType<typeof faqRepository.findById>>) {
    if (!faq) return null;

    return {
      id: faq.id,
      faqCategoryId: faq.faqCategoryId,
      question: faq.question,
      answer: faq.answer,
      visibility: faq.visibility,
      position: faq.position,
      helpfulYes: faq.helpfulYes,
      helpfulNo: faq.helpfulNo,
    };
  },

  async vote(id: string, helpful: boolean): Promise<{ counted: boolean }> {
    await this.get(id);
    await faqRepository.vote(id, helpful);

    return { counted: true };
  },
};

/* ------------------------------------------------------------ help centre */

export const helpService = {
  /** The category tree, built from the materialised path in memory — one query, not one per node. */
  async tree(includeInactive = false) {
    const rows = await helpRepository.listCategories(includeInactive);

    const byId = new Map(
      rows.map((row) => ({ ...row, children: [] as typeof rows })).map((row) => [row.id, row]),
    );

    const roots: (typeof rows[number] & { children: unknown[] })[] = [];

    for (const row of byId.values()) {
      if (row.parentId && byId.has(row.parentId)) byId.get(row.parentId)!.children.push(row);
      else roots.push(row);
    }

    return roots;
  },

  async createCategory(input: HelpCategoryCreateInput) {
    const parent = input.parentId ? await helpRepository.findCategory(input.parentId) : null;

    if (input.parentId && !parent) {
      throw AppError.notFound('Parent help category not found', { parentId: input.parentId });
    }

    const depth = depthFor(parent?.depth ?? null);
    if (depth > MAX_HELP_DEPTH) {
      throw AppError.validation(`Help categories may nest ${MAX_HELP_DEPTH + 1} levels deep`, {
        depth,
        max: MAX_HELP_DEPTH,
      });
    }

    const row = await helpRepository.createCategory({
      ...input,
      description: input.description ?? null,
      iconMediaId: input.iconMediaId ?? null,
      parentId: input.parentId ?? null,
      path: buildPath(parent?.path ?? null, input.slug),
      depth,
    });

    await cmsCacheService.invalidateHelp();
    return row;
  },

  async updateCategory(id: string, input: HelpCategoryUpdateInput) {
    const existing = await helpRepository.findCategory(id);
    if (!existing) throw AppError.notFound('Help category not found', { id });

    const { version, parentId, ...data } = input;
    const reparenting = parentId !== undefined && (parentId ?? null) !== existing.parentId;

    if (reparenting) {
      await helpRepository.updateCategory(id, { parentId: parentId ?? null });
    }

    await updateVersioned(prisma.helpCategory, 'HelpCategory', id, version, data);

    /*
     * Moving a branch rewrites `path` and `depth` for the node AND every descendant. This is the
     * same materialised-path recompute the category tree uses, rather than a second implementation
     * that could disagree about depth caps or cycles.
     */
    if (reparenting) {
      try {
        await recomputeSubtree(id, helpPathAdapter, HELP_PATH_OPTIONS);
      } catch (error) {
        // Put the tree back before the error escapes: a rejected move must leave nothing moved.
        await helpRepository.updateCategory(id, { parentId: existing.parentId });
        await recomputeSubtree(id, helpPathAdapter, HELP_PATH_OPTIONS);
        throw error;
      }
    }

    await cmsCacheService.invalidateHelp();

    return helpRepository.findCategory(id);
  },

  async removeCategory(id: string): Promise<void> {
    const existing = await helpRepository.findCategory(id);
    if (!existing) throw AppError.notFound('Help category not found', { id });

    const children = await helpRepository.categoryChildren(id);
    if (children.length > 0) {
      throw new AppError(409, 'HELP_CATEGORY_HAS_CHILDREN', 'Move or delete the sub-categories first', {
        children: children.length,
      });
    }

    const articles = await helpRepository.listArticles({ categoryId: id, includeDrafts: true });
    if (articles.length > 0) {
      throw new AppError(409, 'HELP_CATEGORY_HAS_ARTICLES', 'Move or delete the articles first', {
        articles: articles.length,
      });
    }

    await helpRepository.softDeleteCategory(id);
    await cmsCacheService.invalidateHelp();
  },

  /* ----------------------------------------------------------- articles */

  async getArticle(id: string) {
    const article = await helpRepository.findArticle(id);
    if (!article) throw AppError.notFound('Help article not found', { id });
    return article;
  },

  listArticles(filter: { categoryId?: string; status?: string; includeDrafts?: boolean }) {
    return helpRepository.listArticles(filter);
  },

  /** Markdown is rendered and sanitised HERE, at write time. Read paths never run a parser. */
  async renderBody(bodyMarkdown: string): Promise<string> {
    return sanitizeRichHtml(markdown.render(bodyMarkdown), {
      iframeHosts: await cmsCacheService.iframeHosts(),
      // A help article has no reason to embed a third-party frame.
      allowIframes: false,
    });
  },

  async createArticle(input: HelpArticleCreateInput) {
    const category = await helpRepository.findCategory(input.helpCategoryId);
    if (!category) {
      throw AppError.notFound('Help category not found', { id: input.helpCategoryId });
    }

    const clash = await helpRepository.slugExists(input.slug, null);
    if (clash) throw new AppError(409, 'SLUG_TAKEN', `Another article uses "${input.slug}"`, input);

    const { relatedArticleIds, ...rest } = input;
    const bodyHtml = await this.renderBody(rest.bodyMarkdown);

    const article = await helpRepository.createArticle({
      ...rest,
      excerpt: rest.excerpt ?? toPlainText(bodyHtml, 300),
      bodyHtml,
      seoTitle: rest.seoTitle ?? null,
      seoDescription: rest.seoDescription ?? null,
      relatedArticleIdsJson: idList.serialize(relatedArticleIds ?? null),
      publishedAt: rest.status === 'PUBLISHED' ? new Date() : null,
    });

    await cmsCacheService.invalidateHelp();
    return article;
  },

  async updateArticle(id: string, input: HelpArticleUpdateInput) {
    const existing = await this.getArticle(id);
    const { version, relatedArticleIds, ...rest } = input;

    if (rest.slug && rest.slug !== existing.slug) {
      const clash = await helpRepository.slugExists(rest.slug, id);
      if (clash) throw new AppError(409, 'SLUG_TAKEN', `Another article uses "${rest.slug}"`, rest);
    }

    await updateVersioned(prisma.helpArticle, 'HelpArticle', id, version, {
      ...rest,
      ...(rest.bodyMarkdown ? { bodyHtml: await this.renderBody(rest.bodyMarkdown) } : {}),
      ...(relatedArticleIds !== undefined
        ? { relatedArticleIdsJson: idList.serialize(relatedArticleIds ?? null) }
        : {}),
      ...(rest.status === 'PUBLISHED' && !existing.publishedAt ? { publishedAt: new Date() } : {}),
    });

    await cmsCacheService.invalidateHelp();
    return this.getArticle(id);
  },

  async removeArticle(id: string): Promise<void> {
    await this.getArticle(id);
    await helpRepository.softDeleteArticle(id);
    await mediaUsageService.detachEntity('CMS_PAGE', id);
    await cmsCacheService.invalidateHelp();
  },

  async reorderArticles(input: CmsReorderInput): Promise<void> {
    await helpRepository.reorderArticles(input.order);
    await cmsCacheService.invalidateHelp();
  },

  /* ------------------------------------------------------------ public */

  async publicArticle(slug: string) {
    const article = await helpRepository.findArticleBySlug(slug);

    if (!article || article.status !== 'PUBLISHED') {
      throw AppError.notFound('Help article not found', { slug });
    }

    const related = await helpRepository.articlesByIds(
      idList.parseOrNull(article.relatedArticleIdsJson) ?? [],
    );

    void helpRepository.bumpArticleView(article.id).catch(() => undefined);

    return {
      id: article.id,
      slug: article.slug,
      title: article.title,
      excerpt: article.excerpt,
      bodyHtml: article.bodyHtml,
      helpCategoryId: article.helpCategoryId,
      helpfulYes: article.helpfulYes,
      helpfulNo: article.helpfulNo,
      seoTitle: article.seoTitle,
      seoDescription: article.seoDescription,
      publishedAt: article.publishedAt?.toISOString() ?? null,
      related,
    };
  },

  async publicCategory(slug: string) {
    const category = await helpRepository.findCategoryBySlug(slug);
    if (!category || !category.isActive) throw AppError.notFound('Help category not found', { slug });

    const [articles, children] = await Promise.all([
      helpRepository.listArticles({ categoryId: category.id }),
      helpRepository.categoryChildren(category.id),
    ]);

    return {
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      children: children.filter((child) => child.isActive),
      articles: articles.map((article) => ({
        id: article.id,
        slug: article.slug,
        title: article.title,
        excerpt: article.excerpt,
      })),
    };
  },

  async overview() {
    const [tree, featured] = await Promise.all([
      this.tree(),
      helpRepository.listArticles({}),
    ]);

    return {
      categories: tree,
      featured: featured.slice(0, 8).map((article) => ({
        id: article.id,
        slug: article.slug,
        title: article.title,
        excerpt: article.excerpt,
        helpCategoryId: article.helpCategoryId,
      })),
    };
  },

  async voteArticle(id: string, helpful: boolean): Promise<{ counted: boolean }> {
    await this.getArticle(id);
    await helpRepository.voteArticle(id, helpful);

    return { counted: true };
  },
};
