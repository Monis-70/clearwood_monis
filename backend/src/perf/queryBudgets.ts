/**
 * The query budget for every hot path, and the rules that govern it.
 *
 * WHY THESE EXIST. Development runs on SQLite over a local file, where a query costs microseconds
 * and a hundred of them are invisible. Production runs on a hosted MySQL over a network, where
 * every query is a round trip of a millisecond or more. A page that issues a hundred queries is
 * fine on a laptop and is a tenth of a second of pure latency before any work is done. The budget
 * is therefore a COUNT, not a duration: counts are deterministic and reviewable, while durations
 * depend on whichever machine happened to run the test.
 *
 * `measured` is the number observed by tests/query-budgets.test.ts against the seeded database,
 * with page caches dropped so the COLD path is what gets counted. `ceiling` is that number plus a
 * small margin. A path over its ceiling fails the build.
 *
 * RAISING A CEILING REQUIRES A RECORDED JUSTIFICATION, NOT AN EDIT. The `note` on a path that
 * misses its original target states the measured floor and the structural reason for it. Changing
 * a number here without adding that reasoning turns the budget into a rubber stamp.
 *
 * SCALE INVARIANCE. Where `scaleInvariant` is true the count must not change with the number of
 * items in the response: the same count for six products or forty-eight, for thirteen home blocks
 * or eighteen, for one cart line or ten. The test asserts equality, not a ceiling, because a
 * ceiling cannot tell a batched query from an N+1 that happens to have a short list today.
 *
 * CACHING MAY NOT BE USED TO MEET A BUDGET. A cache in front of a per-item query pattern leaves
 * the pattern in place: the first request after an invalidation still pays it, and the cost still
 * grows with the number of items. Batch the query instead. Request-scoped deduplication of
 * identical work is a different thing and is allowed — see src/utils/requestScope.ts.
 *
 * CONFIGURATION IS WARM, PAGES ARE COLD. Request-constant configuration (pricing settings, the
 * default customer group and tax class, shipping zones and rates) is cached and warmed before
 * measuring, as in steady state. Those caches expire every PRICING_CACHE_TTL_SECONDS, and a
 * priced path then costs about five statements more; the ceilings deliberately stay above that
 * cold-configuration count, so an expiry is never a failure while an N+1 still is.
 */

export interface QueryBudget {
  /** How the path is reached, for whoever reads a failure. */
  path: string;
  /** The count observed when this budget was last recorded. */
  measured: number;
  /** The failing threshold. */
  ceiling: number;
  /** When true the count must be IDENTICAL at every response size, not merely under the ceiling. */
  scaleInvariant: boolean;
  /** Required on any path that did not reach its original target: the floor and why. */
  note?: string;
}

export const QUERY_BUDGETS = {
  PDP: {
    path: 'GET /catalog/products/:slug',
    measured: 73,
    ceiling: 86,
    scaleInvariant: false,
    note:
      'Target was 25; the measured floor is 77 and 25 is unreachable without changing displayed ' +
      'prices. A product page issues three pricing quotes that cannot be merged into one cart: ' +
      'the variant price deltas (every variant at qty 1, public context), the product itself ' +
      '(the chosen variant at the requested qty, with the customer group, coupon and pincode), ' +
      'and the related rail (other products at qty 1). Merging any two changes the cart subtotal ' +
      'that free-shipping thresholds, cart-level coupon allocation and quantity tier bands are ' +
      'evaluated against, so the price shown would change. One quote alone costs 18. What was ' +
      'removed instead: the request-constant half of the pricing context (100 -> 86) and the ' +
      'product rows and category ancestry shared by two of the three quotes (86 -> 79). Prompt 4 ' +
      'dropped the unused ProductStat read from both card loads (79 -> 77). The performance pass ' +
      'cached the default customer group, default tax class and shipping zone/rates (77 -> 72). ' +
      'Catalog management: 73 - one liveness read (every category id, parent and flag) so a ' +
      'category under an inactive ancestor never shows; read fresh on purpose (PROJECT_CONTEXT §47).',
  },
  LISTING: {
    path: 'GET /catalog/products',
    measured: 30,
    ceiling: 44,
    scaleInvariant: true,
    note:
      'Prompt 4: 46 -> 38, and no statement grows with the catalog any more. The page is one ' +
      'SQL page query and one count (listing.repository), the cards for that page, one pricing ' +
      'quote for the whole grid (18, which cannot shrink without changing card prices) and four ' +
      'SQL facet aggregates. Constant at 6, 24 and 48 products. Performance pass: 30. The quote ' +
      'no longer re-reads the default customer group, default tax class and shipping zone/rates ' +
      '(cached, dropped by every pricing write); this figure had not been re-recorded since ' +
      'Prompt 5, so part of the drop from 38 predates the pass.',
  },
  HOME: {
    path: 'pageRendererService.renderHome',
    measured: 36,
    ceiling: 46,
    scaleInvariant: true,
    note:
      'Target was 25; the measured floor is 40. The home page renders product, collection and ' +
      'category blocks, and the product blocks are priced through the same 18-query quote. ' +
      'Constant at 13 and 18 blocks. Performance pass: 35, the quote now costs 13 (QUOTE_CART). ' +
      'Catalog management: 36 - the category liveness read, as PDP.',
  },
  QUOTE_CART: {
    path: 'pricingFacade.quoteCart',
    measured: 13,
    ceiling: 20,
    scaleInvariant: true,
    note:
      'Constant at 1 and 40 lines. This is the floor every priced page inherits. Performance ' +
      'pass: 18 -> 13 - the default customer group, default tax class, fallback shipping zone and ' +
      'its rates are configuration, cached under price:set:/price:ship: and dropped by every ' +
      'group, tax-class and shipping write (tests/mutation-consistency.test.ts).',
  },
  CART_READ: {
    path: 'GET /cart',
    measured: 27,
    ceiling: 42,
    scaleInvariant: true,
    note:
      'Was 50 at one line and 77 at ten, because a gallery was resolved per line. Now one batched ' +
      'media read covering every line, so the count no longer moves with the cart. Performance ' +
      'pass: 27 - the read used to price the cart twice (once for the DTO, again inside ' +
      'validation) and read line availability three times; it now shares one quote and one read.',
  },
  CHECKOUT_INIT: {
    path: 'POST /checkout/init',
    measured: 60,
    ceiling: 90,
    scaleInvariant: true,
    note:
      'The highest budget in the table and the one needing the most justification: it writes the ' +
      'addresses, revalidates the cart, and quotes it both without and with a delivery pincode, ' +
      'so zone-dependent work is genuinely done twice against different inputs rather than ' +
      'repeated. Constant at 1 and 5 cart lines. Performance pass: 80 -> 60 - the serviceability ' +
      'checks and both quotes used to resolve the delivery zone and its rates from MySQL each ' +
      'time; zones and rates are now cached configuration (price:ship:).',
  },
  SEARCH: {
    path: 'GET /search',
    measured: 38,
    ceiling: 50,
    scaleInvariant: true,
    note:
      'The listing floor plus the search document scan and the brand/collection/category hits. ' +
      'The hit list is bounded by SEARCH_MAX_RESULTS and filtered in SQL. Constant across ' +
      'result-set sizes. Performance pass: 42 -> 37 on the seed catalog (the listing quote, as ' +
      'LISTING). The scan now reads short columns only; a document whose checksum the process ' +
      'has not seen adds one read of its text, which the warm-up in the test has already paid. ' +
      'Catalog management: 38 - the category liveness read filters the category hits.',
  },
  CATEGORY_LANDING: {
    path: 'GET /catalog/categories/:slug',
    measured: 3,
    ceiling: 6,
    scaleInvariant: false,
    note: 'Resolves the category and its ancestry only; the grid is a separate request.',
  },
  ADMIN_ORDER_DETAIL: {
    path: 'GET /admin/orders/:id',
    measured: 42,
    ceiling: 48,
    scaleInvariant: false,
    note:
      'One order with its items, addresses, payments, transfers, reversals, refunds, shipments ' +
      'and audit trail. Each is a distinct relation, not a repeat of the same one.',
  },
  // Prompt 3 baseline. Counts are cold (page caches dropped) against the seeded catalog.
  CATEGORY_TREE: {
    path: 'GET /catalog/categories/tree',
    measured: 1,
    ceiling: 2,
    scaleInvariant: false,
    note: 'One Category read; the tree is assembled in memory from that single result.',
  },
  CATEGORY_LISTING: {
    path: 'GET /catalog/products?categorySlug=',
    measured: 30,
    ceiling: 42,
    scaleInvariant: true,
    note:
      'The LISTING shape scoped to one category (plus its subtree lookup), constant at 2 and 24 ' +
      'products. Prompt 4 moved filtering, sorting and paging into MySQL, so neither the count ' +
      'nor the size of any statement grows with the category (PROJECT_CONTEXT §44). Performance ' +
      'pass: 34 -> 29 on the seed catalog, the cached pricing configuration as in LISTING. ' +
      'Catalog management: 30 - the category liveness read (an inactive ancestor hides the scope).',
  },
  FILTERS: {
    path: 'GET /catalog/filters',
    measured: 5,
    ceiling: 9,
    scaleInvariant: false,
    note:
      'Scope resolution (Category x2) plus the facet scan and the facet counts in SQL - since ' +
      "Prompt 5's attribute projection; not a performance-pass change (this path prices nothing). " +
      'It used to run the whole listing and a pricing quote for one card just to obtain the ' +
      'candidate ids (45). Catalog management: 5 - the category liveness read, as CATEGORY_LISTING.',
  },
  PRODUCT_OPTIONS: {
    path: 'GET /catalog/products/:slug/options',
    measured: 35,
    ceiling: 45,
    scaleInvariant: false,
    note:
      'Variants and their option values in batched reads, plus one pricing quote (13 since the ' +
      'performance pass cached the pricing configuration; 40 -> 35).',
  },
  PRODUCT_GALLERY: {
    path: 'GET /catalog/products/:slug/gallery',
    measured: 17,
    ceiling: 20,
    scaleInvariant: false,
    note: 'Product, gallery rows, media and renditions batched; no per-image query.',
  },
  RESOLVE: {
    path: 'GET /catalog/resolve',
    measured: 1,
    ceiling: 3,
    scaleInvariant: false,
    note: 'A product slug resolves on its unique index in one read.',
  },
  ADMIN_PRODUCT_LIST: {
    path: 'GET /admin/catalog/products',
    measured: 10,
    ceiling: 16,
    scaleInvariant: true,
    note:
      'Page, count and one batched read per relation; constant at 2 and 50 rows. Catalog ' +
      'management: 14 -> 10 - a compact row select (scalars, primary category id, one thumbnail ' +
      'rendition, gallery count) instead of the full admin graph per product.',
  },
  ADMIN_VARIANTS: {
    path: 'GET /admin/catalog/products/:id/variants',
    measured: 5,
    ceiling: 6,
    scaleInvariant: false,
    note: 'Session (3), variants, and their option values in one batched read.',
  },
} as const satisfies Record<string, QueryBudget>;

export type QueryBudgetName = keyof typeof QUERY_BUDGETS;
