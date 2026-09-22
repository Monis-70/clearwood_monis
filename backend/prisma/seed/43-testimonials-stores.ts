import { SEED_EPOCH } from './epoch';
import { log, prisma } from './context';

/** Customer quotes and the three showrooms, for the TESTIMONIALS and STORE_LOCATOR blocks. */

const TESTIMONIALS = [
  {
    authorName: 'Ananya Rao',
    authorLocation: 'Bengaluru',
    quote:
      'We ordered a sheesham dining table and asked for it six inches narrower than standard. They said yes without making it a production. Six weeks later it arrived and it fits the room exactly.',
    ratingBp: 50_000,
    isFeatured: true,
  },
  {
    authorName: 'Vikram Shetty',
    authorLocation: 'Mangaluru',
    quote:
      'The sofa is four years old, has had two children and a Labrador on it, and the frame has not moved. That is the whole review.',
    ratingBp: 50_000,
    isFeatured: true,
  },
  {
    authorName: 'Priya Menon',
    authorLocation: 'Kochi',
    quote:
      'One drawer arrived with a scratch. I sent a photo on a Tuesday and a man came on the Friday and refinished the front in my flat. I did not expect that.',
    ratingBp: 45_000,
    isFeatured: true,
  },
  {
    authorName: 'Rohit Bansal',
    authorLocation: 'Pune',
    authorRole: 'Architect',
    quote:
      'I specify ClearWood for clients because I can ring the workshop and speak to the person who will actually build it. That is rare now.',
    ratingBp: 50_000,
    isFeatured: true,
  },
  {
    authorName: 'Sneha Kulkarni',
    authorLocation: 'Hyderabad',
    quote:
      'Delivery was two days later than quoted and they called to tell me before I had to ask. The wardrobe is beautiful and the assembly team cleaned up after themselves.',
    ratingBp: 45_000,
    isFeatured: true,
  },
  {
    authorName: 'Imran Qureshi',
    authorLocation: 'Bengaluru',
    quote:
      'We furnished a three-bedroom flat with them. They produced a room-by-room plan, stuck to the budget, and delivered in one go rather than in dribs and drabs.',
    ratingBp: 50_000,
    isFeatured: true,
  },
  {
    authorName: 'Lakshmi Iyer',
    authorLocation: 'Chennai',
    quote:
      'I visited the workshop before ordering. Seeing the timber stacked and drying told me more than any website could.',
    ratingBp: 50_000,
    isFeatured: false,
  },
  {
    authorName: 'Deepak Nair',
    authorLocation: 'Thrissur',
    quote:
      'Honest about what is solid wood and what is ply, and why. I have bought from three other places and nobody else volunteered that.',
    ratingBp: 45_000,
    isFeatured: false,
  },
];

const HOURS = [
  { day: 'MON', opens: '10:00', closes: '19:00', closed: false },
  { day: 'TUE', opens: '10:00', closes: '19:00', closed: false },
  { day: 'WED', opens: '10:00', closes: '19:00', closed: false },
  { day: 'THU', opens: '10:00', closes: '19:00', closed: false },
  { day: 'FRI', opens: '10:00', closes: '19:00', closed: false },
  { day: 'SAT', opens: '10:00', closes: '19:00', closed: false },
  { day: 'SUN', opens: '11:00', closes: '16:00', closed: false },
];

const STORES = [
  {
    name: 'ClearWood Peenya — workshop and flagship',
    slug: 'bengaluru-peenya',
    addressLine1: 'Plot 14, Peenya Industrial Area, Phase 2',
    addressLine2: 'Near Peenya Metro Station',
    city: 'Bengaluru',
    state: 'Karnataka',
    stateCode: 'KA',
    pincode: '560058',
    phone: '+91 99999 99991',
    isFlagship: true,
    position: 0,
  },
  {
    name: 'ClearWood Indiranagar',
    slug: 'bengaluru-indiranagar',
    addressLine1: '412, 100 Feet Road, Indiranagar',
    addressLine2: 'Above the furnishing store',
    city: 'Bengaluru',
    state: 'Karnataka',
    stateCode: 'KA',
    pincode: '560038',
    phone: '+91 99999 99992',
    isFlagship: false,
    position: 1,
  },
  {
    name: 'ClearWood Chennai',
    slug: 'chennai-nungambakkam',
    addressLine1: '28, Sterling Road, Nungambakkam',
    city: 'Chennai',
    state: 'Tamil Nadu',
    stateCode: 'TN',
    pincode: '600034',
    phone: '+91 99999 99993',
    isFlagship: false,
    position: 2,
  },
];

export async function seedTestimonialsAndStores(): Promise<void> {
  let quotes = 0;

  for (const [index, entry] of TESTIMONIALS.entries()) {
    const existing = await prisma.testimonial.findFirst({
      where: { authorName: entry.authorName, deletedAt: null },
      select: { id: true },
    });

    if (existing) continue;

    await prisma.testimonial.create({
      data: {
        authorName: entry.authorName,
        authorLocation: entry.authorLocation,
        authorRole: 'authorRole' in entry ? (entry.authorRole ?? null) : null,
        quote: entry.quote,
        ratingBp: entry.ratingBp,
        isFeatured: entry.isFeatured,
        position: index,
        isActive: true,
        capturedAt: SEED_EPOCH,
      },
    });

    quotes += 1;
  }

  for (const store of STORES) {
    await prisma.storeLocation.upsert({
      where: { slug: store.slug },
      create: {
        ...store,
        addressLine2: 'addressLine2' in store ? (store.addressLine2 ?? null) : null,
        email: 'care@clearwood.in',
        openingHoursJson: JSON.stringify(HOURS),
        isActive: true,
      },
      // R8 — edited addresses and hours survive a re-seed.
      update: { position: store.position, isFlagship: store.isFlagship },
    });
  }

  log('testimonials-stores', `${TESTIMONIALS.length} testimonials (${quotes} created), ${STORES.length} stores`);
}
