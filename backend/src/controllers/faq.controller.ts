import type { Request, Response } from 'express';

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
  HelpfulVoteInput,
} from '@shared/schemas/cms';

import { auditService } from '../modules/auth/audit.service';
import { faqService, helpService } from '../modules/cms/faq.service';
import { created, noContent, ok } from '../utils/response';

/** R1 — thin: resolve the caller, call a service, answer through the one envelope. */

export const publicFaqController = {
  async list(req: Request, res: Response): Promise<void> {
    ok(res, await faqService.publicList(req.query as unknown as FaqPublicQuery));
  },

  async categories(_req: Request, res: Response): Promise<void> {
    ok(res, await faqService.listCategories());
  },

  async vote(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const { helpful } = req.body as HelpfulVoteInput;

    ok(res, await faqService.vote(id, helpful));
  },
};

export const publicHelpController = {
  async overview(_req: Request, res: Response): Promise<void> {
    ok(res, await helpService.overview());
  },

  async category(req: Request, res: Response): Promise<void> {
    const { categorySlug } = req.params as { categorySlug: string };
    ok(res, await helpService.publicCategory(categorySlug));
  },

  async article(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as { slug: string };
    ok(res, await helpService.publicArticle(slug));
  },

  async vote(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const { helpful } = req.body as HelpfulVoteInput;

    ok(res, await helpService.voteArticle(id, helpful));
  },
};

export const adminFaqController = {
  async listCategories(_req: Request, res: Response): Promise<void> {
    ok(res, await faqService.listCategories(true));
  },

  async createCategory(req: Request, res: Response): Promise<void> {
    const row = await faqService.createCategory(req.body as FaqCategoryCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'FaqCategory',
      entityId: row.id,
      severity: 'NOTICE',
    });

    created(res, row);
  },

  async updateCategory(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const row = await faqService.updateCategory(id, req.body as FaqCategoryUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'FaqCategory',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, row);
  },

  async removeCategory(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await faqService.removeCategory(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'FaqCategory',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async list(req: Request, res: Response): Promise<void> {
    const query = req.query as { visibility?: string; categoryId?: string };
    ok(res, await faqService.list({ ...query, includeInactive: true }));
  },

  async create(req: Request, res: Response): Promise<void> {
    const faq = await faqService.create(req.body as FaqCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Faq',
      entityId: faq.id,
      severity: 'NOTICE',
    });

    created(res, faq);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const faq = await faqService.update(id, req.body as FaqUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Faq',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, faq);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await faqService.remove(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'Faq',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async reorder(req: Request, res: Response): Promise<void> {
    await faqService.reorder(req.body as CmsReorderInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Faq',
      entityId: 'reorder',
      severity: 'INFO',
    });

    noContent(res);
  },
};

export const adminHelpController = {
  async tree(_req: Request, res: Response): Promise<void> {
    ok(res, await helpService.tree(true));
  },

  async createCategory(req: Request, res: Response): Promise<void> {
    const row = await helpService.createCategory(req.body as HelpCategoryCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'HelpCategory',
      entityId: row.id,
      severity: 'NOTICE',
    });

    created(res, row);
  },

  async updateCategory(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const row = await helpService.updateCategory(id, req.body as HelpCategoryUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'HelpCategory',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, row);
  },

  async removeCategory(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await helpService.removeCategory(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'HelpCategory',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async listArticles(req: Request, res: Response): Promise<void> {
    const query = req.query as { categoryId?: string; status?: string };
    ok(res, await helpService.listArticles({ ...query, includeDrafts: true }));
  },

  async createArticle(req: Request, res: Response): Promise<void> {
    const article = await helpService.createArticle(req.body as HelpArticleCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'HelpArticle',
      entityId: article.id,
      severity: 'NOTICE',
      meta: { slug: article.slug },
    });

    created(res, article);
  },

  async updateArticle(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const article = await helpService.updateArticle(id, req.body as HelpArticleUpdateInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'HelpArticle',
      entityId: id,
      severity: 'NOTICE',
    });

    ok(res, article);
  },

  async removeArticle(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    await helpService.removeArticle(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'HelpArticle',
      entityId: id,
      severity: 'WARNING',
    });

    noContent(res);
  },

  async reorderArticles(req: Request, res: Response): Promise<void> {
    await helpService.reorderArticles(req.body as CmsReorderInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'HelpArticle',
      entityId: 'reorder',
      severity: 'INFO',
    });

    noContent(res);
  },
};
