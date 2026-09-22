import request from 'supertest';

import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';
import { payment as paymentDriver } from '../../src/container';
import type { MockPaymentDriver } from '../../src/drivers/payment';
import { orderRepository } from '../../src/repositories/order.repository';

/** Cart to captured payment, the way a real shopper gets there. Shared by the refund test files. */

const app = createApp();
const API = '/api/v1';
const mock = paymentDriver as MockPaymentDriver;

const DEFAULT_ADDRESS = {
  fullName: 'Fixture Buyer',
  phone: '919810000123',
  line1: '14 Residency Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  stateCode: 'KA',
  pincode: '560025',
};

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** A guest browser that carries its signed cart cookie and CSRF token forward by hand. */
export class Shopper {
  private cookies = '';
  private csrf = '';

  private remember(response: request.Response): void {
    const jar = cookiesOf(response);
    if (jar.length === 0) return;

    this.cookies = jar.map((cookie) => cookie.split(';')[0]).join('; ');
    const token = jar
      .find((cookie) => cookie.startsWith('cw_csrf='))
      ?.split(';')[0]
      ?.split('=')[1];
    if (token) this.csrf = token;
  }

  async get(path: string): Promise<request.Response> {
    const response = await request(app).get(`${API}${path}`).set('Cookie', this.cookies);
    this.remember(response);
    return response;
  }

  async post(path: string, body: Record<string, unknown>): Promise<request.Response> {
    if (!this.csrf) await this.get('/cart');

    const response = await request(app)
      .post(`${API}${path}`)
      .set('Cookie', this.cookies)
      .set('x-csrf-token', this.csrf)
      .send(body);

    this.remember(response);
    return response;
  }
}

export interface PaidOrderFixture {
  orderId: string;
  orderNumber: string;
  paidPaise: number;
  itemId: string;
  itemQty: number;
}

export async function placeAndPayOrder(
  options: { qty?: number; slug?: string } = {},
): Promise<PaidOrderFixture> {
  const shopper = new Shopper();
  const slug = options.slug ?? 'nilgiri-rocking-chair';

  const product = await prisma.product.findUniqueOrThrow({
    where: { slug },
    include: { variants: { where: { deletedAt: null }, take: 1 } },
  });

  await shopper.post('/cart/items', {
    productId: product.id,
    variantId: product.variants[0]?.id ?? null,
    qty: options.qty ?? 2,
  });

  const init = await shopper.post('/checkout/init', {
    contact: { email: 'fixture.buyer@example.com', phone: DEFAULT_ADDRESS.phone },
    shippingAddress: DEFAULT_ADDRESS,
    sameAsShipping: true,
  });

  if (init.status !== 201) {
    throw new Error(`checkout/init failed: ${init.status} ${JSON.stringify(init.body)}`);
  }

  const placed = await shopper.post(`/checkout/${init.body.data.id}/place`, {
    paymentProvider: 'RAZORPAY',
  });

  if (placed.status !== 201) {
    throw new Error(`checkout/place failed: ${placed.status} ${JSON.stringify(placed.body)}`);
  }

  const completed = mock.simulateCheckout(placed.body.data.providerOrderId);
  const verified = await shopper.post('/checkout/verify', completed);

  if (verified.status !== 200) {
    throw new Error(`checkout/verify failed: ${verified.status}`);
  }

  const order = await orderRepository.findByNumber(placed.body.data.orderNumber);
  if (!order) throw new Error('order not found after payment');

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    paidPaise: order.paidPaise,
    itemId: order.items[0]!.id,
    itemQty: order.items[0]!.qty,
  };
}
