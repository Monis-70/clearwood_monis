import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TEMPLATED_NOTIFICATION_EVENTS } from '@shared/enums';

import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { mailer, payment as paymentDriver } from '../src/container';
import type { MockPaymentDriver } from '../src/drivers/payment';
import { passwordService } from '../src/modules/auth/password.service';
import { maskRecipient } from '../src/modules/notifications/maskRecipient';
import {
  notificationService,
  orderContext,
} from '../src/modules/notifications/notification.service';
import {
  renderTemplate,
  tokensIn,
} from '../src/modules/notifications/templateRenderer';

import { placeAndPayOrder, type PaidOrderFixture } from './helpers/paidOrder';
import { setStockForProduct } from './helpers/stock';

/**
 * Slice C - order-lifecycle notifications.
 *
 * The three properties that matter, in order of how much damage their absence would do:
 *
 *  1. A notification failure never touches the order. Asserted by breaking the mail driver during
 *     a real, paid order confirmation and then checking the money and the status are untouched.
 *  2. The template engine evaluates nothing. Asserted against injection-shaped templates.
 *  3. No plaintext recipient reaches NotificationLog.
 */

const app = createApp();
const API = '/api/v1';
const ADMIN_API = `${API}/admin`;
const mock = paymentDriver as MockPaymentDriver;
const SLUG = 'goli-pouffe';
const TEST_PASSWORD = 'Rosewood-Teak-2026';

interface Session {
  header: string;
  csrf: string;
}

function cookiesOf(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

async function admin(email: string, roleCode: string): Promise<Session> {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });

  const user = await prisma.adminUser.upsert({
    where: { email },
    update: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null, deletedAt: null },
    create: {
      email,
      name: `Notify ${roleCode}`,
      passwordHash: await passwordService.hash(TEST_PASSWORD),
      status: 'ACTIVE',
    },
  });

  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
    update: {},
    create: { adminUserId: user.id, roleId: role.id },
  });

  const response = await request(app)
    .post(`${ADMIN_API}/auth/login`)
    .send({ email, password: TEST_PASSWORD });

  const jar = cookiesOf(response);
  return {
    header: jar.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf:
      jar
        .find((cookie) => cookie.startsWith('cw_adm_csrf='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '',
  };
}

function get(session: Session, path: string) {
  return request(app).get(`${ADMIN_API}${path}`).set('Cookie', session.header);
}

function put(session: Session, path: string, body: Record<string, unknown>) {
  return request(app)
    .put(`${ADMIN_API}${path}`)
    .set('Cookie', session.header)
    .set('X-CSRF-Token', session.csrf)
    .send(body);
}

let superAdmin: Session;

beforeAll(async () => {
  mock.setScenario('success');
  mock.setReversesTransfersWithRefund(false);

  superAdmin = await admin('notify.super@clearwood.local', 'SUPER_ADMIN');
  await setStockForProduct(SLUG, 400);
});

/* ------------------------------------------------------ template renderer */

describe('template interpolation', () => {
  const context = { orderNumber: 'CW/2026-27/000001', customerName: 'Ravi' };

  it('substitutes whitelisted tokens', () => {
    expect(renderTemplate('Order {{orderNumber}} for {{customerName}}', context)).toBe(
      'Order CW/2026-27/000001 for Ravi',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('{{  orderNumber  }}', context)).toBe('CW/2026-27/000001');
  });

  it('throws on an unknown token outside production', () => {
    expect(() => renderTemplate('Hello {{nope}}', context)).toThrow(/unknown token/i);
  });

  it('renders an unknown token as empty in production', () => {
    expect(renderTemplate('Hello {{nope}}!', context, { strict: false })).toBe('Hello !');
  });

  /**
   * Templates are admin-editable, so this is the security boundary. Every one of these is just an
   * unknown token: there is no expression evaluation to reach.
   */
  it.each([
    ['{{constructor}}', 'constructor'],
    ['{{__proto__}}', 'prototype pollution key'],
    ['{{prototype}}', 'prototype'],
    ['{{process}}', 'globals'],
    ['{{1+1}}', 'arithmetic'],
    ['{{order.customer.email}}', 'a property path'],
    ['${orderNumber}', 'a JS template literal'],
    ['<%= orderNumber %>', 'an EJS tag'],
  ])('does not evaluate %s (%s)', (template) => {
    const rendered = renderTemplate(template, context, { strict: false });

    expect(rendered).not.toContain('function');
    expect(rendered).not.toContain('[object');
    expect(rendered).not.toBe('2');
    expect(rendered).not.toContain(context.orderNumber);
  });

  it('cannot reach an inherited property even when one exists', () => {
    const polluted = Object.create({ inherited: 'LEAKED' }) as Record<string, string>;
    polluted.orderNumber = 'CW/1';

    expect(renderTemplate('{{inherited}}', polluted, { strict: false })).toBe('');
  });

  it('does not re-scan what it just substituted', () => {
    // A token whose VALUE looks like a token must not be expanded a second time.
    const rendered = renderTemplate('{{customerName}}', { customerName: '{{orderNumber}}' });
    expect(rendered).toBe('{{orderNumber}}');
  });

  it('lists the tokens a template uses', () => {
    expect(tokensIn('{{a}} then {{b}} then {{a}}')).toEqual(['a', 'b']);
  });
});

/* -------------------------------------------------------------- masking */

describe('recipient masking', () => {
  it.each([
    ['ravi.kumar@example.com', 'ra***@example.com'],
    ['a@b.in', 'a***@b.in'],
  ])('masks the local part of %s', (input, expected) => {
    expect(maskRecipient(input)).toBe(expected);
  });

  it('keeps only the last four digits of a phone number', () => {
    const masked = maskRecipient('+919876543210');

    expect(masked).toContain('3210');
    expect(masked).not.toContain('9876');
    expect(masked).toMatch(/\*/);
  });

  it('is irreversible - the masked form is shorter in information than the original', () => {
    const original = 'ravi.kumar@example.com';
    const masked = maskRecipient(original);

    expect(masked).not.toBe(original);
    expect(masked).not.toContain('kumar');
  });
});

/* ------------------------------------------------------------- templates */

describe('seeded templates', () => {
  it('has an active EMAIL template for each of the eight lifecycle events', async () => {
    const templates = await prisma.notificationTemplate.findMany({ where: { channel: 'EMAIL' } });

    // G1: an empty table would make every containment check below vacuously true.
    expect(templates.length).toBeGreaterThanOrEqual(TEMPLATED_NOTIFICATION_EVENTS.length);

    for (const event of TEMPLATED_NOTIFICATION_EVENTS) {
      const template = templates.find((entry) => entry.event === event);

      expect(template, `no template for ${event}`).toBeDefined();
      expect(template!.isActive).toBe(true);
      expect(template!.body.length).toBeGreaterThan(50);
      expect(template!.subject).toBeTruthy();
    }
  });

  it('has NO template for any return event while customer returns are frozen', async () => {
    const templates = await prisma.notificationTemplate.findMany();
    const returnTemplates = templates.filter((entry) => entry.event.startsWith('RETURN_'));

    expect(templates.length).toBeGreaterThan(0);
    expect(returnTemplates).toEqual([]);
  });

  /**
   * The test that makes "unknown token fails loudly" worth having: every seeded template is
   * rendered against the real context a real order produces. A typo anywhere fails here.
   */
  it('renders every seeded template against a real order without an unknown token', async () => {
    const order = await placeAndPayOrder({ qty: 1, slug: SLUG });
    const resolved = await orderContext(order.orderId);

    expect(resolved).not.toBeNull();
    expect(Object.keys(resolved!.context).length).toBeGreaterThan(5);

    const supplied = {
      ...resolved!.context,
      trackingNumber: 'TEST123',
      courierName: 'Test Courier',
      documentNumber: 'INV/2026-27/000999',
    };

    const templates = await prisma.notificationTemplate.findMany({ where: { channel: 'EMAIL' } });
    expect(templates.length).toBeGreaterThan(0);

    for (const template of templates) {
      expect(() =>
        renderTemplate(`${template.subject}\n${template.body}`, supplied, {
          event: template.event,
        }),
      ).not.toThrow();
    }
  });
});

/* ------------------------------------------------- dispatch is best-effort */

describe('a notification failure never fails the business operation', () => {
  it('confirms and pays an order even when the mail driver throws', async () => {
    const send = vi
      .spyOn(mailer, 'send')
      .mockRejectedValue(new Error('SMTP connection refused (forced)'));

    let order: PaidOrderFixture;
    let attempts = 0;
    try {
      // A real, complete checkout: place, pay, capture, confirm.
      order = await placeAndPayOrder({ qty: 2, slug: SLUG });
    } finally {
      // Read the call count BEFORE restoring: mockRestore() clears the call history.
      attempts = send.mock.calls.length;
      send.mockRestore();
    }

    // The mail driver was genuinely exercised and genuinely failed.
    expect(attempts).toBeGreaterThan(0);

    const persisted = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });

    // Nothing rolled back: the money is captured and the order is confirmed.
    expect(persisted.status).toBe('CONFIRMED');
    expect(persisted.paymentStatus).toBe('CAPTURED');
    expect(persisted.paidPaise).toBe(order.paidPaise);
    expect(persisted.paidPaise).toBeGreaterThan(0);

    // And the failure was recorded rather than swallowed.
    const logs = await prisma.notificationLog.findMany({ where: { orderId: order.orderId } });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((log) => log.status === 'FAILED')).toBe(true);
    expect(logs.find((log) => log.status === 'FAILED')!.error).toContain('forced');
  });

  it('records an attempt for both ORDER_PLACED and ORDER_CONFIRMED', async () => {
    const order = await placeAndPayOrder({ qty: 1, slug: SLUG });

    const logs = await prisma.notificationLog.findMany({ where: { orderId: order.orderId } });
    const events = logs.map((log) => log.event);

    expect(logs.length).toBeGreaterThan(0);
    expect(events).toContain('ORDER_PLACED');
    expect(events).toContain('ORDER_CONFIRMED');
  });

  it('never writes a plaintext recipient', async () => {
    const order = await placeAndPayOrder({ qty: 1, slug: SLUG });

    const resolved = await orderContext(order.orderId);
    const plaintext = resolved!.recipient!;

    expect(plaintext).toContain('@');

    const logs = await prisma.notificationLog.findMany({ where: { orderId: order.orderId } });
    const sent = logs.filter((log) => log.status !== 'SKIPPED');

    expect(sent.length).toBeGreaterThan(0);

    for (const log of sent) {
      expect(log.recipient).not.toBe(plaintext);
      expect(log.recipient).toBe(maskRecipient(plaintext));
      expect(log.recipient).toContain('***');
    }
  });

  it('logs SKIPPED rather than silently doing nothing when there is no template', async () => {
    const order = await placeAndPayOrder({ qty: 1, slug: SLUG });
    const before = await prisma.notificationLog.count({ where: { orderId: order.orderId } });

    // RETURN_REQUESTED is deliberately untemplated while returns are frozen.
    const id = await notificationService.dispatch('RETURN_REQUESTED', { orderId: order.orderId });

    expect(id).not.toBeNull();

    const log = await prisma.notificationLog.findUniqueOrThrow({ where: { id: id! } });

    expect(log.status).toBe('SKIPPED');
    expect(log.error).toBe('no active template');
    expect(log.recipient).toBe('');
    expect(await prisma.notificationLog.count({ where: { orderId: order.orderId } })).toBe(
      before + 1,
    );
  });

  it('resolves rather than throws when the order does not exist', async () => {
    await expect(
      notificationService.dispatch('ORDER_CONFIRMED', { orderId: 'does-not-exist' }),
    ).resolves.not.toThrow();
  });
});

/* -------------------------------------------------------- shipment events */

describe('dispatch on shipment progress', () => {
  it('emails once when the order becomes SHIPPED, with the real AWB', async () => {
    const order = await placeAndPayOrder({ qty: 2, slug: SLUG });

    const created = await request(app)
      .post(`${ADMIN_API}/orders/${encodeURIComponent(order.orderNumber)}/shipments`)
      .set('Cookie', superAdmin.header)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({ manual: true, items: [{ orderItemId: order.itemId, qty: order.itemQty }] });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const shipmentNumber = encodeURIComponent(created.body.data.shipmentNumber as string);

    const awb = await request(app)
      .post(`${ADMIN_API}/shipments/${shipmentNumber}/awb`)
      .set('Cookie', superAdmin.header)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({ manualAwb: 'CWMANUAL0001', manualCourierName: 'Local Transport' });

    expect(awb.status, JSON.stringify(awb.body)).toBe(200);

    const moved = await request(app)
      .post(`${ADMIN_API}/shipments/${shipmentNumber}/status`)
      .set('Cookie', superAdmin.header)
      .set('X-CSRF-Token', superAdmin.csrf)
      .send({ status: 'PICKED_UP', isCustomerVisible: true });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const logs = await prisma.notificationLog.findMany({
      where: { orderId: order.orderId, event: 'ORDER_SHIPPED' },
    });

    expect(logs.length).toBe(1);
    expect(logs[0].subject).toContain(order.orderNumber);
  });
});

/* ------------------------------------------------------------ HTTP routes */

describe('admin notification routes', () => {
  it('lists the templates with the tokens each one uses', async () => {
    const response = await get(superAdmin, '/notifications/templates');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.length).toBeGreaterThanOrEqual(8);

    const confirmed = response.body.data.find(
      (entry: { event: string }) => entry.event === 'ORDER_CONFIRMED',
    );

    expect(confirmed).toBeDefined();
    expect(confirmed.tokens).toContain('orderNumber');
    expect(confirmed.tokens.length).toBeGreaterThan(0);
  });

  it('updates the wording and bumps the version', async () => {
    const before = await prisma.notificationTemplate.findUniqueOrThrow({
      where: { event_channel: { event: 'ORDER_DELIVERED', channel: 'EMAIL' } },
    });

    const response = await put(superAdmin, '/notifications/templates', {
      event: 'ORDER_DELIVERED',
      channel: 'EMAIL',
      subject: before.subject,
      body: `${before.body}\n\nEdited by a test.`,
      isActive: true,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.version).toBe(before.version + 1);
    expect(response.body.data.body).toContain('Edited by a test.');

    // Put it back so the seed-idempotency suite is not affected.
    await prisma.notificationTemplate.update({
      where: { id: before.id },
      data: { body: before.body, version: before.version },
    });
  });

  it('rejects an unknown event at the boundary with 422 (R2)', async () => {
    const response = await put(superAdmin, '/notifications/templates', {
      event: 'NOT_A_REAL_EVENT',
      channel: 'EMAIL',
      body: 'x',
      isActive: true,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('pages the log and masks every recipient it returns', async () => {
    await placeAndPayOrder({ qty: 1, slug: SLUG });

    const response = await get(superAdmin, '/notifications/logs?page=1&limit=10');

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.meta.total).toBeGreaterThan(0);

    for (const log of response.body.data as { recipient: string }[]) {
      expect(log.recipient === '' || log.recipient.includes('***')).toBe(true);
    }
  });

  it('filters the log by status', async () => {
    const response = await get(superAdmin, '/notifications/logs?status=SENT&limit=5');

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    for (const log of response.body.data as { status: string }[]) {
      expect(log.status).toBe('SENT');
    }
  });

  it('refuses an anonymous caller', async () => {
    const response = await request(app).get(`${ADMIN_API}/notifications/templates`);
    expect(response.status).toBe(401);
  });
});
