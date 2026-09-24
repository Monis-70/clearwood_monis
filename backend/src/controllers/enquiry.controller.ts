import type { Request, Response } from 'express';

import type { IdParam } from '@shared/schemas/common';
import type {
  EnquiryCreateInput,
  EnquiryListQuery,
  EnquiryUpdateInput,
} from '@shared/schemas/enquiry';

import { auditService } from '../modules/auth/audit.service';
import { enquiryService } from '../modules/leads/enquiry.service';
import { ok, paginated } from '../utils/response';

export const publicEnquiryController = {
  async submit(req: Request, res: Response): Promise<void> {
    const receipt = await enquiryService.submit(req.body as EnquiryCreateInput, {
      customerId: req.auth?.realm === 'CUSTOMER' ? req.auth.principalId : null,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    ok(res, receipt, null, 201);
  },
};

export const adminEnquiryController = {
  async list(req: Request, res: Response): Promise<void> {
    const page = await enquiryService.list(req.query as unknown as EnquiryListQuery);
    paginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  },

  async get(req: Request, res: Response): Promise<void> {
    ok(res, await enquiryService.get((req.params as unknown as IdParam).id));
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as IdParam;
    const input = req.body as EnquiryUpdateInput;
    const before = await enquiryService.get(id);
    const updated = await enquiryService.update(
      id,
      input,
      req.auth?.permissions.includes('lead.enquiry.assign') ?? false,
    );

    // Workflow fields only: the customer's personal details never enter the audit trail.
    void auditService.recordFromRequest(req, {
      action: 'UPDATE',
      entity: 'Enquiry',
      entityId: id,
      changes: auditService.diff(
        { status: before.status, assignedToId: before.assignedToId, adminNote: before.adminNote },
        {
          status: updated.status,
          assignedToId: updated.assignedToId,
          adminNote: updated.adminNote,
        },
      ),
    });

    ok(res, updated);
  },
};
