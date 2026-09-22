import { log, prisma } from './context';

/**
 * Six FAQ categories and the questions a furniture shop is actually asked.
 *
 * Written from the questions that reach a made-to-order furniture business: lead times, wood,
 * fabric, assembly, GST. NO return questions — customer returns are frozen (PROJECT_CONTEXT
 * section 22) and an answer describing a process that does not exist is worse than no answer.
 */

interface FaqSeed {
  question: string;
  answer: string;
  visibility: string;
}

const CATEGORIES: { name: string; slug: string; description: string; position: number }[] = [
  { name: 'Orders and delivery', slug: 'orders-and-delivery', description: 'Timelines, tracking and what happens on the day.', position: 0 },
  { name: 'Made to order', slug: 'made-to-order', description: 'How we build, and what you can change.', position: 1 },
  { name: 'Materials and care', slug: 'materials-and-care', description: 'Wood, fabric, finishes and looking after them.', position: 2 },
  { name: 'Warranty and service', slug: 'warranty-and-service', description: 'What is covered and how to claim.', position: 3 },
  { name: 'Payment and invoicing', slug: 'payment-and-invoicing', description: 'Paying, GST and business purchases.', position: 4 },
  { name: 'Bulk and custom orders', slug: 'bulk-and-custom', description: 'Offices, hotels and whole homes.', position: 5 },
];

const FAQS: Record<string, FaqSeed[]> = {
  'orders-and-delivery': [
    { visibility: 'SHIPPING', question: 'How long will my order take?', answer: 'Each product page shows a lead time, which is the time from confirmed payment to dispatch. Add three to five days for metro delivery and seven to twelve for the rest of India. Made-to-order pieces are built after you order, so the lead time is real production time, not a stock check.' },
    { visibility: 'SHIPPING', question: 'Do you deliver across India?', answer: 'Yes. Bengaluru, Chennai, Hyderabad and Mumbai are served by our own vehicles. Everywhere else travels by surface freight partners.' },
    { visibility: 'SHIPPING', question: 'Is assembly included?', answer: 'Yes, on beds, wardrobes, dining tables and any large item. Our team assembles it and does not leave until it is standing and level. There is no separate charge.' },
    { visibility: 'SHIPPING', question: 'What should I check when it arrives?', answer: 'Open the packaging and look at the piece while the delivery team is still with you. Transit damage found at the door is ours to fix on the spot. Damage reported a fortnight later is much harder for either of us to resolve.' },
    { visibility: 'SHIPPING', question: 'My building has no lift. Is that a problem?', answer: 'Tell us at checkout. We can almost always manage, but we need to send the right number of people, and a three-seater sofa that cannot get up a tight stairwell is a wasted trip for everyone.' },
    { visibility: 'ORDER', question: 'How do I track my order?', answer: 'Sign in and open the order. Once it is dispatched you will see the courier and the tracking number, and we email you at dispatch and again on the morning of delivery.' },
    { visibility: 'ORDER', question: 'Can I change my delivery address after ordering?', answer: 'Before dispatch, yes — call us with your order number. After dispatch the consignment is with the courier and the address is fixed.' },
    { visibility: 'ORDER', question: 'Can I cancel?', answer: 'Free of charge before your piece enters production, usually the first 48 hours. After that we have bought and cut timber to your specification, so a cancellation carries a 25% charge. Talk to us first — often the reason for cancelling is something we can change instead.' },
  ],
  'made-to-order': [
    { visibility: 'GLOBAL', question: 'What does made to order actually mean?', answer: 'We do not hold warehouses of finished furniture. When you order, your piece is built. That is why we quote in weeks, and why you can ask for a different fabric, finish or width without being told it is not possible.' },
    { visibility: 'GLOBAL', question: 'Can I change the size?', answer: 'Usually yes, within reason. Call us before ordering with the dimensions you need and we will tell you what it does to the price and the lead time.' },
    { visibility: 'GLOBAL', question: 'Can I choose my own fabric?', answer: 'You can choose from our range, and for larger orders we will work with a fabric you supply. Upholstery fabric has to meet a minimum rub count to survive daily use; we will tell you if yours does not.' },
    { visibility: 'GLOBAL', question: 'Do you make furniture from a photograph?', answer: 'Often, yes, if it is a shape we can build honestly. Send us the picture and the dimensions of the space. We will not copy another maker\u2019s design detail for detail.' },
    { visibility: 'PRODUCT', question: 'Why is the grain different from the photo?', answer: 'Because it is wood. Every board differs in grain and colour, and studio photographs are taken under controlled light. Variation is not a defect — it is the reason to buy solid wood rather than a print of it.' },
  ],
  'materials-and-care': [
    { visibility: 'GLOBAL', question: 'What wood do you use?', answer: 'Mainly seasoned sheesham, mango and teak, with engineered ply where ply genuinely belongs — in carcasses that must stay square for twenty years. Each product page names what is in that piece. Anyone who will not tell you has a reason.' },
    { visibility: 'CARE', question: 'How should I clean it?', answer: 'A dry or barely damp cotton cloth, wiped along the grain. Water left sitting on a finish is what eventually lifts it.' },
    { visibility: 'CARE', question: 'Should I polish it?', answer: 'A wax polish twice a year is plenty. Avoid silicone-based sprays: they build a film that traps dirt and makes refinishing difficult years later.' },
    { visibility: 'CARE', question: 'A drawer sticks in the monsoon. Is it faulty?', answer: 'No. Wood takes up moisture in the rains and gives it back in summer. A drawer that sticks in July and runs freely in March is behaving exactly as solid wood does. Keep rooms ventilated rather than sealed.' },
    { visibility: 'CARE', question: 'Will sunlight damage it?', answer: 'Indian sunlight will bleach one side of a table within a season and fade upholstery faster than that. Keep pieces out of direct sun, or turn them occasionally so they age evenly.' },
    { visibility: 'CARE', question: 'Can I move it without dismantling it?', answer: 'Please do not drag loaded furniture — it is the single most common cause of the joint failures we are called out to. Empty it, lift it, and dismantle anything designed to come apart.' },
  ],
  'warranty-and-service': [
    { visibility: 'WARRANTY', question: 'What does the warranty cover?', answer: 'Three years against manufacturing defect in joinery and frame, and one year on recliner mechanisms, drawer runners, hinges and upholstery. If a joint fails in normal domestic use, we repair or replace it.' },
    { visibility: 'WARRANTY', question: 'What is not covered?', answer: 'Fabric fading from direct sunlight, water damage and swelling, damage from moving a piece without dismantling it where it is designed to be dismantled, commercial use, and ordinary wear on surfaces you use every day for years.' },
    { visibility: 'WARRANTY', question: 'How do I make a claim?', answer: 'Send us photographs and your order number. Most claims are settled by a workshop visit within two weeks in metro cities.' },
    { visibility: 'WARRANTY', question: 'Do you repair furniture out of warranty?', answer: 'Yes, and we would rather repair than see a piece thrown away. We quote for the work before starting.' },
  ],
  'payment-and-invoicing': [
    { visibility: 'PAYMENT', question: 'What payment methods do you accept?', answer: 'Cards, UPI, netbanking and wallets through our payment gateway. Cash on delivery is available on smaller items in selected cities.' },
    { visibility: 'PAYMENT', question: 'Do I get a GST invoice?', answer: 'Yes, on every order, with the tax broken out by HSN. It is available to download from your account as soon as the order is confirmed.' },
    { visibility: 'PAYMENT', question: 'Can I buy in my company\u2019s name?', answer: 'Yes. Enter the GSTIN at checkout and it will be printed on the invoice so you can claim the input credit.' },
    { visibility: 'PAYMENT', question: 'Is my card safe?', answer: 'We never see your full card number. Payments are handled by the gateway, which returns us only a reference and the last four digits. There is no card number in our systems to leak.' },
    { visibility: 'PAYMENT', question: 'When am I charged?', answer: 'At checkout. An order is confirmed when payment is captured, not when it is placed, and production is scheduled from the confirmation.' },
    { visibility: 'PAYMENT', question: 'How long do refunds take?', answer: 'We release a refund immediately once it is approved. Your bank usually settles it within five to seven working days, and that part is out of our hands.' },
  ],
  'bulk-and-custom': [
    { visibility: 'GLOBAL', question: 'Do you supply offices and hotels?', answer: 'Yes, and it is a good part of what we do. Contract work has different durability requirements from domestic furniture, so talk to us rather than ordering from the site.' },
    { visibility: 'GLOBAL', question: 'Is there a discount for bulk orders?', answer: 'Yes, and it scales with quantity and with how much repetition there is in the specification. Twenty identical chairs cost far less per chair than twenty different ones.' },
    { visibility: 'GLOBAL', question: 'Can you furnish a whole home?', answer: 'We do it regularly. Send us the floor plan and a rough budget and we will come back with a room-by-room plan and a price, at no charge.' },
    { visibility: 'GLOBAL', question: 'How long does a bulk order take?', answer: 'It depends on volume, but plan on six to ten weeks for a full home and longer for contract quantities. We will give you a firm date before you commit.' },
    { visibility: 'GLOBAL', question: 'Can we visit the workshop?', answer: 'Please do. Sunday is the quietest day. Call ahead so someone who knows the machines is there to walk you round.' },
  ],
};

export async function seedFaqs(): Promise<void> {
  let categories = 0;
  let questions = 0;

  for (const category of CATEGORIES) {
    const row = await prisma.faqCategory.upsert({
      where: { slug: category.slug },
      create: { ...category, isActive: true },
      // R8 — an admin's edited name and description survive; only structure is re-asserted.
      update: { position: category.position },
    });

    categories += 1;

    const entries = FAQS[category.slug] ?? [];

    for (const [index, faq] of entries.entries()) {
      const existing = await prisma.faq.findFirst({
        where: { question: faq.question, deletedAt: null },
        select: { id: true },
      });

      if (existing) continue;

      await prisma.faq.create({
        data: {
          faqCategoryId: row.id,
          question: faq.question,
          answer: faq.answer,
          visibility: faq.visibility,
          position: index,
          isActive: true,
        },
      });

      questions += 1;
    }
  }

  const total = Object.values(FAQS).reduce((sum, list) => sum + list.length, 0);
  log('faqs', `${categories} categories, ${total} questions (${questions} created)`);
}
