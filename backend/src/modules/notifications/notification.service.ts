import type { NotificationChannel, NotificationEvent } from '@shared/enums';

import { mailer } from '../../container';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { customerRepository } from '../../repositories/customer.repository';
import { notificationRepository } from '../../repositories/document.repository';
import { orderRepository } from '../../repositories/order.repository';
import { AppError } from '../../utils/AppError';

import { maskRecipient } from './maskRecipient';
import { renderTemplate, type TemplateContext } from './templateRenderer';

/**
 * Best-effort dispatch.
 *
 * A notification is a side effect of a business event, never a participant in it. If the mail
 * server is down, the order was still placed and paid for; failing the request would leave the
 * customer charged and staring at an error, and rolling back would be worse. So NOTHING in this
 * file is allowed to throw into a caller, and no call here may run inside a database transaction
 * that owns business state.
 *
 * Every attempt leaves a NotificationLog row — SENT, FAILED or SKIPPED — so "we never told the
 * customer" is answerable after the fact. Silence is the one outcome that is not permitted.
 */

export interface DispatchTarget {
  orderId?: string;
  shipmentId?: string;
  returnRequestId?: string;
}

const DEFAULT_CHANNEL: NotificationChannel = 'EMAIL';

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

/**
 * The complete token vocabulary available to an order template. Flat and string-only by design:
 * see templateRenderer for why there are no property paths.
 */
export async function orderContext(orderId: string): Promise<{
  context: TemplateContext;
  recipient: string | null;
} | null> {
  const order = await orderRepository.findById(orderId);
  if (!order) return null;

  const shipping = order.addresses.find((address) => address.type === 'SHIPPING');

  let email = order.guestEmail;
  let name = order.guestName;

  if (order.customerId) {
    const customer = await customerRepository.findById(order.customerId);
    email = customer?.email ?? email;
    name = customer?.name ?? name;
  }

  return {
    recipient: email,
    context: {
      customerName: name ?? shipping?.fullName ?? 'there',
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      orderTotal: rupees(order.grandTotalPaise),
      paidAmount: rupees(order.paidPaise),
      itemCount: String(order.items.length),
      placedAt: order.placedAt?.toISOString().slice(0, 10) ?? '',
      shippingCity: shipping?.city ?? '',
      shippingPincode: shipping?.pincode ?? '',
      supportEmail: env.MAIL_FROM,
    },
  };
}

export const notificationService = {
  /**
   * Send one notification. Resolves to the log row id, or null when nothing was sent.
   *
   * NEVER throws. That is the entire contract of this function and it is asserted by a test that
   * forces the mail driver to fail during a real order confirmation.
   */
  async dispatch(
    event: NotificationEvent,
    target: DispatchTarget,
    extraContext: TemplateContext = {},
    channel: NotificationChannel = DEFAULT_CHANNEL,
  ): Promise<string | null> {
    try {
      if (env.NOTIFICATIONS_ENABLED !== 'true') {
        return await this.skip(event, channel, target, 'notifications disabled');
      }

      const template = await notificationRepository.findTemplate(event, channel);
      if (!template || !template.isActive) {
        return await this.skip(event, channel, target, 'no active template');
      }

      const resolved = target.orderId ? await orderContext(target.orderId) : null;
      const recipient = resolved?.recipient;

      if (!recipient) {
        return await this.skip(event, channel, target, 'no recipient on record');
      }

      const context = { ...(resolved?.context ?? {}), ...extraContext };
      const subject = template.subject
        ? renderTemplate(template.subject, context, { event })
        : `ClearWood — ${event}`;
      const body = renderTemplate(template.body, context, { event });

      // Logged BEFORE the send: a process that dies mid-send must still leave the attempt behind.
      const log = await notificationRepository.log({
        event,
        channel,
        recipient: maskRecipient(recipient),
        subject,
        status: 'QUEUED',
        ...target,
      });

      try {
        await mailer.send({ to: recipient, subject, text: body });
        await notificationRepository.markSent(log.id);
      } catch (error) {
        await notificationRepository.markFailed(log.id, (error as Error).message);
        logger.warn(
          { event, notificationId: log.id, err: error },
          'notification failed; the business operation is unaffected',
        );
      }

      return log.id;
    } catch (error) {
      /**
       * The catch-all. A bug in this module must not become a bug in checkout.
       *
       * One exception: a template referencing a token nobody supplies is a DEFECT, not an
       * outage, and outside production it must stop the test run rather than be absorbed into a
       * log line nobody reads. In production the renderer has already degraded it to an empty
       * string and this branch is unreachable.
       */
      if (error instanceof AppError && error.code === 'NOTIFICATION_UNKNOWN_TOKEN') throw error;

      logger.error({ event, target, err: error }, 'notification dispatch failed entirely');
      return null;
    }
  },

  async skip(
    event: NotificationEvent,
    channel: NotificationChannel,
    target: DispatchTarget,
    reason: string,
  ): Promise<string | null> {
    try {
      const log = await notificationRepository.log({
        event,
        channel,
        recipient: '',
        status: 'SKIPPED',
        error: reason,
        ...target,
      });
      return log.id;
    } catch {
      return null;
    }
  },
};
