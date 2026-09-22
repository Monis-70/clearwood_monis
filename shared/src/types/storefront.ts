import type {
  FacetKind,
  ProductRelationType,
  ProductSort,
  ResolveResultType,
  SearchEntityType,
  SuggestionType,
} from '../enums';
import type { PriceBreakdown } from './pricing';

/**
 * Prompt 7 — the storefront read contracts.
 *
 * Every money figure here is resolved by the Prompt 6 pricing engine; nothing in this module ever
 * calculates a price. Filtering and sorting use the DEFAULT customer group's indexed range, which
 * is why every list response carries `pricingBasis`.
 */

/* --------------------------------------------------------------- imagery */

export interface ImageSourceDto {
  label: string;
  format: string;
  url: string;
  width: number;
  height: number;
}

export interface ProductImageDto {
  mediaId: string;
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  lqip: string | null;
  dominantColorHex: string | null;
  focalPoint: { x: number; y: number } | null;
  sources: ImageSourceDto[];
}

/* --------------------------------------------------------------- listing */

export interface ProductSwatchDto {
  attributeValueId: string;
  label: string;
  colorHex: string | null;
  swatchMediaId: string | null;
  isInStock: boolean;
}

export interface ProductCardDto {
  id: string;
  slug: string;
  sku: string;
  name: string;
  subtitle: string | null;
  shortDescription: string | null;
  brandId: string | null;
  brandName: string | null;
  primaryCategorySlug: string | null;
  primaryCategoryName: string | null;
  image: ProductImageDto | null;
  currency: 'INR';
  /** Resolved for THIS request's customer group — see `pricingBasis` on the response. */
  pricePaise: number;
  /** The default group's indexed range, which is what the filters and sorts ran against. */
  indexedMinPricePaise: number | null;
  indexedMaxPricePaise: number | null;
  compareAtPricePaise: number | null;
  savingsPaise: number;
  savingsPercentBp: number;
  priceNote: string | null;
  inStock: boolean;
  stockStatus: string;
  isMadeToOrder: boolean;
  leadTimeDays: number | null;
  allowCustomization: boolean;
  manufacturedInHouse: boolean;
  ratingAvgBp: number;
  ratingCount: number;
  soldCount: number;
  isNewArrival: boolean;
  isFeatured: boolean;
  isBestSeller: boolean;
  variantCount: number;
  swatches: ProductSwatchDto[];
  /** Populated only when the listing was driven by a search query. */
  relevanceScore?: number;
}

/* ----------------------------------------------------------------- facets */

export interface FacetValueDto {
  value: string;
  label: string;
  count: number;
  /** Zero-count values are returned disabled rather than dropped, so the UI never reflows. */
  disabled: boolean;
  selected: boolean;
  colorHex: string | null;
  swatchMediaId: string | null;
}

export interface PriceBucketDto {
  fromPaise: number;
  toPaise: number;
  count: number;
}

export interface FacetDto {
  key: string;
  kind: FacetKind;
  label: string;
  attributeId: string | null;
  inputType: string | null;
  values: FacetValueDto[];
  /** PRICE facets only. */
  minPaise?: number;
  maxPaise?: number;
  buckets?: PriceBucketDto[];
}

/* ---------------------------------------------------------------- listing */

export interface AppliedFilterDto {
  key: string;
  values: string[];
  label: string;
}

export interface SortOptionDto {
  value: ProductSort;
  label: string;
  available: boolean;
}

/** `DEFAULT_GROUP` or `CUSTOMER_GROUP:<code>` — never silently one while filtering by the other. */
export type PricingBasis = string;

export interface ProductListDto {
  items: ProductCardDto[];
  facets: FacetDto[];
  appliedFilters: AppliedFilterDto[];
  availableSorts: SortOptionDto[];
  sort: ProductSort;
  pricingBasis: PricingBasis;
  priceBounds: { minPaise: number; maxPaise: number };
  /** Present only in cursor mode; null when the last page has been reached. */
  nextCursor: string | null;
  query: string | null;
  totalCount: number;
}

/* -------------------------------------------------------------------- PDP */

export interface OptionValueAvailabilityDto {
  attributeId: string;
  attributeCode: string;
  attributeName: string;
  valueId: string;
  valueCode: string;
  label: string;
  colorHex: string | null;
  swatchMediaId: string | null;
  isAvailable: boolean;
  isInStock: boolean;
  variantIds: string[];
  /** Delta against the default variant's resolved price, in paise. */
  priceDeltaPaise: number | null;
}

export interface OptionAvailabilityDto {
  productId: string;
  attributes: {
    attributeId: string;
    code: string;
    name: string;
    inputType: string;
    values: OptionValueAvailabilityDto[];
  }[];
  /** One entry per sellable variant: the value ids that select it. O(variants), not O(combos). */
  combinations: { variantId: string; valueIds: string[]; isInStock: boolean }[];
  defaultVariantId: string | null;
  resolvedVariantId: string | null;
}

export interface SpecGroupDto {
  groupId: string | null;
  groupName: string;
  items: { attributeId: string; label: string; value: string; unit: string | null }[];
}

export interface StorefrontVariantDto {
  id: string;
  sku: string;
  name: string | null;
  isDefault: boolean;
  isActive: boolean;
  inStock: boolean;
  stockStatus: string;
  stockQty: number;
  leadTimeDays: number | null;
  optionValueIds: string[];
}

export interface DimensionsDto {
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  seatHeightMm: number | null;
  weightGrams: number | null;
}

export interface DeliveryEstimateDto {
  pincode: string;
  isServiceable: boolean;
  zoneName: string | null;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  chargePaise: number | null;
  message: string;
}

export interface BreadcrumbDto {
  slug: string;
  name: string;
  path: string;
}

export interface ProductDetailDto {
  id: string;
  slug: string;
  sku: string;
  name: string;
  subtitle: string | null;
  shortDescription: string | null;
  description: string | null;
  productType: string;
  brand: { id: string; slug: string; name: string } | null;
  breadcrumbs: BreadcrumbDto[];
  categories: { id: string; slug: string; name: string; isPrimary: boolean }[];
  collections: { id: string; slug: string; name: string }[];
  gallery: ProductImageDto[];
  variants: StorefrontVariantDto[];
  options: OptionAvailabilityDto;
  /** The full Prompt 6 breakdown for the current selection — the single source of price truth. */
  price: PriceBreakdown;
  pricingBasis: PricingBasis;
  compareAtPricePaise: number | null;
  savingsPaise: number;
  savingsPercentBp: number;
  priceNote: string | null;
  showSavingsBadge: boolean;
  inStock: boolean;
  stockStatus: string;
  isMadeToOrder: boolean;
  leadTimeDays: number | null;
  minOrderQty: number;
  maxOrderQty: number | null;
  allowCustomization: boolean;
  manufacturedInHouse: boolean;
  manufacturingNote: string | null;
  warrantyMonths: number | null;
  careInstructions: string | null;
  assemblyRequired: boolean;
  dimensions: DimensionsDto;
  specs: SpecGroupDto[];
  delivery: DeliveryEstimateDto | null;
  related: ProductCardDto[];
  frequentlyBoughtTogether: ProductCardDto[];
  ratingAvgBp: number;
  ratingCount: number;
  seo: { title: string; description: string; keywords: string | null; canonicalPath: string };
  /** Ready to inject into a <script type="application/ld+json"> tag as-is. */
  jsonLd: Record<string, unknown>[];
}

/* ----------------------------------------------------------- category/coll */

export interface CategoryLandingDto {
  category: {
    id: string;
    slug: string;
    name: string;
    path: string;
    depth: number;
    description: string | null;
    shortDescription: string | null;
    bannerMediaId: string | null;
    mobileBannerMediaId: string | null;
  };
  breadcrumbs: BreadcrumbDto[];
  children: { id: string; slug: string; name: string; productCount: number }[];
  facetDefaults: FacetDto[];
  featured: ProductCardDto[];
  productCount: number;
  seo: { title: string; description: string; keywords: string | null; canonicalPath: string };
  jsonLd: Record<string, unknown>[];
}

export interface CollectionDto {
  id: string;
  slug: string;
  name: string;
  type: string;
  description: string | null;
  bannerMediaId: string | null;
  mobileBannerMediaId: string | null;
  productCount: number;
  startsAt: string | null;
  endsAt: string | null;
  lastEvaluatedAt: string | null;
}

/* ----------------------------------------------------------------- search */

export interface SearchGroupDto<T> {
  type: SearchEntityType;
  total: number;
  items: T[];
}

export interface SearchResponseDto {
  query: string;
  normalizedQuery: string;
  expandedTerms: string[];
  queryLogId: string | null;
  products: ProductListDto;
  categories: SearchGroupDto<{ id: string; slug: string; name: string; path: string }>[];
  collections: SearchGroupDto<{ id: string; slug: string; name: string }>[];
  brands: SearchGroupDto<{ id: string; slug: string; name: string }>[];
  tookMs: number;
}

export interface SuggestionDto {
  type: SuggestionType;
  label: string;
  slug: string | null;
  entityId: string | null;
  imageUrl: string | null;
  highlight: { start: number; length: number } | null;
}

/* ---------------------------------------------------------------- resolve */

export interface ResolveResultDto {
  type: ResolveResultType;
  path: string;
  entity: { id: string; slug: string; name: string; type: SearchEntityType } | null;
  redirectTo: string | null;
  statusCode: number | null;
}

/* ------------------------------------------------------------- collections */

export interface CollectionEvaluationDto {
  collectionId: string;
  slug: string;
  matched: number;
  added: number;
  removed: number;
  kept: number;
  evaluatedAt: string;
}

/* ------------------------------------------------------------- admin bits */

export interface SearchAnalyticsDto {
  topQueries: { query: string; count: number; avgResults: number; clickThroughBp: number }[];
  zeroResultQueries: { query: string; count: number; lastSeenAt: string }[];
  totals: { searches: number; clicks: number; zeroResults: number; clickThroughBp: number };
  trend: { date: string; searches: number; zeroResults: number }[];
}

export interface SearchIndexJobDto {
  id: string;
  status: string;
  entityType: string | null;
  isFull: boolean;
  total: number;
  processed: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  errors: string[];
}

export interface RelatedQuery {
  type?: ProductRelationType;
  limit?: number;
}
