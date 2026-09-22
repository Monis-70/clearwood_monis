import MarkdownIt from 'markdown-it';

import { sanitizeRichHtml, toPlainText } from '../../src/modules/cms/htmlSanitizer';

import { SEED_EPOCH } from './epoch';
import { log, prisma } from './context';

/**
 * The help centre: five categories and the articles support actually sends people to.
 *
 * Markdown is rendered and sanitised HERE, at seed time, exactly as the service does at write
 * time. Read paths never run a parser, so the seed must not leave un-rendered rows behind.
 */

const markdown = new MarkdownIt({ html: true, linkify: true, breaks: false });

const CATEGORIES = [
  { name: 'Ordering', slug: 'help-ordering', description: 'Placing an order and changing one.', position: 0 },
  { name: 'Delivery and assembly', slug: 'help-delivery', description: 'Getting it to you and putting it together.', position: 1 },
  { name: 'Product care', slug: 'help-care', description: 'Keeping solid wood and upholstery in good order.', position: 2 },
  { name: 'Payments and invoices', slug: 'help-payments', description: 'Paying, GST and refunds.', position: 3 },
  { name: 'Account', slug: 'help-account', description: 'Signing in, addresses and order history.', position: 4 },
];

const ARTICLES: { categorySlug: string; slug: string; title: string; body: string }[] = [
  {
    categorySlug: 'help-ordering',
    slug: 'how-to-place-an-order',
    title: 'How to place an order',
    body: `
Choose your piece, pick the options you want &mdash; fabric, finish, size where the product offers
them &mdash; and add it to the cart.

1. **Check the lead time** on the product page. It is the time from confirmed payment to dispatch,
   not to delivery.
2. **Enter your pincode** at checkout so we can confirm we deliver to you and show the real
   delivery estimate.
3. **Pay.** An order is confirmed when payment is captured, not when it is placed.

You will get a confirmation email with your order number, which looks like \`CW/2026-27/000123\`.
Keep it &mdash; every conversation about the order starts with it.
    `,
  },
  {
    categorySlug: 'help-ordering',
    slug: 'changing-or-cancelling-an-order',
    title: 'Changing or cancelling an order',
    body: `
**Before production starts** (usually the first 48 hours) you can cancel free of charge, or change
the fabric, finish or delivery address. Call us with your order number.

**Once production has started** we have bought and cut timber to your specification. A cancellation
at that point carries a charge of 25% of the order value. Talk to us first &mdash; very often the
reason for cancelling is something we can change instead.

**After dispatch** an order cannot be cancelled. Refuse the delivery and we will treat it as a
return.
    `,
  },
  {
    categorySlug: 'help-ordering',
    slug: 'custom-sizes-and-fabrics',
    title: 'Custom sizes and fabrics',
    body: `
Because everything is made to order, most pieces can be adjusted.

- **Size**: usually yes, within reason. Call us with the dimensions before ordering and we will
  tell you what it does to the price and the lead time.
- **Fabric**: choose from our range, or supply your own on larger orders. Upholstery fabric has to
  meet a minimum rub count to survive daily use &mdash; we will tell you if yours does not.
- **Finish**: any of our standard stains on any of our wood species.

Send a photograph and the dimensions of the space and we will come back with a quote.
    `,
  },
  {
    categorySlug: 'help-delivery',
    slug: 'delivery-timelines',
    title: 'Delivery timelines explained',
    body: `
There are two numbers, and they are often confused.

**Lead time** is what the product page shows: the time we need to build your piece, measured from
confirmed payment to dispatch.

**Transit time** is on top of that: three to five days to metro cities, seven to twelve elsewhere.

So a sofa with a four-week lead time ordered in Bengaluru arrives in roughly five weeks. We email
you at dispatch with tracking, and again on the morning of delivery.
    `,
  },
  {
    categorySlug: 'help-delivery',
    slug: 'preparing-for-delivery',
    title: 'Preparing for delivery day',
    body: `
A little preparation saves a wasted trip.

- **Measure the route, not just the room.** Doorways, lift dimensions, and the turn at the top of
  the stairs are what actually stop a sofa.
- **Tell us if there is no lift.** We will send more people. A three-seater that cannot get up a
  tight stairwell is a wasted trip for everyone.
- **Clear the space.** Our team will assemble in place, and they need room to work.
- **Be there, or send someone who can sign.** Deliveries need an adult to accept them.
    `,
  },
  {
    categorySlug: 'help-delivery',
    slug: 'what-to-check-on-arrival',
    title: 'What to check when it arrives',
    body: `
**Open the packaging while the delivery team is still with you.** This is the single most important
thing in this article.

Look at:

- the surfaces you can see, for scratches or dents
- the joints, for anything loose
- the fabric, for marks or pulls
- the piece standing level once assembled

Transit damage found at the door is our problem and we will take it back on the spot. Damage
reported a fortnight later is much harder for either of us to resolve honestly.
    `,
  },
  {
    categorySlug: 'help-delivery',
    slug: 'assembly-and-installation',
    title: 'Assembly and installation',
    body: `
Assembly is **included at no extra cost** on beds, wardrobes, dining tables and every other large
item. Our team will not leave until the piece is standing and level.

Wall-mounted units are fixed to the wall as part of the installation, but we will not drill into a
wall carrying plumbing or concealed wiring &mdash; if you know where those runs are, tell the team.

Small items such as side tables and stools usually arrive fully assembled.
    `,
  },
  {
    categorySlug: 'help-care',
    slug: 'caring-for-solid-wood',
    title: 'Caring for solid wood',
    body: `
- **Dust dry**, with a cotton cloth, along the grain. Water sitting on a finish is what eventually
  lifts it.
- **Keep it out of direct sun.** Indian sunlight will bleach one side of a table within a season.
- **Wax twice a year.** Avoid silicone sprays: they build a film that traps dirt and makes
  refinishing difficult later.
- **Lift, never drag.** Dragging loaded furniture is the most common cause of the joint failures we
  are called out to.
    `,
  },
  {
    categorySlug: 'help-care',
    slug: 'wood-in-the-monsoon',
    title: 'Why a drawer sticks in the monsoon',
    body: `
Wood takes up moisture from the air in the rains and gives it back in summer. A drawer that sticks
in July and runs freely in March is behaving exactly as solid wood does. It is not a defect and it
does not need fixing.

What helps:

- keep rooms **ventilated** rather than sealed
- do not push furniture flat against an outside wall that gets damp
- if a drawer is very tight, a candle rubbed along the runner helps until the weather turns

If a joint has actually opened &mdash; as opposed to a drawer being tight &mdash; that is a warranty
matter. Send us a photograph.
    `,
  },
  {
    categorySlug: 'help-care',
    slug: 'upholstery-care',
    title: 'Looking after upholstery',
    body: `
- **Vacuum monthly** with a brush attachment. Grit is abrasive and works into the weave.
- **Blot spills, do not rub.** Rubbing drives the stain into the fibre.
- **Rotate the cushions** so they wear evenly.
- **Keep it out of direct sun**, which fades fabric faster than it fades wood.

Fabric fading from sunlight is not covered by the warranty, because it is not a manufacturing
defect &mdash; it is physics.
    `,
  },
  {
    categorySlug: 'help-payments',
    slug: 'payment-methods',
    title: 'How you can pay',
    body: `
Cards, UPI, netbanking and wallets through our payment gateway. Cash on delivery is available on
smaller items in selected cities.

We never see your full card number. The gateway returns us a reference and the last four digits, so
there is no card number in our systems to leak.
    `,
  },
  {
    categorySlug: 'help-payments',
    slug: 'gst-invoices',
    title: 'GST invoices and business purchases',
    body: `
Every order gets a GST invoice with the tax broken out by HSN code. It is available to download
from your account as soon as the order is confirmed.

**Buying in a company name?** Enter the GSTIN at checkout and it will be printed on the invoice so
you can claim the input credit. We cannot add a GSTIN to an invoice after it has been issued
&mdash; a tax invoice is a legal document and reissuing one is not something we can do casually.
    `,
  },
  {
    categorySlug: 'help-payments',
    slug: 'how-refunds-work',
    title: 'How refunds work',
    body: `
Once a refund is approved we release it immediately. It goes back to the original payment method.

Your bank then settles it, which usually takes **five to seven working days** and is entirely out
of our hands. If it has been longer than that, the reference on your refund confirmation is what
your bank will ask for.

Refunds are always to the original method. We cannot refund a card payment to a bank account.
    `,
  },
  {
    categorySlug: 'help-account',
    slug: 'managing-your-addresses',
    title: 'Managing your addresses',
    body: `
Add, edit and remove delivery addresses from **Account &rarr; Addresses**. One is marked default and
is pre-selected at checkout.

Editing an address does **not** change the address on an order you have already placed &mdash; that
was captured at the time. To change where a pending order goes, call us with the order number.
    `,
  },
  {
    categorySlug: 'help-account',
    slug: 'finding-your-orders',
    title: 'Finding your orders and invoices',
    body: `
**Account &rarr; Orders** lists everything you have bought, newest first. Open one to see:

- the current status and, once dispatched, the courier and tracking number
- the full price breakdown, including tax
- your GST invoice to download

Ordered as a guest? Use the link in your confirmation email, or create an account with the same
email address and your past orders will be attached to it.
    `,
  },
];

export async function seedHelpCenter(): Promise<void> {
  const categoryIds = new Map<string, string>();

  for (const category of CATEGORIES) {
    const row = await prisma.helpCategory.upsert({
      where: { slug: category.slug },
      create: { ...category, path: category.slug, depth: 0, isActive: true },
      update: { position: category.position },
    });

    categoryIds.set(category.slug, row.id);
  }

  let created = 0;

  for (const [index, article] of ARTICLES.entries()) {
    const existing = await prisma.helpArticle.findUnique({ where: { slug: article.slug } });
    if (existing) continue;

    const body = article.body.trim();
    // Rendered and sanitised here, exactly as helpService.renderBody does at write time.
    const bodyHtml = sanitizeRichHtml(markdown.render(body), { allowIframes: false });

    await prisma.helpArticle.create({
      data: {
        helpCategoryId: categoryIds.get(article.categorySlug)!,
        slug: article.slug,
        title: article.title,
        excerpt: toPlainText(bodyHtml, 220),
        bodyMarkdown: body,
        bodyHtml,
        status: 'PUBLISHED',
        publishedAt: SEED_EPOCH,
        position: index,
        seoTitle: article.title,
        seoDescription: toPlainText(bodyHtml, 160),
      },
    });

    created += 1;
  }

  log('help-center', `${CATEGORIES.length} categories, ${ARTICLES.length} articles (${created} created)`);
}
