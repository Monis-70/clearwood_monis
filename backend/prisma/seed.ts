import { seedDemoEnabled } from '../src/config/env';
import { logger } from '../src/config/logger';
import { disconnectPrisma } from '../src/config/prisma';
import { categoryService, closeDrivers } from '../src/container';

import { seedSettings } from './seed/01-settings';
import { seedTaxClasses } from './seed/02-tax-classes';
import { seedAttributes } from './seed/03-attributes';
import { seedCategories } from './seed/04-categories';
import { seedCollections } from './seed/05-collections';
import { seedNavigation } from './seed/06-navigation';
import { seedDemoCatalog } from './seed/07-demo-catalog';
import { seedPermissions } from './seed/08-permissions';
import { seedRoles } from './seed/09-roles';
import { seedAdminUser } from './seed/10-admin-user';
import { seedDemoCustomers } from './seed/11-demo-customers';
import { seedMediaFolders } from './seed/12-media-folders';
import { seedBrands } from './seed/13-brands';
import { backfillCompleteness, seedInventory } from './seed/14-inventory';
import { seedPricingSettings } from './seed/15-pricing-settings';
import { seedCustomerGroups } from './seed/16-customer-groups';
import { seedShipping } from './seed/17-shipping';
import { seedCoupons } from './seed/18-coupons';
import { seedTierPrices } from './seed/19-tier-prices';
import { seedStorefrontSettings } from './seed/20-storefront-settings';
import { seedSearchSynonyms } from './seed/21-search-synonyms';
import { seedSearchIndex } from './seed/22-search-index';
import { seedCollectionMembership } from './seed/23-collection-evaluate';
import { seedIndianStates } from './seed/24-indian-states';
import { seedDemoCarts } from './seed/25-demo-carts';
import { seedDemoAddresses } from './seed/26-demo-addresses';
import { seedDemoWishlists } from './seed/27-demo-wishlists';
import { seedSplitAccounts } from './seed/28-split-accounts';
import { seedSplitRules } from './seed/29-split-rules';
import { seedPaymentSettings } from './seed/30-payment-settings';
import { seedDemoOrders } from './seed/31-demo-orders';
import { seedShippingProviders } from './seed/32-shipping-providers';
import { seedFulfilmentSettings } from './seed/33-fulfilment-settings';
import { seedDemoFulfilment } from './seed/34-demo-fulfilment';
import { seedNotificationTemplates } from './seed/35-notification-templates';
import { seedCmsSettings } from './seed/37-cms-settings';
import { seedPages } from './seed/38-pages';
import { seedHomepage } from './seed/39-homepage';
import { seedBanners } from './seed/40-banners';
import { seedFaqs } from './seed/41-faqs';
import { seedHelpCenter } from './seed/42-help-center';
import { seedTestimonialsAndStores } from './seed/43-testimonials-stores';
import { log, prisma, rowCounts } from './seed/context';
import { backfillProductMediaUsage, purgeLegacySvgSeedMedia } from './seed/media-assets';

/**
 * Fully idempotent seed: run it as often as you like.
 *
 * Structural catalog data (tax classes, attributes, categories, collections, navigation, customer
 * groups, brands, synonyms) is CREATE-ONLY: a re-run adds what is missing and never rewrites,
 * reorders, re-activates or resurrects a row an admin changed or removed. Settings rows keep the
 * admin's value; only their code-owned metadata (group, type, public flag) is refreshed.
 * The demo steps (SEED_DEMO, development only) may reset their own demo rows.
 */

async function main(): Promise<void> {
  // The services the seed reuses share the API's logger; keep their dev SQL tracing out of the way.
  if (logger.level === 'debug' || logger.level === 'trace') logger.level = 'info';

  await seedSettings();
  await seedTaxClasses();
  await seedAttributes();
  const createdCategories = await seedCategories();
  const createdCollections = await seedCollections();
  await seedNavigation({ categories: createdCategories, collections: createdCollections });
  // Media folders must exist before the demo catalog uploads anything into them.
  await seedMediaFolders();
  // Pricing configuration is structural: the engine needs it with or without demo data.
  await seedPricingSettings();
  await seedCustomerGroups();
  await seedShipping();
  // Storefront page sizes, the popularity formula and query synonyms are structural too.
  await seedStorefrontSettings();
  await seedSearchSynonyms();
  // Reference data for addresses and for the GST place-of-supply decision.
  await seedIndianStates();
  // Payout accounts, the split policy and the payment switches are all structural too.
  await seedSplitAccounts();
  await seedSplitRules();
  await seedPaymentSettings();
  await seedShippingProviders();
  await seedFulfilmentSettings();
  // Templates are structural: an order placed on a fresh install must still be able to email.
  await seedNotificationTemplates();

  /*
   * CMS. Order matters: the homepage references FAQs and testimonials, so they exist first.
   * Content is structural, not demo data — a fresh install must have a privacy policy.
   */
  await seedCmsSettings();
  await seedFaqs();
  await seedHelpCenter();
  await seedTestimonialsAndStores();
  await seedPages();

  if (seedDemoEnabled) {
    await seedDemoCatalog();
    await purgeLegacySvgSeedMedia();
    await backfillProductMediaUsage();
    await seedBrands();
    await seedInventory();
    await backfillCompleteness();
    await seedCoupons();
    await seedTierPrices();
    const updated = await categoryService.recomputeProductCounts();
    log('demo-catalog', `${updated} category product counts refreshed`);

    // Membership first, then the index: collections feed the documents they appear in.
    await seedCollectionMembership();
    await seedSearchIndex();
  } else {
    log('demo-catalog', 'skipped (SEED_DEMO is off)');
  }

  await seedPermissions();
  await seedRoles();
  await seedAdminUser();

  if (seedDemoEnabled) {
    await seedDemoCustomers();
    // Carts, addresses and wishlists all hang off the demo customers and the demo catalog.
    await seedDemoAddresses();
    await seedDemoWishlists();
    await seedDemoCarts();
    // Orders come last: they run the real checkout against the mock payment driver.
    await seedDemoOrders();
    // Fulfilment runs LAST and drives the real services: shipments, a return, an NDR and a refund.
    await seedDemoFulfilment();

    // The homepage references real categories, collections and media, so it is built after them.
    await seedHomepage();
    await seedBanners();
  } else {
    log('demo-customers', 'skipped (SEED_DEMO is off)');
  }

  console.table(await rowCounts());
}

main()
  .catch((error) => {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The services the seed reuses open the cache driver (a Redis socket that keeps the process alive).
    await closeDrivers();
    await prisma.$disconnect();
    await disconnectPrisma();
  });
