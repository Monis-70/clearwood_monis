import type { Request, Response } from 'express';

import type {
  AdminReturnListQuery,
  AdminShipmentListQuery,
  AssignAwbInput,
  NdrActionInput,
  NdrListQuery,
  RefundPreviewInput,
  RefundRequestInput,
  ReturnApproveInput,
  ReturnCreateInput,
  ReturnInspectInput,
  ReturnRejectInput,
  SchedulePickupInput,
  ServiceabilityQuery,
  ShipmentCancelInput,
  ShipmentCreateInput,
  ShipmentStatusInput,
} from '@shared/schemas/fulfilment';
import type { RefundApproveInput, RefundExecuteInput } from '@shared/schemas/fulfilment';

import { auditService } from '../modules/auth/audit.service';
import { ndrService } from '../modules/fulfilment/ndr.service';
import { returnService } from '../modules/fulfilment/return.service';
import { shipmentService } from '../modules/fulfilment/shipment.service';
import { trackingService } from '../modules/fulfilment/tracking.service';
import { orderService } from '../modules/orders/order.service';
import { refundService } from '../modules/payments/refund/refund.service';
import { orderRepository } from '../repositories/order.repository';
import { shipmentRepository } from '../repositories/shipment.repository';
import { AppError } from '../utils/AppError';
import { created, ok, paginated } from '../utils/response';

/** R1 — thin: resolve the caller, call a service, answer through the one envelope. */

interface Actor {
  actorType: 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
  actorId: string | null;
  actorName: string | null;
}

/** Narrower, for services that only ever act on behalf of staff or the system. */
type StaffActor = { actorType: 'ADMIN' | 'SYSTEM'; actorId: string | null; actorName: string | null };

function adminActor(req: Request): StaffActor {
  return {
    actorType: 'ADMIN',
    actorId: req.auth?.principalId ?? null,
    actorName: req.auth?.displayName ?? null,
  };
}

function customerActor(req: Request): Actor {
  if (req.auth?.realm !== 'CUSTOMER') {
    throw new AppError(401, 'NOT_AUTHENTICATED', 'Sign in to continue');
  }

  return {
    actorType: 'CUSTOMER',
    actorId: req.auth.principalId,
    actorName: req.auth.displayName ?? null,
  };
}

/** A customer may only ever see their own order. */
async function ownedOrder(req: Request, orderNumber: string) {
  const customerId = customerActor(req).actorId;
  const order = await orderRepository.findByNumber(orderNumber);

  if (!order || order.customerId !== customerId) {
    // Deliberately 404, not 403: existence is itself information.
    throw AppError.notFound('Order not found');
  }

  return order;
}

/* ------------------------------------------------------------- shipments */

export const adminShipmentController = {
  async list(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as AdminShipmentListQuery;
    const page = await shipmentService.listForAdmin(query);

    paginated(res, page.items.map(shipmentService.toDto), page);
  },

  async detail(req: Request, res: Response): Promise<void> {
    const { shipmentNumber } = req.params as { shipmentNumber: string };
    ok(res, shipmentService.toDto(await shipmentService.getByNumber(shipmentNumber)));
  },

  async forOrder(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    const order = await orderRepository.findByNumber(orderNumber);
    if (!order) throw AppError.notFound('Order not found');

    const shipments = await shipmentService.listForOrder(order.id);
    ok(res, {
      shipments: shipments.map(shipmentService.toDto),
      remaining: await shipmentService.remainingQuantities(order),
    });
  },

  async create(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    const shipment = await shipmentService.create(
      orderNumber,
      req.body as ShipmentCreateInput,
      adminActor(req),
    );

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Shipment',
      entityId: shipment.id,
      meta: { shipmentNumber: shipment.shipmentNumber, orderNumber },
    });

    created(res, shipmentService.toDto(shipment));
  },

  async serviceability(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ServiceabilityQuery;
    const orderNumber = (req.params as { orderNumber?: string }).orderNumber;

    ok(
      res,
      await shipmentService.serviceability(query, orderNumber ? { orderNumber } : {}),
    );
  },

  async assignAwb(req: Request, res: Response): Promise<void> {
    const { shipmentNumber } = req.params as { shipmentNumber: string };
    const shipment = await shipmentService.assignAwb(
      shipmentNumber,
      req.body as AssignAwbInput,
      adminActor(req),
    );

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Shipment',
      entityId: shipment.id,
      meta: { shipmentNumber, awbNumber: shipment.awbNumber },
    });

    ok(res, shipmentService.toDto(shipment));
  },

  async schedulePickup(req: Request, res: Response): Promise<void> {
    const { shipmentNumber } = req.params as { shipmentNumber: string };

    ok(
      res,
      shipmentService.toDto(
        await shipmentService.schedulePickup(
          shipmentNumber,
          req.body as SchedulePickupInput,
          adminActor(req),
        ),
      ),
    );
  },

  async setStatus(req: Request, res: Response): Promise<void> {
    const { shipmentNumber } = req.params as { shipmentNumber: string };
    const body = req.body as ShipmentStatusInput;

    const shipment = await trackingService.setStatus(
      shipmentNumber,
      {
        status: body.status,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.location === undefined ? {} : { location: body.location }),
        ...(body.occurredAt === undefined ? {} : { occurredAt: body.occurredAt }),
        isCustomerVisible: body.isCustomerVisible,
      },
      adminActor(req),
    );

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Shipment',
      entityId: shipment.id,
      meta: { shipmentNumber, status: body.status },
    });

    ok(res, shipmentService.toDto(shipment));
  },

  async sync(req: Request, res: Response): Promise<void> {
    const { shipmentNumber } = req.params as { shipmentNumber: string };
    ok(res, shipmentService.toDto(await trackingService.sync(shipmentNumber)));
  },

  async cancel(req: Request, res: Response): Promise<void> {
    const { shipmentNumber } = req.params as { shipmentNumber: string };
    const shipment = await shipmentService.cancel(
      shipmentNumber,
      req.body as ShipmentCancelInput,
      adminActor(req),
    );

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Shipment',
      entityId: shipment.id,
      severity: 'WARNING',
      meta: { shipmentNumber, status: shipment.status },
    });

    ok(res, shipmentService.toDto(shipment));
  },
};

/* ------------------------------------------------------------------- NDR */

export const adminNdrController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await ndrService.list(req.query as unknown as NdrListQuery);
    paginated(res, page.items, page);
  },

  async act(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const record = await ndrService.act(id, req.body as NdrActionInput, adminActor(req));

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'NdrRecord',
      entityId: id,
      meta: { action: (req.body as NdrActionInput).action },
    });

    ok(res, record);
  },
};

/* --------------------------------------------------------------- returns */

export const adminReturnController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await returnService.listForAdmin(req.query as unknown as AdminReturnListQuery);
    paginated(res, page.items.map(returnService.toDto), page);
  },

  async detail(req: Request, res: Response): Promise<void> {
    const { returnNumber } = req.params as { returnNumber: string };
    ok(res, returnService.toDto(await returnService.getByNumber(returnNumber)));
  },

  async approve(req: Request, res: Response): Promise<void> {
    const { returnNumber } = req.params as { returnNumber: string };
    const request = await returnService.approve(
      returnNumber,
      req.body as ReturnApproveInput,
      adminActor(req),
    );

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'ReturnRequest',
      entityId: request.id,
      meta: { returnNumber, approvedAmountPaise: request.approvedAmountPaise },
    });

    ok(res, returnService.toDto(request));
  },

  async reject(req: Request, res: Response): Promise<void> {
    const { returnNumber } = req.params as { returnNumber: string };

    ok(
      res,
      returnService.toDto(
        await returnService.reject(returnNumber, req.body as ReturnRejectInput, adminActor(req)),
      ),
    );
  },

  async receive(req: Request, res: Response): Promise<void> {
    const { returnNumber } = req.params as { returnNumber: string };
    ok(res, returnService.toDto(await returnService.markReceived(returnNumber, adminActor(req))));
  },

  async inspect(req: Request, res: Response): Promise<void> {
    const { returnNumber } = req.params as { returnNumber: string };
    const request = await returnService.inspect(
      returnNumber,
      req.body as ReturnInspectInput,
      adminActor(req),
    );

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'ReturnRequest',
      entityId: request.id,
      meta: { returnNumber, status: request.status },
    });

    ok(res, returnService.toDto(request));
  },

  async complete(req: Request, res: Response): Promise<void> {
    const { returnNumber } = req.params as { returnNumber: string };
    const request = await returnService.complete(returnNumber, adminActor(req));

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'ReturnRequest',
      entityId: request.id,
      severity: 'WARNING',
      meta: { returnNumber, refundId: request.refundId },
    });

    ok(res, returnService.toDto(request));
  },
};

/* --------------------------------------------------------------- refunds */

export const adminRefundController = {
  /**
   * A live preview, with no side effects.
   *
   * An admin about to return somebody's money should see the line maths AND which linked account
   * each rupee comes out of before they commit.
   */
  async preview(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    ok(res, await refundService.preview(orderNumber, req.body as RefundPreviewInput));
  },

  async request(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    const refund = await refundService.request(
      orderNumber,
      req.body as RefundRequestInput,
      adminActor(req),
    );

    await auditService.recordFromRequest(req, {
      action: 'CREATE',
      entity: 'Refund',
      entityId: refund.id,
      severity: 'CRITICAL',
      meta: { refundNumber: refund.refundNumber, amountPaise: refund.amountPaise },
    });

    created(res, refund);
  },

  async approve(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const refund = await refundService.approve(id, adminActor(req));

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Refund',
      entityId: id,
      severity: 'CRITICAL',
      meta: { note: (req.body as RefundApproveInput).note ?? null },
    });

    ok(res, refund);
  },

  async execute(req: Request, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const body = req.body as RefundExecuteInput;

    const refund = await refundService.execute(
      id,
      {
        speed: body.speed,
        ...(body.reverseTransfers === undefined
          ? {}
          : { reverseTransfers: body.reverseTransfers }),
      },
      adminActor(req),
    );

    await auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Refund',
      entityId: id,
      severity: 'CRITICAL',
      meta: { status: refund?.status ?? null, providerRefundId: refund?.providerRefundId ?? null },
    });

    ok(res, refund);
  },
};

/* ------------------------------------------------ customer-facing surface */

export const customerFulfilmentController = {
  /** The shipment timeline for one of my orders. */
  async shipments(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    const order = await ownedOrder(req, orderNumber);

    const shipments = await shipmentService.listForOrder(order.id);
    ok(res, shipments.map((shipment) => shipmentService.toCustomerDto(shipment)));
  },

  async returns(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    const order = await ownedOrder(req, orderNumber);

    ok(res, (await returnService.listForOrder(order.id)).map(returnService.toDto));
  },

  /** What is still eligible to come back, so the UI never offers an impossible return. */
  async returnable(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    const order = await ownedOrder(req, orderNumber);

    ok(res, {
      withinWindow: returnService.isWithinWindow(order),
      items: await returnService.returnableQuantities(order),
    });
  },

  async requestReturn(req: Request, res: Response): Promise<void> {
    const { orderNumber } = req.params as { orderNumber: string };
    await ownedOrder(req, orderNumber);

    const request = await returnService.create(
      orderNumber,
      req.body as Omit<ReturnCreateInput, 'orderNumber'>,
      customerActor(req),
    );

    created(res, returnService.toDto(request));
  },

  /**
   * Public tracking by AWB, for the link in a delivery email.
   *
   * Returns the timeline and nothing else — no addresses, no totals, no customer identity.
   */
  async trackByAwb(req: Request, res: Response): Promise<void> {
    const { awb } = req.params as { awb: string };
    const shipment = await shipmentRepository.findByAwb(awb);

    if (!shipment) throw AppError.notFound('No shipment with that tracking number');

    ok(res, shipmentService.toPublicTrackingDto(shipment));
  },
};

export const fulfilmentOrderController = { orderService };
