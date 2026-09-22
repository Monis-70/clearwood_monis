/**
 * Cross-app constants. Values that an admin may ever want to change do NOT belong here (R8) —
 * they live in the `AppSetting` table.
 */

export const APP_NAME = 'ClearWood Furnitures';
export const APP_TAGLINE = '100% in-house manufacturing. Zero outsourcing.';

/** Reserved ports — never change (see docs/PROJECT_CONTEXT.md §4). */
export const PORTS = {
  API: 7180,
  WEB: 7181,
  ADMIN: 7182,
  /** reserved for later */
  ADMINER: 7183,
  /** reserved for later */
  MYSQL: 3380,
  /** reserved for later */
  REDIS: 6380,
} as const;

export const API_PREFIX = '/api/v1';

export const CURRENCY = 'INR';
export const CURRENCY_SYMBOL = '\u20B9';
export const CURRENCY_LOCALE = 'en-IN';

/** R5 — list endpoint contract. */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  DEFAULT_ORDER: 'desc',
} as const;

/** Header used to correlate a request across the frontends, the API and the logs. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * The one rendition ladder. The image processor derives every variant from this list and the admin
 * UI renders the same table, so a new size is a one-line change here.
 *
 * `formats` is the *extra* formats to emit; the source format is always emitted as well, and AVIF is
 * appended when `ENABLE_AVIF=true`. `fit: 'inside'` never upscales; `cover` crops to an exact box.
 */
export interface RenditionPreset {
  label: string;
  width: number;
  height?: number;
  fit: 'inside' | 'cover';
  quality: number;
  formats: string[];
  /** Which surface the rendition is aimed at — mirrors DeviceTarget. */
  deviceTarget: 'ALL' | 'MOBILE' | 'DESKTOP';
}

export const RENDITION_PRESETS: readonly RenditionPreset[] = [
  {
    label: 'THUMB',
    width: 160,
    fit: 'inside',
    quality: 75,
    formats: ['WEBP'],
    deviceTarget: 'ALL',
  },
  {
    label: 'SMALL',
    width: 320,
    fit: 'inside',
    quality: 78,
    formats: ['WEBP'],
    deviceTarget: 'ALL',
  },
  {
    label: 'MEDIUM',
    width: 640,
    fit: 'inside',
    quality: 82,
    formats: ['WEBP'],
    deviceTarget: 'ALL',
  },
  {
    label: 'LARGE',
    width: 1024,
    fit: 'inside',
    quality: 82,
    formats: ['WEBP'],
    deviceTarget: 'ALL',
  },
  {
    label: 'XLARGE',
    width: 1600,
    fit: 'inside',
    quality: 82,
    formats: ['WEBP'],
    deviceTarget: 'ALL',
  },
  {
    label: 'MOBILE',
    width: 750,
    fit: 'inside',
    quality: 80,
    formats: ['WEBP'],
    deviceTarget: 'MOBILE',
  },
  {
    label: 'DESKTOP',
    width: 1920,
    fit: 'inside',
    quality: 82,
    formats: ['WEBP'],
    deviceTarget: 'DESKTOP',
  },
  {
    label: 'SQUARE',
    width: 800,
    height: 800,
    fit: 'cover',
    quality: 82,
    formats: ['WEBP'],
    deviceTarget: 'ALL',
  },
] as const;

/** System media folders created by the seed; `isSystem` rows cannot be renamed or deleted. */
export const SYSTEM_MEDIA_FOLDERS = [
  'products',
  'categories',
  'collections',
  'brands',
  'swatches',
  'cms',
  'banners',
  'avatars',
  'seed',
  'uploads',
] as const;

/** Longest edge of a stored original; anything larger is downscaled on upload. */
export const MAX_MEDIA_DEPTH = 4;

/**
 * The 36 Indian states and union territories with their GST state codes.
 *
 * This is a statutory list, not editable business data, so it belongs here rather than in
 * `AppSetting` (R8). Address validation, the address form and the Prompt 6 place-of-supply logic
 * all read the same `code`, which is why CGST/SGST vs IGST can never disagree with the address.
 */
export interface IndianState {
  /** Two-letter ISO 3166-2:IN subdivision code, used everywhere as `stateCode`. */
  code: string;
  name: string;
  /** Numeric GST state code as printed on a GSTIN. */
  gstCode: string;
  isUnionTerritory: boolean;
}

export const INDIAN_STATES: readonly IndianState[] = [
  { code: 'AN', name: 'Andaman and Nicobar Islands', gstCode: '35', isUnionTerritory: true },
  { code: 'AP', name: 'Andhra Pradesh', gstCode: '37', isUnionTerritory: false },
  { code: 'AR', name: 'Arunachal Pradesh', gstCode: '12', isUnionTerritory: false },
  { code: 'AS', name: 'Assam', gstCode: '18', isUnionTerritory: false },
  { code: 'BR', name: 'Bihar', gstCode: '10', isUnionTerritory: false },
  { code: 'CH', name: 'Chandigarh', gstCode: '04', isUnionTerritory: true },
  { code: 'CT', name: 'Chhattisgarh', gstCode: '22', isUnionTerritory: false },
  {
    code: 'DH',
    name: 'Dadra and Nagar Haveli and Daman and Diu',
    gstCode: '26',
    isUnionTerritory: true,
  },
  { code: 'DL', name: 'Delhi', gstCode: '07', isUnionTerritory: true },
  { code: 'GA', name: 'Goa', gstCode: '30', isUnionTerritory: false },
  { code: 'GJ', name: 'Gujarat', gstCode: '24', isUnionTerritory: false },
  { code: 'HP', name: 'Himachal Pradesh', gstCode: '02', isUnionTerritory: false },
  { code: 'HR', name: 'Haryana', gstCode: '06', isUnionTerritory: false },
  { code: 'JH', name: 'Jharkhand', gstCode: '20', isUnionTerritory: false },
  { code: 'JK', name: 'Jammu and Kashmir', gstCode: '01', isUnionTerritory: true },
  { code: 'KA', name: 'Karnataka', gstCode: '29', isUnionTerritory: false },
  { code: 'KL', name: 'Kerala', gstCode: '32', isUnionTerritory: false },
  { code: 'LA', name: 'Ladakh', gstCode: '38', isUnionTerritory: true },
  { code: 'LD', name: 'Lakshadweep', gstCode: '31', isUnionTerritory: true },
  { code: 'MH', name: 'Maharashtra', gstCode: '27', isUnionTerritory: false },
  { code: 'ML', name: 'Meghalaya', gstCode: '17', isUnionTerritory: false },
  { code: 'MN', name: 'Manipur', gstCode: '14', isUnionTerritory: false },
  { code: 'MP', name: 'Madhya Pradesh', gstCode: '23', isUnionTerritory: false },
  { code: 'MZ', name: 'Mizoram', gstCode: '15', isUnionTerritory: false },
  { code: 'NL', name: 'Nagaland', gstCode: '13', isUnionTerritory: false },
  { code: 'OR', name: 'Odisha', gstCode: '21', isUnionTerritory: false },
  { code: 'PB', name: 'Punjab', gstCode: '03', isUnionTerritory: false },
  { code: 'PY', name: 'Puducherry', gstCode: '34', isUnionTerritory: true },
  { code: 'RJ', name: 'Rajasthan', gstCode: '08', isUnionTerritory: false },
  { code: 'SK', name: 'Sikkim', gstCode: '11', isUnionTerritory: false },
  { code: 'TG', name: 'Telangana', gstCode: '36', isUnionTerritory: false },
  { code: 'TN', name: 'Tamil Nadu', gstCode: '33', isUnionTerritory: false },
  { code: 'TR', name: 'Tripura', gstCode: '16', isUnionTerritory: false },
  { code: 'UP', name: 'Uttar Pradesh', gstCode: '09', isUnionTerritory: false },
  { code: 'UT', name: 'Uttarakhand', gstCode: '05', isUnionTerritory: false },
  { code: 'WB', name: 'West Bengal', gstCode: '19', isUnionTerritory: false },
] as const;

export const INDIAN_STATE_CODES: readonly string[] = INDIAN_STATES.map((state) => state.code);

export function findIndianState(codeOrName: string): IndianState | undefined {
  const needle = codeOrName.trim().toLowerCase();
  return INDIAN_STATES.find(
    (state) => state.code.toLowerCase() === needle || state.name.toLowerCase() === needle,
  );
}

/** Ten digits starting 6-9, optionally +91 / 0 prefixed. */
export const INDIAN_PHONE_PATTERN = /^(?:\+?91[-\s]?|0)?[6-9]\d{9}$/;
export const INDIAN_PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

/** Strips the country prefix so one customer never has two spellings of the same number. */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d]/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}
