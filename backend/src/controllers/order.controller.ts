import type { Request, Response } from 'express';

import type { IdParam } from '@shared/schemas/common';
import type {
  AdminOrderListQuery,
  AdminOrderStatusInput,
  CheckoutInitInput,
  CheckoutPatchInput,
  MyOrderListQuery,
  OrderCancelInput,
  OrderNumberParam,
  OrderTrackInput,
  PaymentSettingsInput,
  PlaceOrderInput,
  ReconcileInput,
  SplitAccountCreateInput,
  SplitAccountUpdateInput,
  SplitRuleCreateInput,
  SplitRuleListQuery,
  SplitRuleUpdateInput,
  SplitSimulateInput,
  VerifyPaymentInput,
  WebhookListQuery,
} from '@shared/schemas/order';
import type { OrderStatus } from '@shared/enums';

import { auditService } from '../modules/auth/audit.service';
import { cartIdentity } from '../modules/cart/cartIdentity';
import { cartService } from '../modules/cart/cart.service';
import { checkoutService, type CheckoutOwner } from '../modules/orders/checkout.service';
import { ledgerIntegrityService } from '../modules/orders/ledgerIntegrity.service';
import { orderService } from '../modules/orders/order.service';
import { orderStateMachine } from '../modules/orders/orderStateMachine';
import { reconciliationService } from '../modules/orders/reconciliation.service';
import { webhookService } from '../modules/orders/webhook.service';
import { paymentAdminService } from '../modules/payments/paymentAdmin.service';
import { splitService } from '../modules/payments/split/split.service';
import { orderRepository } from '../repositories/order.repository';
import { webhookEventRepository } from '../repositories/payment.repository';
import { AppError } from '../utils/AppError';
import { created, ok, paginated } from '../utils/response';

/** R1 — thin: resolve the caller, call a service, answer through the one envelope. */

function customerIdOf(req: Request): string | null {
  return req.auth?.realm === 'CUSTOMER' ? req.auth.principalId : null;
}

function requireCustomer(req: Request): string {
  const customerId = customerIdOf(req);
  if (!customerId) throw new AppError(401, 'NOT_AUTHENTICATED', 'Sign in to continue');
  return customerId;
}

/** A guest checks out with the same signed cart cookie they have been shopping with. */
function ownerOf(req: Request, res?: Response): CheckoutOwner {
  const owner = cartIdentity.resolve(req);
  if (res && !owner.customerId) cartIdentity.persist(res, owner);
  return { customerId: owner.customerId, sessionId: owner.sessionId };
}

function metaOf(req: Request) {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    referrer: req.get('referer') ?? null,
  };
}

export const checkoutController = {
  async init(req: Request, res: Response): Promise<void> {
    const owner = ownerOf(req, res);
    const cart = await cartService.getOrCreate(cartIdentity.resolve(req));

    created(res, await checkoutService.init(cart, req.body as CheckoutInitInput, owner));
  },

  async get(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params as { sessionId: string };
    ok(res, await checkoutService.get(sessionId, ownerOf(req)));
  },

  async patch(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params as { sessionId: string };
    ok(res, await checkoutService.patch(sessionId, req.body as CheckoutPatchInput, ownerOf(req)));
  },

  /** L1 — the body carries a provider and nothing that could influence the amount. */
  async place(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params as { sessionId: string };
    const owner = ownerOf(req, res);

    created(
      res,
      await checkoutService.place(sessionId, req.body as PlaceOrderInput, owner, metaOf(req)),
    );
  },

  async verify(req: Request, res: Response): Promise<void> {
    ok(res, await checkoutService.verifyPayment(req.body as VerifyPaymentInput));
  },

  async abandon(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params as { sessionId: string };
    ok(res, await checkoutService.abandon(sessionId, ownerOf(req)));
  },
};

export const orderController = {
  async list(req: Request, res: Response): Promise<void> {
    const customerId = requireCustomer(req);
    const page = await orderService.listForCustomer(
      customerId,
      req.query as unknown as MyOrderListQuery,
    );

    paginated(res, page.items, page);
  },

  async get(req: Request, res: Response): Promise<void> {
    const customerId = requireCustomer(req);
    const { orderNumber } = req.params as unknown as OrderNumberParam;

    ok(res, await orderService.getForCustomer(customerId, orderNumber));
  },

  async timeline(req: Request, res: Response): Promise<void> {
    const customerId = requireCustomer(req);
    const { orderNumber } = req.params as unknown as OrderNumberParam;

    ok(res, await orderService.timelineForCustomer(customerId, orderNumber));
  },

  /** Public and hard rate-limited: order number plus a matching contact, nothing sensitive back. */
  async track(req: Request, res: Response): Promise<void> {
    ok(res, await orderService.track(req.body as OrderTrackInput));
  },

  async cancel(req: Request, res: Response): Promise<void> {
    const customerId = requireCustomer(req);
    const { orderNumber } = req.params as unknown as OrderNumberParam;

    ok(
      res,
      await orderService.cancelForCustomer(customerId, orderNumber, req.body as OrderCancelInput),
    );
  },
};

export const webhookController = {
  /**
   * The raw body matters: the signature is computed over the exact bytes the provider sent, so
   * this route is mounted with `express.raw` and never sees the JSON parser.
   */
  async razorpay(req: Request, res: Response): Promise<void> {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const signature = req.get('x-razorpay-signature') ?? undefined;

    const result = await webhookService.receive('RAZORPAY', rawBody, signature);

    // Always 200 once the signature checks out: a processing failure is ours to retry, not the
    // provider's to hammer.
    ok(res, result);
  },
};

export const adminOrderController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await orderService.listForAdmin(req.query as unknown as AdminOrderListQuery);
    paginated(res, page.items, page);
  },

  async detail(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await orderService.detailForAdmin(id));
  },

  async setStatus(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const body = req.body as AdminOrderStatusInput;

    const order = await orderRepository.findById(id);
    if (!order) throw AppError.notFound('Order not found', { id });

    const updated = await orderStateMachine.transition(order, body.status as OrderStatus, {
      note: body.note ?? null,
      actorType: 'ADMIN',
      actorId: req.auth?.principalId ?? null,
      actorName: req.auth?.email ?? null,
      isCustomerVisible: body.isCustomerVisible,
    });

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Order',
      entityId: id,
      meta: { from: order.status, to: body.status },
    });

    ok(res, orderService.toDto(updated));
  },

  async cancel(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const order = await orderRepository.findById(id);
    if (!order) throw AppError.notFound('Order not found', { id });

    const result = await orderService.cancelForCustomer(
      null,
      order.orderNumber,
      req.body as OrderCancelInput,
    );

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Order',
      entityId: id,
      severity: 'WARNING',
      meta: { action: 'CANCEL' },
    });

    ok(res, result);
  },

  async splitPreview(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const order = await orderRepository.findById(id);
    if (!order) throw AppError.notFound('Order not found', { id });

    ok(res, await splitService.preview(order));
  },

  async retryTransfers(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const result = await splitService.retryTransfers(id);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'PaymentTransfer',
      entityId: id,
      meta: result,
    });

    ok(res, result);
  },

  async ledgerCheck(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    ok(res, await ledgerIntegrityService.verifyOrder(id));
  },

  async reconcile(req: Request, res: Response): Promise<void> {
    const report = await reconciliationService.run(req.body as ReconcileInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Order',
      entityId: null,
      meta: { ...report },
    });

    ok(res, report);
  },
};

export const adminPaymentController = {
  async listRules(req: Request, res: Response): Promise<void> {
    const page = await paymentAdminService.listRules(req.query as unknown as SplitRuleListQuery);
    paginated(res, page.items, page);
  },

  async createRule(req: Request, res: Response): Promise<void> {
    const rule = await paymentAdminService.createRule(req.body as SplitRuleCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'SplitRule',
      entityId: rule.id,
      severity: 'WARNING',
      meta: { code: rule.code, mode: rule.mode, recipientKey: rule.recipientKey },
    });

    created(res, rule);
  },

  async updateRule(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const before = req.body as SplitRuleUpdateInput;
    const rule = await paymentAdminService.updateRule(id, before);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'SplitRule',
      entityId: id,
      severity: 'WARNING',
      meta: { code: rule.code },
    });

    ok(res, rule);
  },

  async deleteRule(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    await paymentAdminService.removeRule(id);

    await auditService.recordFromRequest(req, {
      action: 'DELETE',
      entity: 'SplitRule',
      entityId: id,
      severity: 'WARNING',
    });

    ok(res, { deleted: true });
  },

  async listAccounts(_req: Request, res: Response): Promise<void> {
    ok(res, await paymentAdminService.listAccounts());
  },

  async createAccount(req: Request, res: Response): Promise<void> {
    const account = await paymentAdminService.createAccount(req.body as SplitAccountCreateInput);

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'SplitAccount',
      entityId: account.id,
      severity: 'CRITICAL',
      meta: { key: account.key },
    });

    created(res, account);
  },

  async updateAccount(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const account = await paymentAdminService.updateAccount(
      id,
      req.body as SplitAccountUpdateInput,
    );

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'SplitAccount',
      entityId: id,
      severity: 'CRITICAL',
      meta: { key: account.key },
    });

    ok(res, account);
  },

  async simulate(req: Request, res: Response): Promise<void> {
    const body = req.body as SplitSimulateInput;
    const sample = body.sampleOrderId ? await orderRepository.findById(body.sampleOrderId) : null;

    ok(res, await splitService.simulate(body.amountPaise, sample ?? undefined));
  },

  async readSettings(_req: Request, res: Response): Promise<void> {
    ok(res, await paymentAdminService.readSettings());
  },

  /**
   * H6 - everything no automated path can resolve.
   *
   * A refund held for verification is money whose fate we genuinely do not know, so it has to be
   * somewhere a person looks rather than somewhere a sweep silently retries.
   */
  async attention(_req: Request, res: Response): Promise<void> {
    ok(res, await paymentAdminService.needsAttention());
  },

  async updateSettings(req: Request, res: Response): Promise<void> {
    const settings = await paymentAdminService.updateSettings(req.body as PaymentSettingsInput);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'AppSetting',
      entityId: 'payment',
      severity: 'CRITICAL',
      meta: { ...settings },
    });

    ok(res, settings);
  },

  async listWebhooks(req: Request, res: Response): Promise<void> {
    const page = await webhookEventRepository.list(req.query as unknown as WebhookListQuery);
    paginated(res, page.items, page);
  },

  async replayWebhook(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const result = await webhookService.replay(id);

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'WebhookEvent',
      entityId: id,
      meta: { ...result },
    });

    ok(res, result);
  },
};
