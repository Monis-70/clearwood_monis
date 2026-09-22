import { env } from './config/env';
import { createCache, type CacheDriver } from './drivers/cache';
import { createMailer, type MailDriver } from './drivers/mail';
import { createOtpSender, type OtpDriver } from './drivers/otp';
import { createPayment, type PaymentDriver } from './drivers/payment';
import { createSearch, type SearchDriver } from './drivers/search';
import { createShipping, type ShippingProviderDriverContract } from './drivers/shipping';
import { createStorage, type StorageDriver } from './drivers/storage';

/**
 * Driver instances are created once, here, from `env`. Services depend on these interfaces —
 * never on a concrete implementation — so swapping memory -> redis or local -> s3 is config only.
 */

export const cache: CacheDriver = createCache(env);
export const storage: StorageDriver = createStorage(env);
export const mailer: MailDriver = createMailer(env);
export const otpSender: OtpDriver = createOtpSender(env);
export const search: SearchDriver = createSearch(env);
export const payment: PaymentDriver = createPayment(env);
export const shipping: ShippingProviderDriverContract = createShipping(env);

export async function closeDrivers(): Promise<void> {
  await cache.close();
}

/**
 * Repository and service registry. These are re-exports rather than an eager object on purpose:
 * services import `cache`/`storage` from this same module, and a lazy binding is what keeps that
 * cycle safe.
 */

export { attributeRepository } from './repositories/attribute.repository';
export { adminUserRepository } from './repositories/adminUser.repository';
export { auditLogRepository } from './repositories/auditLog.repository';
export { categoryRepository } from './repositories/category.repository';
export { collectionRepository } from './repositories/collection.repository';
export { customerRepository } from './repositories/customer.repository';
export { loginAttemptRepository } from './repositories/loginAttempt.repository';
export { mediaRepository } from './repositories/media.repository';
export { mediaFolderRepository } from './repositories/mediaFolder.repository';
export { mediaUsageRepository } from './repositories/mediaUsage.repository';
export { navigationRepository } from './repositories/navigation.repository';
export {
  otpChallengeRepository,
  verificationTokenRepository,
} from './repositories/otpChallenge.repository';
export { priceAdjustmentRepository } from './repositories/priceAdjustment.repository';
export { productRepository } from './repositories/product.repository';
export { productMediaRepository } from './repositories/productMedia.repository';
export { refreshTokenRepository } from './repositories/refreshToken.repository';
export { roleRepository } from './repositories/role.repository';
export { settingRepository } from './repositories/setting.repository';
export { taxClassRepository } from './repositories/taxClass.repository';
export { variantRepository } from './repositories/variant.repository';

export { attributeService } from './services/attribute.service';
export { categoryService } from './services/category.service';
export {
  categoryAttributeService,
  invalidateCatalogCache,
} from './services/categoryAttribute.service';
export { categoryPathService } from './services/categoryPath.service';
export { navigationService } from './services/navigation.service';
export { productService } from './services/product.service';
export { settingService } from './services/setting.service';

export { adminAuthService } from './modules/auth/admin-auth.service';
export { adminUserService } from './modules/auth/admin-user.service';
export { auditService } from './modules/auth/audit.service';
export { cookieService } from './modules/auth/cookie.service';
export { csrfService } from './modules/auth/csrf.service';
export { customerAuthService } from './modules/auth/customer-auth.service';
export { otpService } from './modules/auth/otp.service';
export { passwordService } from './modules/auth/password.service';
export { rbacService } from './modules/auth/rbac.service';
export { roleService } from './modules/auth/role.service';
export { tokenService } from './modules/auth/token.service';

export { galleryResolver } from './modules/media/gallery.resolver';
export { imageProcessor } from './modules/media/image.processor';
export { mediaFolderService } from './modules/media/mediaFolder.service';
export { mediaService } from './modules/media/media.service';
export { mediaUsageService } from './modules/media/media-usage.service';
export { productMediaService } from './modules/media/product-media.service';

export { attributeAdminService } from './modules/catalog-admin/attribute.admin.service';
export { brandAdminService } from './modules/catalog-admin/brand.admin.service';
export { bulkActionService } from './modules/catalog-admin/bulkAction.service';
export { catalogCacheService } from './modules/catalog-admin/catalogCache.service';
export { categoryAdminService } from './modules/catalog-admin/category.admin.service';
export { collectionAdminService } from './modules/catalog-admin/collection.admin.service';
export { inventoryService } from './modules/catalog-admin/inventory.service';
export { priceAdjustmentAdminService } from './modules/catalog-admin/priceAdjustment.admin.service';
export { productAdminService } from './modules/catalog-admin/product.admin.service';
export { slugRedirectService } from './modules/catalog-admin/slugRedirect.service';
export { taxClassAdminService } from './modules/catalog-admin/taxClass.admin.service';
export { variantAdminService } from './modules/catalog-admin/variant.admin.service';
export { variantMatrixService } from './modules/catalog-admin/variantMatrix.service';
export { exportService } from './modules/catalog-admin/import-export/export.service';
export { importService } from './modules/catalog-admin/import-export/import.service';

export { pricingEngine } from './modules/pricing/pricing.engine';
export { pricingFacade } from './modules/pricing/pricing.facade';
export { pricingContextLoader } from './modules/pricing/pricingContext.loader';
export { discountService } from './modules/pricing/discount.service';
export { couponRedemptionService } from './modules/pricing/coupon.redemption.service';
export { shippingService } from './modules/pricing/shipping.service';
export { taxService } from './modules/pricing/tax.service';
export {
  couponAdminService,
  customerGroupService,
  discountRuleService,
  priceListService,
  pricingSettingsService,
  shippingAdminService,
  tierPriceService,
} from './modules/pricing/pricingAdmin.service';

export {
  searchDocumentRepository,
  searchSynonymRepository,
} from './repositories/searchDocument.repository';
export { storefrontRepository } from './repositories/storefront.repository';
export { collectionRulesService } from './modules/storefront/collectionRules.service';
export { facetService } from './modules/storefront/facet.service';
export { optionAvailabilityService } from './modules/storefront/optionAvailability.service';
export { pdpService } from './modules/storefront/pdp.service';
export { popularityService } from './modules/storefront/popularity.service';
export { productQueryService } from './modules/storefront/productQuery.service';
export { redirectService } from './modules/storefront/redirect.service';
export { searchAdminService } from './modules/storefront/searchAdmin.service';
export { searchAnalyticsService } from './modules/storefront/searchAnalytics.service';
export { searchIndexerService } from './modules/storefront/searchIndexer.service';
export { settingsService as storefrontSettingsService } from './modules/storefront/storefrontSettings.service';
export { storefrontFacade } from './modules/storefront/storefront.facade';
export { suggestionService } from './modules/storefront/suggestion.service';

export {
  addressRepository,
  cartRepository,
  recentlyViewedRepository,
  wishlistRepository,
} from './repositories/cart.repository';
export { cartIdentity } from './modules/cart/cartIdentity';
export { cartService } from './modules/cart/cart.service';
export { cartPricingService } from './modules/cart/cartPricing.service';
export { cartValidationService } from './modules/cart/cartValidation.service';
export { cartMergeService } from './modules/cart/cartMerge.service';
export { cartExpiryService } from './modules/cart/cartExpiry.service';
export { cartAdminService } from './modules/cart/cartAdmin.service';
export { recentlyViewedService } from './modules/cart/recentlyViewed.service';
export { wishlistService } from './modules/wishlist/wishlist.service';
export { addressService } from './modules/address/address.service';

export {
  checkoutSessionRepository,
  orderRepository,
  orderSequenceRepository,
  stockReservationRepository,
} from './repositories/order.repository';
export {
  paymentRepository,
  paymentTransferRepository,
  refundRepository,
  settlementRepository,
  splitAccountRepository,
  splitAllocationRepository,
  splitRuleRepository,
  transferReversalRepository,
  webhookEventRepository,
} from './repositories/payment.repository';
export { checkoutService } from './modules/orders/checkout.service';
export { orderService } from './modules/orders/order.service';
export { orderNumberService } from './modules/orders/orderNumber.service';
export { orderStateMachine } from './modules/orders/orderStateMachine';
export { webhookService } from './modules/orders/webhook.service';
export { reconciliationService } from './modules/orders/reconciliation.service';
export { ledgerIntegrityService } from './modules/orders/ledgerIntegrity.service';
export { splitService } from './modules/payments/split/split.service';
export { paymentAdminService } from './modules/payments/paymentAdmin.service';
