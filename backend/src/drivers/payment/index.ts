import type { Env } from '../../config/env';
import { logger } from '../../config/logger';

import { MockPaymentDriver } from './mock.payment.driver';
import type { PaymentDriver } from './payment.driver';
import { RazorpayPaymentDriver } from './razorpay.payment.driver';

export type {
  PaymentDriver,
  PaymentDriverCapabilities,
  ProviderOrder,
  ProviderPayment,
  ProviderRefund,
  ProviderReversal,
  ProviderSettlement,
  ProviderTransfer,
  ProviderTransferRequest,
  ParsedWebhook,
  CreateOrderInput,
  CreateRefundInput,
} from './payment.driver';
export { redactProviderPayload, redactedJson, REDACTED } from './payment.driver';
export { ProviderCallError, classifyProviderError } from './payment.driver';
export {
  MockPaymentDriver,
  MOCK_KEY_ID,
  MOCK_KEY_SECRET,
  MOCK_WEBHOOK_SECRET,
} from './mock.payment.driver';
export { RazorpayPaymentDriver, fetchHttpClient } from './razorpay.payment.driver';
export type { PaymentHttpClient } from './razorpay.payment.driver';

export function createPayment(env: Env): PaymentDriver {
  switch (env.PAYMENT_DRIVER) {
    case 'razorpay':
      logger.debug(
        { driver: 'razorpay', base: env.RAZORPAY_API_BASE, split: env.SPLIT_ENABLED },
        'payment driver ready',
      );
      return new RazorpayPaymentDriver();
    case 'mock':
    default:
      logger.debug({ driver: 'mock' }, 'payment driver ready — no money will move');
      return new MockPaymentDriver();
  }
}
