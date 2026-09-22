import type {
  BulkActionType,
  DeleteStrategy,
  ImportEntity,
  ImportStatus,
  InventoryReason,
  ProductRelationType,
  SlugEntityType,
} from '../enums';

/** Response shapes for the Prompt 5 admin catalog API. */

export interface AdminCategoryDto {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  path: string;
  depth: number;
  position: number;
  kind: string;
  isActive: boolean;
  showInMenu: boolean;
  menuColumn: number | null;
  isFeatured: boolean;
  shortDescription: string | null;
  description: string | null;
  iconMediaId: string | null;
  bannerMediaId: string | null;
  mobileBannerMediaId: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  deleteStrategyNote: string | null;
  productCountCache: number;
  childCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AdminCategoryTreeNode extends AdminCategoryDto {
  children: AdminCategoryTreeNode[];
}

/** What a delete would actually touch, so the UI can warn before anything happens. */
export interface CategoryDeleteImpactDto {
  categoryId: string;
  strategy: DeleteStrategy;
  directChildren: number;
  descendants: number;
  directProducts: number;
  descendantProducts: number;
  blocked: boolean;
  blockReason: string | null;
}

export interface SlugRedirectDto {
  id: string;
  entityType: SlugEntityType;
  fromSlug: string;
  toSlug: string;
  entityId: string;
  statusCode: number;
  hitCount: number;
  createdAt: string;
}

export interface PublishBlockerDto {
  code: string;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}

export interface CompletenessFactorDto {
  key: string;
  label: string;
  weight: number;
  satisfied: boolean;
}

export interface ProductCompletenessDto {
  score: number;
  factors: CompletenessFactorDto[];
}

export interface ProductRelationDto {
  id: string;
  relatedProductId: string;
  relatedProductName: string;
  relatedProductSku: string;
  type: ProductRelationType;
  position: number;
}

export interface AdminVariantDto {
  id: string;
  productId: string;
  sku: string;
  name: string | null;
  pricePaise: number | null;
  compareAtPricePaise: number | null;
  costPricePaise: number | null;
  position: number;
  isDefault: boolean;
  isActive: boolean;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  stockStatus: string;
  lowStockThreshold: number;
  allowBackorder: boolean;
  barcode: string | null;
  weightGrams: number | null;
  leadTimeDays: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  attributeValues: { attributeId: string; attributeValueId: string }[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminProductSummaryDto {
  id: string;
  sku: string;
  slug: string;
  name: string;
  status: string;
  productType: string;
  visibility: string;
  brandId: string | null;
  taxClassId: string | null;
  basePricePaise: number;
  completenessScore: number;
  variantCount: number;
  mediaCount: number;
  totalStock: number;
  primaryCategoryId: string | null;
  publishedAt: string | null;
  lastPublishedAt: string | null;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AdminProductDetailDto extends AdminProductSummaryDto {
  subtitle: string | null;
  shortDescription: string | null;
  description: string | null;
  compareAtPricePaise: number | null;
  costPricePaise: number | null;
  isMadeToOrder: boolean;
  leadTimeDays: number | null;
  allowCustomization: boolean;
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
  isFeatured: boolean;
  isNewArrival: boolean;
  isSpecialCollection: boolean;
  isBestSeller: boolean;
  minOrderQty: number;
  maxOrderQty: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  searchKeywords: string | null;
  categories: { categoryId: string; isPrimary: boolean; position: number }[];
  attributeValues: {
    attributeId: string;
    attributeValueId: string | null;
    valueText: string | null;
    valueNumber: number | null;
    valueBoolean: boolean | null;
    position: number;
  }[];
  variants: AdminVariantDto[];
  media: {
    id: string;
    mediaId: string;
    role: string;
    position: number;
    deviceTarget: string;
    attributeValueId: string | null;
    variantId: string | null;
    url: string;
    status: string;
  }[];
  relations: ProductRelationDto[];
  priceAdjustmentIds: string[];
  completeness: ProductCompletenessDto;
  publishBlockers: PublishBlockerDto[];
}

export interface MatrixCombinationDto {
  key: string;
  values: { attributeId: string; attributeValueId: string; label: string }[];
  sku: string;
  name: string;
  exists: boolean;
  existingVariantId: string | null;
}

export interface VariantMatrixPreviewDto {
  productId: string;
  total: number;
  newCount: number;
  existingCount: number;
  orphanedVariantIds: string[];
  combinations: MatrixCombinationDto[];
}

export interface InventoryLedgerEntryDto {
  id: string;
  variantId: string;
  delta: number;
  balanceAfter: number;
  reason: InventoryReason;
  refType: string | null;
  refId: string | null;
  note: string | null;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

export interface InventorySnapshotDto {
  variantId: string;
  sku: string;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  stockStatus: string;
  lowStockThreshold: number;
  allowBackorder: boolean;
}

export interface ImportRowErrorDto {
  row: number;
  column: string | null;
  message: string;
}

export interface ImportJobDto {
  id: string;
  entity: ImportEntity;
  status: ImportStatus;
  fileName: string;
  dryRun: boolean;
  totalRows: number;
  processedRows: number;
  successRows: number;
  errorRows: number;
  errors: ImportRowErrorDto[];
  summary: Record<string, number> | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface BulkActionItemResultDto {
  id: string;
  ok: boolean;
  code: string | null;
  message: string | null;
}

export interface BulkActionResultDto {
  action: BulkActionType;
  requested: number;
  succeeded: number;
  failed: number;
  results: BulkActionItemResultDto[];
}

export interface PriceAdjustmentConflictDto {
  scope: string;
  priority: number;
  window: { startsAt: string | null; endsAt: string | null };
  adjustmentIds: string[];
  names: string[];
}
