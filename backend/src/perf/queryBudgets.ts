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
    measured: 79,
    ceiling: 88,
    scaleInvariant: false,
    note:
      'Target was 25; the measured floor is 79 and 25 is unreachable without changing displayed ' +
      'prices. A product page issues three pricing quotes that cannot be merged into one cart: ' +
      'the variant price deltas (every variant at qty 1, public context), the product itself ' +
      '(the chosen variant at the requested qty, with the customer group, coupon and pincode), ' +
      'and the related rail (other products at qty 1). Merging any two changes the cart subtotal ' +
      'that free-shipping thresholds, cart-level coupon allocation and quantity tier bands are ' +
      'evaluated against, so the price shown would change. One quote alone costs 18. What was ' +
      'removed instead: the request-constant half of the pricing context (100 -> 86) and the ' +
      'product rows and category ancestry shared by two of the three quotes (86 -> 79).',
  },
  LISTING: {
    path: 'GET /catalog/products',
    measured: 46,
    ceiling: 52,
    scaleInvariant: true,
    note:
      'Target was 25; the measured floor is 46. The page is the listing query plus facet counting ' +
      'plus one pricing quote for the whole grid (18), and the quote cannot shrink without ' +
      'changing the prices on the cards. Constant at 6, 24 and 48 products.',
  },
  HOME: {
    path: 'pageRendererService.renderHome',
    measured: 41,
    ceiling: 46,
    scaleInvariant: true,
    note:
      'Target was 25; the measured floor is 41. The home page renders product, collection and ' +
      'category blocks, and the product blocks are priced through the same 18-query quote. ' +
      'Constant at 13 and 18 blocks.',
  },
  QUOTE_CART: {
    path: 'pricingFacade.quoteCart',
    measured: 18,
    ceiling: 20,
    scaleInvariant: true,
    note: 'Constant at 1 and 40 lines. This is the floor every priced page inherits.',
  },
  CART_READ: {
    path: 'GET /cart',
    measured: 36,
    ceiling: 42,
    scaleInvariant: true,
    note:
      'Was 50 at one line and 77 at ten, because a gallery was resolved per line. Now one batched ' +
      'media read covering every line, so the count no longer moves with the cart.',
  },
  CHECKOUT_INIT: {
    path: 'POST /checkout/init',
    measured: 80,
    ceiling: 90,
    scaleInvariant: true,
    note:
      'The highest budget in the table and the one needing the most justification: it writes the ' +
      'addresses, revalidates the cart, and quotes it both without and with a delivery pincode, ' +
      'so zone-dependent work is genuinely done twice against different inputs rather than ' +
      'repeated. Constant at 1 and 5 cart lines.',
  },
  SEARCH: {
    path: 'GET /search',
    measured: 52,
    ceiling: 58,
    scaleInvariant: true,
    note:
      'Target was 25; the measured floor is 52 — the listing floor plus the search document ' +
      'lookup and the brand facet. Constant across result-set sizes.',
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
} as const satisfies Record<string, QueryBudget>;

export type QueryBudgetName = keyof typeof QUERY_BUDGETS;
