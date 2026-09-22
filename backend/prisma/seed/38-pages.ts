import { sanitizeRichHtml } from '../../src/modules/cms/htmlSanitizer';

import { SEED_EPOCH } from './epoch';
import { log, prisma } from './context';

/**
 * The fixed pages the storefront routes to by path.
 *
 * `isSystem` means the storefront has a hard-coded link to it: deleting one would leave a dead
 * link in the footer, so the service refuses. Editing is always allowed — that is the point.
 *
 * Real ClearWood copy, not placeholder text. NO return-policy page: customer returns are frozen
 * (PROJECT_CONTEXT section 22) and publishing a policy for a process that does not exist would be
 * a promise we cannot keep.
 */

interface SystemPage {
  slug: string;
  title: string;
  type: 'HOME' | 'STANDARD' | 'POLICY';
  seoDescription: string;
  body?: string;
}

const PAGES: SystemPage[] = [
  {
    slug: 'home',
    title: 'ClearWood Furnitures',
    type: 'HOME',
    seoDescription:
      'Solid wood furniture made in our own Bengaluru workshop. Built to order, delivered across India.',
  },
  {
    slug: 'about-us',
    title: 'About ClearWood',
    type: 'STANDARD',
    seoDescription: 'We have made furniture in our own workshop in Bengaluru since 2009.',
    body: `
<h2>We take furniture making seriously</h2>
<p>ClearWood began in 2009 with one carpentry shed in Peenya and a simple conviction: if you are
going to sell furniture, you should make it yourself. Sixteen years later we still do. Every sofa,
bed, dining table and wardrobe that carries our name is cut, joined, upholstered and finished by
our own team, in our own workshop, on the outskirts of Bengaluru.</p>

<h3>Nothing is outsourced</h3>
<p>Most furniture sold online in India is bought in, badged and shipped. We do not work that way.
Owning the workshop means we choose the timber ourselves, we control the moisture content before a
single cut is made, and when something is not right we fix it rather than raise a complaint with a
supplier three states away.</p>

<h3>Built to order</h3>
<p>We do not hold warehouses of finished stock. Your piece is built after you order it, which is
why we quote in weeks rather than days, and why you can ask for a different fabric, a different
finish or a different width without being told it is not possible.</p>

<h3>Wood we are willing to name</h3>
<p>We work mainly in seasoned sheesham, mango, teak and engineered ply where ply genuinely belongs
&mdash; in carcasses that must stay square for twenty years. We will tell you exactly what is in a
piece before you buy it. Anyone who will not, has a reason.</p>

<h3>Twenty-five thousand homes</h3>
<p>More than 25,000 families have bought from us since we started. A good number of them come back
for the second bedroom, then the dining room, then their parents' flat. That is the only marketing
we have ever really trusted.</p>
    `,
  },
  {
    slug: 'contact-us',
    title: 'Contact us',
    type: 'STANDARD',
    seoDescription: 'Talk to ClearWood about an order, a delivery or a custom piece.',
    body: `
<h2>Talk to us</h2>
<p>We would rather have a conversation than a ticket queue. Call or message us and you will reach
someone who can actually see your order.</p>

<h3>Workshop and head office</h3>
<p>ClearWood Furnitures<br />Plot 14, Peenya Industrial Area<br />Bengaluru 560058, Karnataka</p>

<h3>Hours</h3>
<p>Monday to Saturday, 10am to 7pm. Sunday by appointment &mdash; if you want to see the workshop,
that is the quietest day to do it.</p>

<h3>Before you call about a delivery</h3>
<p>Have your order number to hand. It is on your confirmation email and looks like
CW/2026-27/000123. It saves us both five minutes.</p>
    `,
  },
  {
    slug: 'privacy-policy',
    title: 'Privacy policy',
    type: 'POLICY',
    seoDescription: 'What ClearWood does with your personal information, and what it does not do.',
    body: `
<h2>Privacy policy</h2>
<p>This policy explains what we collect, why, and what we will never do with it.</p>

<h3>What we collect</h3>
<p>Your name, delivery address, phone number and email, because we cannot deliver a wardrobe
without them. Your order history, because you and we both need it. Basic information about how you
use the site, so we can tell which pages are broken.</p>

<h3>Payment details</h3>
<p>We never see your full card number. Payments are handled by our payment gateway, which returns
us a reference and the last four digits. There is no card number stored in our systems to leak.</p>

<h3>What we do not do</h3>
<p>We do not sell your data. We do not share your contact details with anyone except the courier
carrying your order, who is given only what is needed to find your door.</p>

<h3>How long we keep it</h3>
<p>Order records are kept for eight years, because Indian tax law requires it. Marketing consent is
kept until you withdraw it, which you can do from any email we send.</p>

<h3>Your rights</h3>
<p>You may ask us for a copy of what we hold about you, ask us to correct it, or ask us to delete
what we are not legally required to keep. Write to us and we will respond within thirty days.</p>
    `,
  },
  {
    slug: 'terms-and-conditions',
    title: 'Terms and conditions',
    type: 'POLICY',
    seoDescription: 'The terms on which ClearWood sells and delivers furniture.',
    body: `
<h2>Terms and conditions</h2>

<h3>Ordering</h3>
<p>An order is confirmed when payment is captured, not when it is placed. Until then the price and
availability shown to you are an offer, and we may withdraw it if something is genuinely wrong
&mdash; a pricing error, or timber we can no longer source.</p>

<h3>Prices</h3>
<p>All prices are in Indian rupees and include GST at the applicable rate. The tax breakdown is
shown before you pay and printed on your invoice.</p>

<h3>Made to order</h3>
<p>Most of our range is built after you order. The lead time quoted on the product page is the time
from confirmed payment to dispatch, not to delivery.</p>

<h3>Natural variation</h3>
<p>Solid wood varies in grain and colour, and photographs are taken under studio light. A piece
that differs in grain from the photograph is not a defect; it is wood.</p>

<h3>Warranty</h3>
<p>Three years on structural joinery against manufacturing defect. It does not cover damage from
misuse, water, or moving the piece without dismantling it where dismantling is intended.</p>
    `,
  },
  {
    slug: 'shipping-policy',
    title: 'Shipping and delivery',
    type: 'POLICY',
    seoDescription: 'How ClearWood delivers, what it costs, and what to check on arrival.',
    body: `
<h2>Shipping and delivery</h2>

<h3>Where we deliver</h3>
<p>Across India. Bengaluru, Chennai, Hyderabad and Mumbai are served by our own vehicles; elsewhere
we use surface freight partners.</p>

<h3>Timelines</h3>
<p>Dispatch follows the lead time on the product page. Add three to five days for metro delivery
and seven to twelve for the rest of the country. Large items travel by surface freight and cannot
be expedited.</p>

<h3>Assembly</h3>
<p>Beds, wardrobes and dining tables are delivered with assembly included at no extra cost. Our
team will not leave until the piece is standing and level.</p>

<h3>Check before you sign</h3>
<p>Open the packaging and look at the piece while the delivery team is still there. Transit damage
found at the door is our problem and we will take it back on the spot. Damage reported a fortnight
later is much harder for either of us to resolve.</p>

<h3>Access</h3>
<p>Please tell us at checkout if there is no lift, or if the stairwell turns tightly. A three-seater
sofa that cannot get up the stairs is a wasted trip for everyone.</p>
    `,
  },
  {
    slug: 'cancellation-policy',
    title: 'Cancellation policy',
    type: 'POLICY',
    seoDescription: 'When a ClearWood order can be cancelled, and what happens to your money.',
    body: `
<h2>Cancellation policy</h2>

<h3>Before we start building</h3>
<p>Cancel free of charge any time before your piece enters production. For made-to-order items that
is usually the first 48 hours after payment.</p>

<h3>Once production has started</h3>
<p>We will have bought and cut timber to your specification, so a cancellation at this stage
carries a charge of 25% of the order value. We would rather talk first &mdash; often the reason for
cancelling is something we can change instead.</p>

<h3>After dispatch</h3>
<p>Once a piece is on a lorry it cannot be cancelled. Refuse the delivery if you no longer want it
and we will treat it as a return.</p>

<h3>Refunds</h3>
<p>Refunds go back to the original payment method. Your bank will usually settle within five to
seven working days; we have no control over that part.</p>
    `,
  },
  {
    slug: 'warranty-policy',
    title: 'Warranty',
    type: 'POLICY',
    seoDescription: 'What the ClearWood three-year structural warranty covers.',
    body: `
<h2>Warranty</h2>

<h3>Three years, structural</h3>
<p>Every piece carries a three-year warranty against manufacturing defect in its joinery and frame.
If a joint fails in normal domestic use, we repair or replace it.</p>

<h3>One year on mechanisms and upholstery</h3>
<p>Recliner mechanisms, drawer runners, hinges and upholstery are covered for one year.</p>

<h3>What is not covered</h3>
<p>Fabric fading from direct sunlight. Water damage and swelling. Damage caused by moving a piece
without dismantling it where it is designed to be dismantled. Commercial use. Ordinary wear on
surfaces you sit on every day for years.</p>

<h3>Making a claim</h3>
<p>Send us photographs and your order number. Most claims are settled by a workshop visit within
two weeks in metro cities.</p>
    `,
  },
  {
    slug: 'care-guide',
    title: 'Caring for solid wood',
    type: 'STANDARD',
    seoDescription: 'How to look after solid wood furniture in an Indian climate.',
    body: `
<h2>Caring for solid wood</h2>

<h3>Dust dry, not wet</h3>
<p>A dry or barely damp cotton cloth, along the grain. Water sitting on a finish is what eventually
lifts it.</p>

<h3>Keep it out of direct sun</h3>
<p>Indian sunlight will bleach one side of a table within a season. If a piece must sit by a
window, turn it occasionally so it ages evenly.</p>

<h3>Monsoon</h3>
<p>Wood takes up moisture in the rains and gives it back in summer &mdash; a drawer that sticks in
July and runs freely in March is behaving normally. Keep rooms ventilated rather than sealed.</p>

<h3>Do not use furniture polish with silicone</h3>
<p>It builds a film that traps dirt and makes refinishing difficult later. A wax polish twice a
year is plenty.</p>

<h3>Lift, never drag</h3>
<p>Dragging loaded furniture is the single most common cause of the joint failures we see.</p>
    `,
  },
];

export async function seedPages(): Promise<void> {
  let created = 0;

  for (const entry of PAGES) {
    const existing = await prisma.page.findUnique({ where: { slug: entry.slug } });

    if (existing) {
      // R8 — the admin's edited copy survives. Only the system flag is re-asserted.
      await prisma.page.update({ where: { id: existing.id }, data: { isSystem: true } });
      continue;
    }

    const page = await prisma.page.create({
      data: {
        slug: entry.slug,
        title: entry.title,
        type: entry.type,
        status: 'PUBLISHED',
        publishedAt: SEED_EPOCH,
        isSystem: true,
        seoTitle: entry.title,
        seoDescription: entry.seoDescription,
      },
    });

    if (entry.body) {
      await prisma.pageBlock.create({
        data: {
          pageId: page.id,
          type: 'RICH_TEXT',
          position: 0,
          isActive: true,
          // Seeded markup goes through the same allowlist as admin-authored markup.
          configJson: JSON.stringify({ html: sanitizeRichHtml(entry.body.trim()), align: 'LEFT' }),
        },
      });
    }

    created += 1;
  }

  log('pages', `${PAGES.length} system pages (${created} created)`);
}
