import { ALWAYS_ACTIVE_UNTIL, SEED_EPOCH } from './epoch';
import { log, prisma } from './context';

/**
 * THE home page, built from real seeded catalog data.
 *
 * Fourteen blocks in the agreed order. This is also the fixture the hydration query-budget test
 * measures against, so changing the block list here changes the number recorded in
 * PROJECT_CONTEXT — which is the point: the budget is about this page, not a synthetic one.
 *
 * Idempotent by block SIGNATURE rather than by wiping and rebuilding: an admin who reorders the
 * homepage must not have their work undone by the next deploy's seed.
 */

async function imageIds(limit: number): Promise<string[]> {
  const rows = await prisma.media.findMany({
    where: { kind: 'IMAGE', status: 'READY', deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  return rows.map((row) => row.id);
}

export async function seedHomepage(): Promise<void> {
  const page = await prisma.page.findUnique({ where: { slug: 'home' } });
  if (!page) {
    log('homepage', 'skipped (no home page — run 38-pages first)');
    return;
  }

  const existing = await prisma.pageBlock.count({ where: { pageId: page.id } });
  if (existing > 0) {
    log('homepage', `kept ${existing} existing blocks (admin edits win)`);
    return;
  }

  const [roots, collections, media] = await Promise.all([
    prisma.category.findMany({
      where: { depth: 0, isActive: true, deletedAt: null },
      select: { id: true },
      orderBy: { position: 'asc' },
      take: 12,
    }),
    prisma.collection.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, slug: true },
    }),
    imageIds(12),
  ]);

  const bySlug = new Map(collections.map((entry) => [entry.slug, entry.id]));
  const deals = bySlug.get('deals-of-the-week') ?? '';
  const bestSellers = bySlug.get('best-sellers') ?? '';
  const newArrivals = bySlug.get('new-arrivals') ?? '';

  const faqs = await prisma.faq.findMany({
    where: { visibility: 'GLOBAL', isActive: true, deletedAt: null },
    select: { id: true },
    orderBy: { position: 'asc' },
    take: 6,
  });

  const pick = (index: number): string => media[index % Math.max(media.length, 1)] ?? '';

  const blocks: { type: string; config: Record<string, unknown> }[] = [
    {
      type: 'USP_STRIP',
      config: {
        items: [
          { title: 'Made in our own workshop', subtitle: 'Nothing outsourced, ever' },
          { title: 'Built to order', subtitle: 'Your piece, your fabric, your size' },
          { title: '25,000+ homes furnished', subtitle: 'Since 2009' },
          { title: 'Three-year warranty', subtitle: 'On structural joinery' },
        ],
      },
    },
    {
      type: 'HERO_SLIDER',
      config: {
        autoplayMs: 6_000,
        showDots: true,
        slides: [
          {
            mediaId: pick(0),
            headline: 'We Take Furniture Making Seriously',
            subheadline: 'Solid wood, cut and joined in our own Bengaluru workshop.',
            ctaLabel: 'Shop sofas',
            ctaUrl: '/sofas',
          },
          {
            mediaId: pick(1),
            headline: 'Built for the way you actually live',
            subheadline: 'Made to order in the fabric and finish you choose.',
            ctaLabel: 'Explore the range',
            ctaUrl: '/collections/best-sellers',
          },
        ],
      },
    },
    {
      type: 'CATEGORY_CIRCLES',
      config: { title: 'Shop by room', categoryIds: roots.map((row) => row.id), showLabels: true },
    },
    {
      type: 'BANNER_SPLIT',
      config: {
        panels: [
          {
            mediaId: pick(2),
            headline: 'Modern Wood Furniture Collections',
            subheadline: 'Clean lines, honest joinery.',
            ctaLabel: 'See the collection',
            ctaUrl: '/collections/special-collection',
          },
          {
            mediaId: pick(3),
            headline: 'Made to order, made to last',
            subheadline: 'Choose the wood, the finish and the size.',
            ctaLabel: 'Start designing',
            ctaUrl: '/collections/made-to-order',
          },
        ],
      },
    },
    {
      type: 'COUNTDOWN_DEAL',
      config: {
        collectionId: deals,
        headline: 'Deals of the week',
        subheadline: 'Ends Sunday midnight.',
        // Anchored, not now+7d: a deal that expires a week after whoever seeded is not a fixture.
        endsAt: ALWAYS_ACTIVE_UNTIL.toISOString(),
        limit: 8,
      },
    },
    {
      type: 'PRODUCT_CAROUSEL',
      config: {
        title: 'Premium collections',
        subtitle: 'The pieces our customers come back for.',
        collectionId: bestSellers,
        limit: 12,
        showViewAll: true,
      },
    },
    {
      type: 'PRODUCT_GRID',
      config: {
        title: 'New arrivals',
        collectionId: newArrivals,
        limit: 8,
        columns: 4,
      },
    },
    {
      type: 'IMAGE_WITH_TEXT',
      config: {
        mediaId: pick(4),
        imagePosition: 'LEFT',
        headline: 'Nothing here was bought in and badged',
        body:
          'ClearWood began in 2009 with one carpentry shed in Peenya. Sixteen years later every piece ' +
          'that carries our name is still cut, joined, upholstered and finished by our own team. Owning ' +
          'the workshop means we choose the timber, we control how it is dried, and when something is ' +
          'not right we fix it rather than raise a complaint with a supplier three states away.',
        ctaLabel: 'Read our story',
        ctaUrl: '/about-us',
      },
    },
    { type: 'TESTIMONIALS', config: { title: 'What our customers say', featuredOnly: true, limit: 6 } },
    {
      type: 'TRUST_BADGES',
      config: {
        items: [
          { label: 'Three-year warranty', caption: 'On structural joinery' },
          { label: 'Free assembly', caption: 'Included on every large item' },
          { label: 'GST invoice', caption: 'On every order' },
          { label: 'Secure payments', caption: 'Cards, UPI, netbanking' },
        ],
      },
    },
    {
      type: 'FAQ_ACCORDION',
      config: { title: 'Questions we are asked most', faqIds: faqs.map((row) => row.id), limit: 6 },
    },
    {
      type: 'LEAD_FORM_CTA',
      config: {
        // 10B registers the form behind this key; the block renders the CTA regardless.
        leadFormKey: 'home-interiors',
        headline: 'Furnishing a whole home?',
        subheadline: 'Tell us the rooms and we will come back with a plan and a price.',
        buttonLabel: 'Book a consultation',
      },
    },
    {
      type: 'NEWSLETTER_SIGNUP',
      config: {
        headline: 'New pieces, twice a month',
        subheadline: 'No noise. Unsubscribe from any email.',
        buttonLabel: 'Subscribe',
      },
    },
  ];

  await prisma.pageBlock.createMany({
    data: blocks.map((block, index) => ({
      pageId: page.id,
      type: block.type,
      position: index,
      isActive: true,
      deviceVisibility: 'ALL',
      configJson: JSON.stringify(block.config),
    })),
  });

  await prisma.page.update({
    where: { id: page.id },
    data: { status: 'PUBLISHED', publishedAt: SEED_EPOCH },
  });

  log('homepage', `${blocks.length} blocks`);
}
