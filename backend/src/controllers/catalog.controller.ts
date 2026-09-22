import type { Request, Response } from 'express';

import type {
  AttributeListQuery,
  CategoryTreeQuery,
  NavigationParams,
} from '@shared/schemas/catalog';
import type { SlugParam } from '@shared/schemas/common';

import { attributeService } from '../services/attribute.service';
import { categoryService } from '../services/category.service';
import { navigationService } from '../services/navigation.service';
import { ok, paginated } from '../utils/response';

/** R1 — thin: parse the already-validated input, call a service, return through the envelope. */
export const catalogController = {
  async categoryTree(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as CategoryTreeQuery;
    ok(res, await categoryService.getTree(query));
  },

  async categoryBySlug(req: Request, res: Response): Promise<void> {
    const { slug } = req.params as unknown as SlugParam;
    ok(res, await categoryService.getBySlug(slug));
  },

  async attributes(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as AttributeListQuery;
    const page = await attributeService.list(query);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async navigation(req: Request, res: Response): Promise<void> {
    const { key } = req.params as unknown as NavigationParams;
    ok(res, await navigationService.getMenu(key));
  },
};
