import { env } from '../../config/env';
import { helpRepository } from '../../repositories/faq.repository';
import { pageRepository } from '../../repositories/page.repository';
import { prisma } from '../../config/prisma';
import { settingService } from '../../services/setting.service';

import { cmsCacheService } from './cmsCache.service';

/**
 * sitemap.xml, robots.txt and the meta defaults Prompts 13 and 16 will consume.
 *
 * The rule the whole file turns on: **only what a search engine should actually index**. A sitemap
 * that lists drafts, `noIndex` pages or soft-deleted rows is worse than no sitemap — it teaches
 * the crawler that our URLs 404, and that reputation is slow to repair.
 */

export const SITEMAP_SECTIONS = ['products', 'categories', 'collections', 'pages', 'help'] as const;
export type SitemapSection = (typeof SITEMAP_SECTIONS)[number];

interface SitemapEntry {
  loc: string;
  lastmod: string;
  changefreq?: string;
  priority?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlset(entries: SitemapEntry[]): string {
  const body = entries
    .map(
      (entry) =>
        `  <url>\n` +
        `    <loc>${escapeXml(entry.loc)}</loc>\n` +
        `    <lastmod>${entry.lastmod}</lastmod>\n` +
        (entry.changefreq ? `    <changefreq>${entry.changefreq}</changefreq>\n` : '') +
        (entry.priority ? `    <priority>${entry.priority}</priority>\n` : '') +
        `  </url>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const seoService = {
  baseUrl(): string {
    return env.SITEMAP_BASE_URL.replace(/\/+$/, '');
  },

  /** How many pages each section needs at SITEMAP_PAGE_SIZE. */
  async sectionCounts(): Promise<Record<SitemapSection, number>> {
    const now = new Date();

    const [products, categories, collections, pages, help] = await Promise.all([
      prisma.product.count({ where: { status: 'ACTIVE', deletedAt: null } }),
      prisma.category.count({ where: { isActive: true, deletedAt: null } }),
      prisma.collection.count({ where: { isActive: true, deletedAt: null } }),
      pageRepository.countPublished(now),
      helpRepository.countPublished(),
    ]);

    return { products, categories, collections, pages, help };
  },

  /** The index, listing one child sitemap per section per page. */
  async index(): Promise<string> {
    const counts = await this.sectionCounts();
    const base = this.baseUrl();
    const now = iso(new Date());

    const children: string[] = [];

    for (const section of SITEMAP_SECTIONS) {
      const pages = Math.max(1, Math.ceil(counts[section] / env.SITEMAP_PAGE_SIZE));

      for (let page = 1; page <= pages; page += 1) {
        const suffix = page === 1 ? section : `${section}-${page}`;
        children.push(
          `  <sitemap>\n    <loc>${base}/sitemap-${suffix}.xml</loc>\n    <lastmod>${now}</lastmod>\n  </sitemap>`,
        );
      }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${children.join('\n')}\n</sitemapindex>\n`;
  },

  async section(section: SitemapSection, page = 1): Promise<string> {
    return cmsCacheService.wrap(cmsCacheService.sitemapKey(section, page), () =>
      this.buildSection(section, page),
    );
  },

  async buildSection(section: SitemapSection, page: number): Promise<string> {
    const skip = (page - 1) * env.SITEMAP_PAGE_SIZE;
    const take = env.SITEMAP_PAGE_SIZE;
    const base = this.baseUrl();
    const now = new Date();

    let entries: SitemapEntry[] = [];

    switch (section) {
      case 'products': {
        const rows = await prisma.product.findMany({
          where: { status: 'ACTIVE', deletedAt: null },
          select: { slug: true, updatedAt: true },
          orderBy: { slug: 'asc' },
          skip,
          take,
        });

        entries = rows.map((row) => ({
          loc: `${base}/products/${row.slug}`,
          lastmod: iso(row.updatedAt),
          changefreq: 'weekly',
          priority: '0.8',
        }));
        break;
      }

      case 'categories': {
        const rows = await prisma.category.findMany({
          where: { isActive: true, deletedAt: null },
          select: { slug: true, updatedAt: true },
          orderBy: { slug: 'asc' },
          skip,
          take,
        });

        entries = rows.map((row) => ({
          loc: `${base}/${row.slug}`,
          lastmod: iso(row.updatedAt),
          changefreq: 'weekly',
          priority: '0.7',
        }));
        break;
      }

      case 'collections': {
        const rows = await prisma.collection.findMany({
          where: { isActive: true, deletedAt: null },
          select: { slug: true, updatedAt: true },
          orderBy: { slug: 'asc' },
          skip,
          take,
        });

        entries = rows.map((row) => ({
          loc: `${base}/collections/${row.slug}`,
          lastmod: iso(row.updatedAt),
          changefreq: 'weekly',
          priority: '0.6',
        }));
        break;
      }

      case 'pages': {
        const rows = await pageRepository.listPublished(now, skip, take);

        // noIndex is filtered HERE rather than in SQL so the exclusion is visible in one place.
        entries = rows
          .filter((row) => !row.noIndex)
          .map((row) => ({
            loc: row.type === 'HOME' ? `${base}/` : `${base}/${row.slug}`,
            lastmod: iso(row.updatedAt),
            changefreq: 'monthly',
            priority: row.type === 'HOME' ? '1.0' : '0.5',
          }));
        break;
      }

      case 'help': {
        const rows = await helpRepository.listPublished(skip, take);

        entries = rows.map((row) => ({
          loc: `${base}/help/articles/${row.slug}`,
          lastmod: iso(row.updatedAt),
          changefreq: 'monthly',
          priority: '0.4',
        }));
        break;
      }
    }

    return urlset(entries);
  },

  /** Entry counts per section, for the delivery report and for a test to assert against. */
  async entryCounts(): Promise<Record<SitemapSection, number>> {
    const counts: Record<string, number> = {};

    for (const section of SITEMAP_SECTIONS) {
      const xml = await this.section(section, 1);
      counts[section] = (xml.match(/<loc>/g) ?? []).length;
    }

    return counts as Record<SitemapSection, number>;
  },

  async robots(): Promise<string> {
    const [extra, verification] = await Promise.all([
      settingService.getValue('seo.robots_extra'),
      settingService.getValue('seo.google_site_verification'),
    ]);

    const lines = [
      'User-agent: *',
      'Allow: /',
      // Never index anything behind a session or that produces near-duplicate pages.
      'Disallow: /cart',
      'Disallow: /checkout',
      'Disallow: /account',
      'Disallow: /api/',
      'Disallow: /admin',
      'Disallow: /*?sort=',
      'Disallow: /*?page=',
      '',
      `Sitemap: ${this.baseUrl()}/sitemap.xml`,
    ];

    if (typeof verification === 'string' && verification.trim()) {
      lines.push('', `# google-site-verification: ${verification.trim()}`);
    }

    if (typeof extra === 'string' && extra.trim()) lines.push('', extra.trim());

    return `${lines.join('\n')}\n`;
  },

  /**
   * Title/description/canonical/OG defaults. Prompts 13 and 16 consume this so the storefront and
   * the SSR layer cannot disagree about what a page claims to be.
   */
  async metaFor(
    entityType: 'PAGE' | 'PRODUCT' | 'CATEGORY' | 'COLLECTION' | 'HELP_ARTICLE',
    id: string,
  ): Promise<Record<string, unknown>> {
    const [template, fallbackDescription, ogMediaId] = await Promise.all([
      settingService.getValue('seo.default_title_template'),
      settingService.getValue('seo.default_description'),
      settingService.getValue('seo.og_default_media_id'),
    ]);

    const applyTemplate = (title: string): string =>
      typeof template === 'string' && template.includes('%s')
        ? template.replace('%s', title)
        : title;

    const base = this.baseUrl();

    const resolved = await (async () => {
      switch (entityType) {
        case 'PAGE': {
          const page = await pageRepository.findById(id);
          if (!page) return null;

          return {
            title: page.seoTitle ?? page.title,
            description: page.seoDescription,
            canonical: page.canonicalUrl ?? `${base}/${page.slug}`,
            noIndex: page.noIndex,
            ogMediaId: page.ogMediaId,
            updatedAt: page.updatedAt,
          };
        }

        case 'HELP_ARTICLE': {
          const article = await helpRepository.findArticle(id);
          if (!article) return null;

          return {
            title: article.seoTitle ?? article.title,
            description: article.seoDescription ?? article.excerpt,
            canonical: `${base}/help/articles/${article.slug}`,
            noIndex: article.status !== 'PUBLISHED',
            ogMediaId: null,
            updatedAt: article.updatedAt,
          };
        }

        case 'PRODUCT': {
          const product = await prisma.product.findFirst({
            where: { id, deletedAt: null },
            select: {
              slug: true,
              name: true,
              seoTitle: true,
              seoDescription: true,
              shortDescription: true,
              status: true,
              updatedAt: true,
            },
          });
          if (!product) return null;

          return {
            title: product.seoTitle ?? product.name,
            description: product.seoDescription ?? product.shortDescription,
            canonical: `${base}/products/${product.slug}`,
            noIndex: product.status !== 'ACTIVE',
            ogMediaId: null,
            updatedAt: product.updatedAt,
          };
        }

        case 'CATEGORY': {
          const category = await prisma.category.findFirst({
            where: { id, deletedAt: null },
            select: {
              slug: true,
              name: true,
              seoTitle: true,
              seoDescription: true,
              isActive: true,
              updatedAt: true,
            },
          });
          if (!category) return null;

          return {
            title: category.seoTitle ?? category.name,
            description: category.seoDescription,
            canonical: `${base}/${category.slug}`,
            noIndex: !category.isActive,
            ogMediaId: null,
            updatedAt: category.updatedAt,
          };
        }

        case 'COLLECTION': {
          const collection = await prisma.collection.findFirst({
            where: { id, deletedAt: null },
            select: { slug: true, name: true, description: true, isActive: true, updatedAt: true },
          });
          if (!collection) return null;

          return {
            title: collection.name,
            description: collection.description,
            canonical: `${base}/collections/${collection.slug}`,
            noIndex: !collection.isActive,
            ogMediaId: null,
            updatedAt: collection.updatedAt,
          };
        }
      }
    })();

    if (!resolved) return { found: false };

    const description =
      resolved.description ?? (typeof fallbackDescription === 'string' ? fallbackDescription : null);

    return {
      found: true,
      entityType,
      title: applyTemplate(resolved.title),
      description,
      canonical: resolved.canonical,
      noIndex: resolved.noIndex,
      robots: resolved.noIndex ? 'noindex, nofollow' : 'index, follow',
      openGraph: {
        title: applyTemplate(resolved.title),
        description,
        url: resolved.canonical,
        type: entityType === 'PRODUCT' ? 'product' : 'website',
        mediaId: resolved.ogMediaId ?? (typeof ogMediaId === 'string' && ogMediaId ? ogMediaId : null),
      },
      twitter: { card: 'summary_large_image', title: applyTemplate(resolved.title), description },
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': entityType === 'PRODUCT' ? 'Product' : 'WebPage',
        name: resolved.title,
        description,
        url: resolved.canonical,
        dateModified: resolved.updatedAt.toISOString(),
      },
    };
  },

  async rebuild(): Promise<{ sections: Record<SitemapSection, number> }> {
    await cmsCacheService.invalidateSettings();
    return { sections: await this.entryCounts() };
  },
};
