import type { TEMPLATED_NOTIFICATION_EVENTS } from '@shared/enums';

import { log, prisma } from './context';

/**
 * The eight order-lifecycle emails.
 *
 * Only tokens listed in `orderContext` (notification.service.ts) may appear here. An unknown
 * `{{token}}` throws outside production, so a typo in this file fails the test run rather than
 * reaching a customer.
 *
 * Deliberately plain text. A furniture order confirmation is read on a phone, often on a bad
 * connection, and a text email renders identically everywhere and never lands in spam for having
 * a tracking pixel. HTML templates can come later if marketing ever asks.
 *
 * NO return-specific templates: customer returns are frozen (PROJECT_CONTEXT section 22) and a
 * template for an event nobody raises is a lie in the database.
 */

interface Template {
  event: (typeof TEMPLATED_NOTIFICATION_EVENTS)[number];
  subject: string;
  body: string;
}

const SIGN_OFF = ['', 'ClearWood Furnitures', 'Questions? Reply to {{supportEmail}}.'];

function compose(...lines: string[]): string {
  return [...lines, ...SIGN_OFF].join('\n');
}

const TEMPLATES: Template[] = [
  {
    event: 'ORDER_PLACED',
    subject: 'We have your order {{orderNumber}}',
    body: compose(
      'Hello {{customerName}},',
      '',
      'Thank you for your order {{orderNumber}}, placed on {{placedAt}}.',
      '',
      'Items: {{itemCount}}',
      'Total: {{orderTotal}}',
      '',
      'We will confirm it as soon as the payment is settled.',
    ),
  },
  {
    event: 'ORDER_CONFIRMED',
    subject: 'Order {{orderNumber}} is confirmed',
    body: compose(
      'Hello {{customerName}},',
      '',
      'Your payment of {{paidAmount}} has been received and order {{orderNumber}} is confirmed.',
      '',
      'We are preparing your {{itemCount}} item(s) for dispatch to {{shippingCity}} '
        + '{{shippingPincode}}. You will hear from us again when the courier collects them.',
    ),
  },
  {
    event: 'PAYMENT_FAILED',
    subject: 'Payment for order {{orderNumber}} did not go through',
    body: compose(
      'Hello {{customerName}},',
      '',
      'The payment for order {{orderNumber}} ({{orderTotal}}) was not completed, so we have not '
        + 'charged you and the order is on hold.',
      '',
      'If money did leave your account it will be returned by your bank, usually within five '
        + 'working days. You can place the order again whenever you are ready.',
    ),
  },
  {
    event: 'ORDER_SHIPPED',
    subject: 'Order {{orderNumber}} has been dispatched',
    body: compose(
      'Hello {{customerName}},',
      '',
      'Order {{orderNumber}} has left our warehouse and is on its way to {{shippingCity}} '
        + '{{shippingPincode}}.',
      '',
      'Tracking: {{trackingNumber}} ({{courierName}})',
    ),
  },
  {
    event: 'OUT_FOR_DELIVERY',
    subject: 'Order {{orderNumber}} arrives today',
    body: compose(
      'Hello {{customerName}},',
      '',
      'Your order {{orderNumber}} is out for delivery today.',
      '',
      'Please make sure someone is available at {{shippingCity}} {{shippingPincode}} to receive '
        + 'it, and do check the packaging before signing.',
    ),
  },
  {
    event: 'ORDER_DELIVERED',
    subject: 'Order {{orderNumber}} has been delivered',
    body: compose(
      'Hello {{customerName}},',
      '',
      'Order {{orderNumber}} was delivered. We hope it is everything you expected.',
      '',
      'If anything arrived damaged, tell us within 48 hours and we will put it right.',
    ),
  },
  {
    event: 'ORDER_CANCELLED',
    subject: 'Order {{orderNumber}} has been cancelled',
    body: compose(
      'Hello {{customerName}},',
      '',
      'Order {{orderNumber}} has been cancelled.',
      '',
      'Anything already paid ({{paidAmount}}) is being returned to the original payment method '
        + 'and typically settles within five to seven working days.',
    ),
  },
  {
    event: 'INVOICE_ISSUED',
    subject: 'Your GST invoice for order {{orderNumber}}',
    body: compose(
      'Hello {{customerName}},',
      '',
      'The GST tax invoice for order {{orderNumber}} ({{orderTotal}}) is ready.',
      '',
      'Invoice number: {{documentNumber}}',
      '',
      'You can download it from your account, under Orders.',
    ),
  },
];

export async function seedNotificationTemplates(): Promise<void> {
  for (const template of TEMPLATES) {
    await prisma.notificationTemplate.upsert({
      where: { event_channel: { event: template.event, channel: 'EMAIL' } },
      create: {
        event: template.event,
        channel: 'EMAIL',
        subject: template.subject,
        body: template.body,
        isActive: true,
      },
      // R8 - an admin's edited wording survives a re-seed. Only activation is re-asserted.
      update: {},
    });
  }

  log('notification-templates', `${TEMPLATES.length} EMAIL templates`);
}
