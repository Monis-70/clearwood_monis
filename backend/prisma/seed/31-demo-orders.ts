import type { MockPaymentDriver } from '../../src/drivers/payment';
import { payment as paymentDriver } from '../../src/container';
import { cartService } from '../../src/modules/cart/cart.service';
import { checkoutService } from '../../src/modules/orders/checkout.service';
import { orderRepository } from '../../src/repositories/order.repository';

import { epochMinus } from './epoch';
import { log, prisma } from './context';

/**
 * Demo orders, created by RUNNING THE REAL CHECKOUT against the mock payment driver.
 *
 * Nothing here is hand-written into the tables. Each order goes through `checkout.init`,
 * `checkout.place` and the mock provider's own signed verification, so the seeded data exercises
 * exactly the code a customer would — reservations, coupon redemption, split allocations, transfers
 * and the ledger all end up consistent because they were produced the same way they will be in
 * production. Fabricated rows would look right and prove nothing.
 *
 * Five shapes:
 *   1. a CONFIRMED paid order with two split transfers;
 *   2. a PAYMENT_FAILED order with every hold released;
 *   3. a PENDING_PAYMENT order that is already past its expiry, for the sweep to find;
 *   4. a COD order, confirmed with no provider call and no transfers;
 *   5. a second paid order, so the admin list has something to page through.
 *
 * Idempotent: every order is tagged in `internalNote` and the whole step is skipped if it is there.
 */

interface OrderSpec {
  key: string;
  slug: string;
  qty: number;
  provider: 'RAZORPAY' | 'COD';
  outcome: 'PAID' | 'FAILED' | 'PENDING_EXPIRED';
  couponCode?: string;
}

const SPECS: OrderSpec[] = [
  {
    key: 'paid-split',
    slug: 'kabir-3-seater-fabric-sofa',
    qty: 1,
    provider: 'RAZORPAY',
    outcome: 'PAID',
  },
  {
    key: 'paid-coupon',
    slug: 'banyan-live-edge-coffee-table',
    qty: 2,
    provider: 'RAZORPAY',
    outcome: 'PAID',
    couponCode: 'WELCOME10',
  },
  { key: 'failed', slug: 'nilgiri-rocking-chair', qty: 1, provider: 'RAZORPAY', outcome: 'FAILED' },
  {
    key: 'pending-expired',
    slug: 'mahseer-counter-stool',
    qty: 1,
    provider: 'RAZORPAY',
    outcome: 'PENDING_EXPIRED',
  },
  { key: 'cod', slug: 'konark-storage-bench', qty: 1, provider: 'COD', outcome: 'PAID' },
];

const ADDRESS = {
  fullName: 'Aarav Mehta',
  phone: '919810000001',
  line1: '14 Sagar Villa, Marine Drive',
  city: 'Mumbai',
  state: 'Maharashtra',
  stateCode: 'MH',
  pincode: '400001',
  country: 'IN',
};

function tag(key: string): string {
  return `seed:demo-order:${key}`;
}

export async function seedDemoOrders(): Promise<void> {
  if (paymentDriver.name !== 'mock') {
    log('demo-orders', 'skipped (only the mock payment driver may create demo orders)');
    return;
  }

  const mock = paymentDriver as MockPaymentDriver;
  const customer = await prisma.customer.findUnique({
    where: { email: 'aarav.mehta@example.com' },
  });

  if (!customer) {
    log('demo-orders', 'skipped (demo customers are not seeded)');
    return;
  }

  let created = 0;

  for (const spec of SPECS) {
    const existing = await prisma.order.findFirst({ where: { internalNote: tag(spec.key) } });
    if (existing) continue;

    const product = await prisma.product.findUnique({
      where: { slug: spec.slug },
      include: { variants: { where: { deletedAt: null }, take: 1 } },
    });
    if (!product) continue;

    // A dedicated guest cart per order, so the seeded shopper carts from step 25 stay untouched.
    const owner = { customerId: null, sessionId: `seed-order-${spec.key}`, isNewSession: false };

    const cart = await cartService.getOrCreate(owner);
    await cartService.addItem(cart, {
      productId: product.id,
      variantId: product.variants[0]?.id ?? null,
      optionValueIds: [],
      qty: spec.qty,
    });

    let loaded = await cartService.reload(cart.id);
    if (spec.couponCode) {
      await cartService.applyCoupon(loaded, spec.couponCode);
      loaded = await cartService.reload(cart.id);
    }

    const session = await checkoutService.init(
      loaded,
      {
        contact: { email: 'aarav.mehta@example.com', phone: '919810000001' },
        shippingAddress: { ...ADDRESS, type: 'HOME', usage: 'BOTH' } as never,
        sameAsShipping: true,
      },
      owner,
    );

    mock.setScenario('success');

    const placed = await checkoutService.place(
      session.id,
      { paymentProvider: spec.provider },
      owner,
    );

    if (spec.provider === 'RAZORPAY' && spec.outcome === 'PAID') {
      // The mock signs with a real HMAC, so this goes through the production verification path.
      const completed = mock.simulateCheckout(placed.providerOrderId!);
      await checkoutService.verifyPayment(completed);
    }

    if (spec.outcome === 'FAILED') {
      const order = await orderRepository.findById(placed.orderId);
      if (order) await checkoutService.failOrder(order, 'SEEDED_FAILURE');
    }

    if (spec.outcome === 'PENDING_EXPIRED') {
      // Backdated so the reconciliation sweep has something real to pick up.
      await prisma.order.update({
        where: { id: placed.orderId },
        data: { expiresAt: epochMinus(0, 1) },
      });
    }

    await prisma.order.update({
      where: { id: placed.orderId },
      data: { internalNote: tag(spec.key), customerId: customer.id, isGuest: false },
    });

    created += 1;
  }

  const confirmed = await prisma.order.count({ where: { status: 'CONFIRMED' } });
  const transfers = await prisma.paymentTransfer.count();

  log(
    'demo-orders',
    `${SPECS.length} demo orders ensured (${created} created, ${confirmed} confirmed, ${transfers} transfers)`,
  );
}
