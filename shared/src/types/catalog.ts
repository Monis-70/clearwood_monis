import type {
  AttributeDataType,
  AttributeInput,
  CategoryKind,
  DeviceTarget,
  MediaKind,
  MediaRole,
  NavigationItemType,
  NavigationMenuKey,
  ProductStatus,
  ProductType,
  StockStatus,
  Visibility,
} from '../enums';

/**
 * Catalog DTOs — the single shape the API returns and both frontends consume.
 * Money is always integer paise (D5); percentages/rates are integer basis points (18% = 1800).
 */

export interface MediaDto {
  id: string;
  kind: MediaKind;
  url: string;
  mimeType: string;
  altText: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
}

export interface ProductMediaDto extends MediaDto {
  role: MediaRole;
  position: number;
  deviceTarget: DeviceTarget;
  /** Set when the asset belongs to a specific colour/finish swatch. */
  attributeValueId: string | null;
  variantId: string | null;
}

export interface AttributeValueDto {
  id: string;
  code: string;
  label: string;
  position: number;
  colorHex: string | null;
  swatchMediaId: string | null;
  numericValue: number | null;
}

export interface AttributeDto {
  id: string;
  code: string;
  name: string;
  groupCode: string | null;
  groupName: string | null;
  inputType: AttributeInput;
  dataType: AttributeDataType;
  unit: string | null;
  isVariantDefining: boolean;
  isFilterable: boolean;
  isSearchable: boolean;
  isRequired: boolean;
  isComparable: boolean;
  showInSwatch: boolean;
  position: number;
  helpText: string | null;
  values: AttributeValueDto[];
}

/** An attribute as resolved for a category, carrying where it was inherited from. */
export interface ResolvedCategoryAttributeDto extends AttributeDto {
  /** Slug of the category that contributed this attribute (self or an ancestor). */
  inheritedFrom: string;
  isRequiredForCategory: boolean;
  isVariantDefiningForCategory: boolean;
  isFilterableForCategory: boolean;
}

export interface CategoryBreadcrumbDto {
  id: string;
  name: string;
  slug: string;
  depth: number;
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  path: string;
  depth: number;
  position: number;
  kind: CategoryKind;
  parentId: string | null;
  isActive: boolean;
  showInMenu: boolean;
  menuColumn: number | null;
  isFeatured: boolean;
  shortDescription: string | null;
  iconMediaId: string | null;
  productCountCache: number;
  children: CategoryNode[];
}

export interface CategoryDetail extends Omit<CategoryNode, 'children'> {
  description: string | null;
  bannerMediaId: string | null;
  mobileBannerMediaId: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  breadcrumbs: CategoryBreadcrumbDto[];
  children: CategoryNode[];
  attributes: ResolvedCategoryAttributeDto[];
}

export interface VariantAttributeDto {
  attributeId: string;
  attributeCode: string;
  attributeValueId: string;
  valueCode: string;
  valueLabel: string;
}

export interface VariantDto {
  id: string;
  sku: string;
  name: string | null;
  /** `null` means "inherit the product base price" — resolved by the Prompt 6 pricing engine. */
  pricePaise: number | null;
  compareAtPricePaise: number | null;
  /** Product base price applied when `pricePaise` is null (no adjustments applied yet). */
  effectiveBasePricePaise: number;
  position: number;
  isDefault: boolean;
  isActive: boolean;
  stockQty: number;
  stockStatus: StockStatus;
  leadTimeDays: number | null;
  attributes: VariantAttributeDto[];
}

export interface ProductSummary {
  id: string;
  sku: string;
  slug: string;
  name: string;
  subtitle: string | null;
  shortDescription: string | null;
  productType: ProductType;
  status: ProductStatus;
  visibility: Visibility;
  basePricePaise: number;
  compareAtPricePaise: number | null;
  isMadeToOrder: boolean;
  allowCustomization: boolean;
  isFeatured: boolean;
  isNewArrival: boolean;
  isSpecialCollection: boolean;
  isBestSeller: boolean;
  ratingAvgBp: number;
  ratingCount: number;
  primaryMedia: MediaDto | null;
}

export interface ProductDetail extends ProductSummary {
  description: string | null;
  brandId: string | null;
  taxClassId: string | null;
  leadTimeDays: number | null;
  manufacturedInHouse: boolean;
  manufacturingNote: string | null;
  warrantyMonths: number | null;
  careInstructions: string | null;
  assemblyRequired: boolean;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  seatHeightMm: number | null;
  minOrderQty: number;
  maxOrderQty: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  categories: CategoryBreadcrumbDto[];
  specs: { attributeCode: string; label: string; value: string }[];
  variants: VariantDto[];
  media: ProductMediaDto[];
}

export interface NavigationNode {
  id: string;
  label: string;
  type: NavigationItemType;
  position: number;
  isHighlighted: boolean;
  badgeText: string | null;
  badgeColor: string | null;
  /** Resolved destination: category/collection slugs are turned into a URL by the service. */
  url: string | null;
  categorySlug: string | null;
  collectionSlug: string | null;
  leadFormKey: string | null;
  iconMediaId: string | null;
  menuColumn: number | null;
  openInNewTab: boolean;
  children: NavigationNode[];
}

export interface NavigationMenuDto {
  key: NavigationMenuKey;
  name: string;
  items: NavigationNode[];
}
