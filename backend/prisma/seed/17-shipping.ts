import { log, prisma } from './context';

/**
 * Shipping zones, real sample pincodes and the rate cards.
 *
 * Furniture is bulky, so the bands are weight-based for standard delivery and a separate
 * WHITE_GLOVE method covers sofas and beds that need two people and assembly.
 */

const ZONES = [
  { code: 'METRO', name: 'Metro cities', priority: 10 },
  { code: 'TIER_1', name: 'Tier 1 cities', priority: 20 },
  { code: 'TIER_2', name: 'Tier 2 cities', priority: 30 },
  { code: 'REST_OF_INDIA', name: 'Rest of India', priority: 100 },
] as const;

/** Real pincodes, one or two per city, so serviceability lookups behave believably in demos. */
const PINCODES: {
  zone: string;
  pincode: string;
  city: string;
  state: string;
  stateCode: string;
  cod: boolean;
  eta: [number, number];
}[] = [
  {
    zone: 'METRO',
    pincode: '400001',
    city: 'Mumbai',
    state: 'Maharashtra',
    stateCode: 'MH',
    cod: true,
    eta: [2, 4],
  },
  {
    zone: 'METRO',
    pincode: '400050',
    city: 'Mumbai',
    state: 'Maharashtra',
    stateCode: 'MH',
    cod: true,
    eta: [2, 4],
  },
  {
    zone: 'METRO',
    pincode: '400076',
    city: 'Mumbai',
    state: 'Maharashtra',
    stateCode: 'MH',
    cod: true,
    eta: [2, 4],
  },
  {
    zone: 'METRO',
    pincode: '411001',
    city: 'Pune',
    state: 'Maharashtra',
    stateCode: 'MH',
    cod: true,
    eta: [2, 5],
  },
  {
    zone: 'METRO',
    pincode: '411045',
    city: 'Pune',
    state: 'Maharashtra',
    stateCode: 'MH',
    cod: true,
    eta: [2, 5],
  },
  {
    zone: 'METRO',
    pincode: '110001',
    city: 'New Delhi',
    state: 'Delhi',
    stateCode: 'DL',
    cod: true,
    eta: [3, 6],
  },
  {
    zone: 'METRO',
    pincode: '110020',
    city: 'New Delhi',
    state: 'Delhi',
    stateCode: 'DL',
    cod: true,
    eta: [3, 6],
  },
  {
    zone: 'METRO',
    pincode: '560001',
    city: 'Bengaluru',
    state: 'Karnataka',
    stateCode: 'KA',
    cod: true,
    eta: [3, 6],
  },
  {
    zone: 'METRO',
    pincode: '560034',
    city: 'Bengaluru',
    state: 'Karnataka',
    stateCode: 'KA',
    cod: true,
    eta: [3, 6],
  },
  {
    zone: 'METRO',
    pincode: '600001',
    city: 'Chennai',
    state: 'Tamil Nadu',
    stateCode: 'TN',
    cod: true,
    eta: [4, 7],
  },
  {
    zone: 'METRO',
    pincode: '600040',
    city: 'Chennai',
    state: 'Tamil Nadu',
    stateCode: 'TN',
    cod: true,
    eta: [4, 7],
  },
  {
    zone: 'METRO',
    pincode: '700001',
    city: 'Kolkata',
    state: 'West Bengal',
    stateCode: 'WB',
    cod: true,
    eta: [4, 8],
  },
  {
    zone: 'METRO',
    pincode: '500001',
    city: 'Hyderabad',
    state: 'Telangana',
    stateCode: 'TG',
    cod: true,
    eta: [3, 6],
  },
  {
    zone: 'METRO',
    pincode: '500081',
    city: 'Hyderabad',
    state: 'Telangana',
    stateCode: 'TG',
    cod: true,
    eta: [3, 6],
  },
  {
    zone: 'METRO',
    pincode: '380001',
    city: 'Ahmedabad',
    state: 'Gujarat',
    stateCode: 'GJ',
    cod: true,
    eta: [3, 6],
  },

  {
    zone: 'TIER_1',
    pincode: '302001',
    city: 'Jaipur',
    state: 'Rajasthan',
    stateCode: 'RJ',
    cod: true,
    eta: [5, 9],
  },
  {
    zone: 'TIER_1',
    pincode: '226001',
    city: 'Lucknow',
    state: 'Uttar Pradesh',
    stateCode: 'UP',
    cod: true,
    eta: [5, 9],
  },
  {
    zone: 'TIER_1',
    pincode: '440001',
    city: 'Nagpur',
    state: 'Maharashtra',
    stateCode: 'MH',
    cod: true,
    eta: [4, 8],
  },
  {
    zone: 'TIER_1',
    pincode: '452001',
    city: 'Indore',
    state: 'Madhya Pradesh',
    stateCode: 'MP',
    cod: true,
    eta: [5, 9],
  },
  {
    zone: 'TIER_1',
    pincode: '641001',
    city: 'Coimbatore',
    state: 'Tamil Nadu',
    stateCode: 'TN',
    cod: true,
    eta: [5, 9],
  },
  {
    zone: 'TIER_1',
    pincode: '682001',
    city: 'Kochi',
    state: 'Kerala',
    stateCode: 'KL',
    cod: true,
    eta: [5, 10],
  },
  {
    zone: 'TIER_1',
    pincode: '751001',
    city: 'Bhubaneswar',
    state: 'Odisha',
    stateCode: 'OR',
    cod: false,
    eta: [6, 11],
  },
  {
    zone: 'TIER_1',
    pincode: '160017',
    city: 'Chandigarh',
    state: 'Chandigarh',
    stateCode: 'CH',
    cod: true,
    eta: [5, 9],
  },
  {
    zone: 'TIER_1',
    pincode: '395001',
    city: 'Surat',
    state: 'Gujarat',
    stateCode: 'GJ',
    cod: true,
    eta: [4, 8],
  },
  {
    zone: 'TIER_1',
    pincode: '530001',
    city: 'Visakhapatnam',
    state: 'Andhra Pradesh',
    stateCode: 'AP',
    cod: false,
    eta: [6, 10],
  },

  {
    zone: 'TIER_2',
    pincode: '415001',
    city: 'Satara',
    state: 'Maharashtra',
    stateCode: 'MH',
    cod: false,
    eta: [6, 11],
  },
  {
    zone: 'TIER_2',
    pincode: '422001',
    city: 'Nashik',
    state: 'Maharashtra',
    stateCode: 'MH',
    cod: true,
    eta: [4, 9],
  },
  {
    zone: 'TIER_2',
    pincode: '575001',
    city: 'Mangaluru',
    state: 'Karnataka',
    stateCode: 'KA',
    cod: false,
    eta: [6, 11],
  },
  {
    zone: 'TIER_2',
    pincode: '628001',
    city: 'Thoothukudi',
    state: 'Tamil Nadu',
    stateCode: 'TN',
    cod: false,
    eta: [7, 12],
  },
  {
    zone: 'TIER_2',
    pincode: '785001',
    city: 'Jorhat',
    state: 'Assam',
    stateCode: 'AS',
    cod: false,
    eta: [9, 15],
  },
  {
    zone: 'TIER_2',
    pincode: '831001',
    city: 'Jamshedpur',
    state: 'Jharkhand',
    stateCode: 'JH',
    cod: false,
    eta: [7, 12],
  },
  {
    zone: 'TIER_2',
    pincode: '144001',
    city: 'Jalandhar',
    state: 'Punjab',
    stateCode: 'PB',
    cod: true,
    eta: [6, 10],
  },
  {
    zone: 'TIER_2',
    pincode: '248001',
    city: 'Dehradun',
    state: 'Uttarakhand',
    stateCode: 'UK',
    cod: false,
    eta: [7, 12],
  },
  {
    zone: 'TIER_2',
    pincode: '492001',
    city: 'Raipur',
    state: 'Chhattisgarh',
    stateCode: 'CG',
    cod: false,
    eta: [7, 12],
  },
  {
    zone: 'TIER_2',
    pincode: '834001',
    city: 'Ranchi',
    state: 'Jharkhand',
    stateCode: 'JH',
    cod: false,
    eta: [7, 12],
  },
  {
    zone: 'TIER_2',
    pincode: '360001',
    city: 'Rajkot',
    state: 'Gujarat',
    stateCode: 'GJ',
    cod: true,
    eta: [5, 10],
  },
  {
    zone: 'TIER_2',
    pincode: '132001',
    city: 'Karnal',
    state: 'Haryana',
    stateCode: 'HR',
    cod: true,
    eta: [5, 10],
  },
  {
    zone: 'TIER_2',
    pincode: '515001',
    city: 'Anantapur',
    state: 'Andhra Pradesh',
    stateCode: 'AP',
    cod: false,
    eta: [7, 12],
  },
  {
    zone: 'TIER_2',
    pincode: '577001',
    city: 'Davanagere',
    state: 'Karnataka',
    stateCode: 'KA',
    cod: false,
    eta: [6, 11],
  },
  {
    zone: 'TIER_2',
    pincode: '680001',
    city: 'Thrissur',
    state: 'Kerala',
    stateCode: 'KL',
    cod: false,
    eta: [6, 11],
  },
];

/** Broad fallbacks so an unlisted pincode still lands in a sensible zone. */
const RANGES = [
  { zone: 'METRO', fromPincode: '400000', toPincode: '400104', stateCode: 'MH' },
  { zone: 'METRO', fromPincode: '110001', toPincode: '110096', stateCode: 'DL' },
  { zone: 'METRO', fromPincode: '560001', toPincode: '560110', stateCode: 'KA' },
  { zone: 'TIER_1', fromPincode: '411000', toPincode: '411062', stateCode: 'MH' },
  { zone: 'TIER_1', fromPincode: '600001', toPincode: '600123', stateCode: 'TN' },
  { zone: 'TIER_2', fromPincode: '440000', toPincode: '441999', stateCode: 'MH' },
] as const;

const RATES: {
  zone: string;
  method: string;
  name: string;
  conditionType: string;
  minValue: number | null;
  maxValue: number | null;
  basePaise: number;
  perUnitPaise: number | null;
  freeAbovePaise: number | null;
  eta: [number, number];
  priority: number;
}[] = [
  // Weight bands in grams. A 68kg sofa naturally lands in the heaviest band.
  {
    zone: 'METRO',
    method: 'STANDARD',
    name: 'Standard delivery',
    conditionType: 'WEIGHT',
    minValue: 0,
    maxValue: 20_000,
    basePaise: 49_900,
    perUnitPaise: 9_900,
    freeAbovePaise: 5_000_000,
    eta: [2, 5],
    priority: 10,
  },
  {
    zone: 'METRO',
    method: 'STANDARD',
    name: 'Standard delivery (heavy)',
    conditionType: 'WEIGHT',
    minValue: 20_001,
    maxValue: null,
    basePaise: 99_900,
    perUnitPaise: 19_900,
    freeAbovePaise: 5_000_000,
    eta: [3, 6],
    priority: 20,
  },
  {
    zone: 'METRO',
    method: 'EXPRESS',
    name: 'Express delivery',
    conditionType: 'WEIGHT',
    minValue: 0,
    maxValue: 20_000,
    basePaise: 129_900,
    perUnitPaise: 19_900,
    freeAbovePaise: null,
    eta: [1, 2],
    priority: 30,
  },
  {
    zone: 'METRO',
    method: 'WHITE_GLOVE',
    name: 'White glove (unpack, assemble, remove packaging)',
    conditionType: 'WEIGHT',
    minValue: 20_001,
    maxValue: null,
    basePaise: 249_900,
    perUnitPaise: 49_900,
    freeAbovePaise: null,
    eta: [4, 8],
    priority: 40,
  },
  {
    zone: 'METRO',
    method: 'SELF_PICKUP',
    name: 'Collect from our workshop',
    conditionType: 'PRICE',
    minValue: 0,
    maxValue: null,
    basePaise: 0,
    perUnitPaise: null,
    freeAbovePaise: null,
    eta: [1, 2],
    priority: 50,
  },

  {
    zone: 'TIER_1',
    method: 'STANDARD',
    name: 'Standard delivery',
    conditionType: 'WEIGHT',
    minValue: 0,
    maxValue: 20_000,
    basePaise: 79_900,
    perUnitPaise: 14_900,
    freeAbovePaise: 5_000_000,
    eta: [5, 9],
    priority: 10,
  },
  {
    zone: 'TIER_1',
    method: 'STANDARD',
    name: 'Standard delivery (heavy)',
    conditionType: 'WEIGHT',
    minValue: 20_001,
    maxValue: null,
    basePaise: 149_900,
    perUnitPaise: 29_900,
    freeAbovePaise: 5_000_000,
    eta: [6, 10],
    priority: 20,
  },
  {
    zone: 'TIER_1',
    method: 'WHITE_GLOVE',
    name: 'White glove delivery',
    conditionType: 'WEIGHT',
    minValue: 20_001,
    maxValue: null,
    basePaise: 349_900,
    perUnitPaise: 59_900,
    freeAbovePaise: null,
    eta: [7, 12],
    priority: 40,
  },

  {
    zone: 'TIER_2',
    method: 'STANDARD',
    name: 'Standard delivery',
    conditionType: 'WEIGHT',
    minValue: 0,
    maxValue: 20_000,
    basePaise: 99_900,
    perUnitPaise: 19_900,
    freeAbovePaise: 7_500_000,
    eta: [6, 11],
    priority: 10,
  },
  {
    zone: 'TIER_2',
    method: 'STANDARD',
    name: 'Standard delivery (heavy)',
    conditionType: 'WEIGHT',
    minValue: 20_001,
    maxValue: null,
    basePaise: 199_900,
    perUnitPaise: 39_900,
    freeAbovePaise: 7_500_000,
    eta: [7, 12],
    priority: 20,
  },

  {
    zone: 'REST_OF_INDIA',
    method: 'STANDARD',
    name: 'Standard delivery',
    conditionType: 'WEIGHT',
    minValue: 0,
    maxValue: 20_000,
    basePaise: 149_900,
    perUnitPaise: 29_900,
    freeAbovePaise: 10_000_000,
    eta: [8, 15],
    priority: 10,
  },
  {
    zone: 'REST_OF_INDIA',
    method: 'STANDARD',
    name: 'Standard delivery (heavy)',
    conditionType: 'WEIGHT',
    minValue: 20_001,
    maxValue: null,
    basePaise: 299_900,
    perUnitPaise: 49_900,
    freeAbovePaise: 10_000_000,
    eta: [10, 18],
    priority: 20,
  },
];

export async function seedShipping(): Promise<void> {
  const zoneIds = new Map<string, string>();

  for (const zone of ZONES) {
    const existing = await prisma.shippingZone.findFirst({ where: { code: zone.code } });

    const row = existing
      ? await prisma.shippingZone.update({
          where: { id: existing.id },
          data: { priority: zone.priority, isActive: true, deletedAt: null },
        })
      : await prisma.shippingZone.create({ data: { ...zone, isActive: true } });

    zoneIds.set(zone.code, row.id);
  }

  for (const entry of PINCODES) {
    const zoneId = zoneIds.get(entry.zone);
    if (!zoneId) continue;

    await prisma.shippingPincode.upsert({
      where: { pincode: entry.pincode },
      update: {
        zoneId,
        city: entry.city,
        state: entry.state,
        stateCode: entry.stateCode,
        codAvailable: entry.cod,
        etaMinDays: entry.eta[0],
        etaMaxDays: entry.eta[1],
      },
      create: {
        zoneId,
        pincode: entry.pincode,
        city: entry.city,
        state: entry.state,
        stateCode: entry.stateCode,
        isServiceable: true,
        codAvailable: entry.cod,
        etaMinDays: entry.eta[0],
        etaMaxDays: entry.eta[1],
      },
    });
  }

  for (const range of RANGES) {
    const zoneId = zoneIds.get(range.zone);
    if (!zoneId) continue;

    const existing = await prisma.shippingPincodeRange.findFirst({
      where: { zoneId, fromPincode: range.fromPincode, toPincode: range.toPincode },
    });
    if (existing) continue;

    await prisma.shippingPincodeRange.create({
      data: {
        zoneId,
        fromPincode: range.fromPincode,
        toPincode: range.toPincode,
        stateCode: range.stateCode,
      },
    });
  }

  let rateCount = 0;
  for (const rate of RATES) {
    const zoneId = zoneIds.get(rate.zone);
    if (!zoneId) continue;

    const existing = await prisma.shippingRate.findFirst({
      where: { zoneId, method: rate.method, name: rate.name },
    });

    if (existing) {
      await prisma.shippingRate.update({
        where: { id: existing.id },
        data: { isActive: true, deletedAt: null, priority: rate.priority },
      });
    } else {
      await prisma.shippingRate.create({
        data: {
          zoneId,
          method: rate.method,
          name: rate.name,
          conditionType: rate.conditionType,
          minValue: rate.minValue,
          maxValue: rate.maxValue,
          basePaise: rate.basePaise,
          perUnitPaise: rate.perUnitPaise,
          freeAbovePaise: rate.freeAbovePaise,
          etaMinDays: rate.eta[0],
          etaMaxDays: rate.eta[1],
          priority: rate.priority,
          isActive: true,
        },
      });
    }
    rateCount += 1;
  }

  log(
    'shipping',
    `${ZONES.length} zones, ${PINCODES.length} pincodes, ${RANGES.length} ranges, ${rateCount} rates ensured`,
  );
}
