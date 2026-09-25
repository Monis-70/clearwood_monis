import { Router } from 'express';

import { API_PREFIX } from '@shared/constants';
import { ENQUIRY_STATUSES } from '@shared/enums';
import { idParamSchema } from '@shared/schemas/common';
import {
  enquiryCreateSchema,
  enquiryListQuerySchema,
  enquiryUpdateSchema,
} from '@shared/schemas/enquiry';

import { adminEnquiryController, publicEnquiryController } from '../controllers/enquiry.controller';
import {
  commonErrorResponses,
  errorBodySchema,
  jsonContent,
  registry,
  successBodySchema,
  z,
} from '../docs/registry';
import {
  asyncHandler,
  authRateLimit,
  authenticate,
  optionalAuth,
  requirePermission,
  validate,
} from '../middleware';
import { csrfProtection } from '../modules/auth/csrf.service';

/**
 * Enquiries (PROJECT_CONTEXT §47): contract work, custom furniture, interiors, bulk orders.
 * The public endpoint is rate limited per ip + contact; the admin queue is permission-gated.
 */

const ADMIN_PREFIX = `${API_PREFIX}/admin`;

export const enquiryRouter: Router = Router();
export const adminEnquiryRouter: Router = Router();

/* ----------------------------------------------------------- OpenAPI docs */

const receiptSchema = registry.register(
  'EnquiryReceipt',
  z.object({ reference: z.string(), receivedAt: z.string() }),
);

const enquirySummarySchema = z.object({
  id: z.string(),
  formKey: z.string(),
  status: z.enum(ENQUIRY_STATUSES),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  city: z.string().nullable(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  productId: z.string().nullable(),
  assignedToId: z.string().nullable(),
  createdAt: z.string(),
});

const enquirySchema = registry.register(
  'AdminEnquiry',
  enquirySummarySchema.extend({
    pincode: z.string().nullable(),
    companyName: z.string().nullable(),
    message: z.string().nullable(),
    quantity: z.number().int().nullable(),
    budgetPaise: z.number().int().nullable(),
    productName: z.string().nullable(),
    customerId: z.string().nullable(),
    source: z.string(),
    details: z.record(z.union([z.string(), z.number(), z.boolean()])),
    adminNote: z.string().nullable(),
    version: z.number().int(),
    updatedAt: z.string(),
  }),
);

registry.registerPath({
  method: 'post',
  path: `${API_PREFIX}/enquiries`,
  tags: ['Enquiries'],
  summary: 'Send an enquiry (contract work, custom furniture, interiors, bulk orders)',
  description:
    'Accepted only for a form key some live surface offers: an active LEAD_FORM navigation ' +
    "item, a live category's leadFormKey or an active LEAD_FORM_CTA block. Needs an email or a " +
    'phone. Never an order: nothing is priced or reserved.',
  request: { body: jsonContent(enquiryCreateSchema, 'Enquiry') },
  responses: {
    201: jsonContent(successBodySchema(receiptSchema), 'Received'),
    ...commonErrorResponses,
    422: jsonContent(errorBodySchema, 'Invalid input, or a form that is not available'),
    429: jsonContent(errorBodySchema, 'Too many enquiries from this client'),
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/enquiries`,
  tags: ['Admin enquiries'],
  summary: 'The enquiry queue, filterable by status, form, category and assignee',
  request: { query: enquiryListQuerySchema },
  responses: {
    200: jsonContent(successBodySchema(z.array(enquirySummarySchema)), 'Paginated enquiries'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/enquiries/assignees`,
  tags: ['Admin enquiries'],
  summary: 'Who an enquiry can be assigned to',
  description:
    'Requires `lead.enquiry.assign`. Active admins who can read enquiries, id and name only - the ' +
    'same rule PATCH applies to `assignedToId`.',
  responses: {
    200: jsonContent(
      successBodySchema(z.array(z.object({ id: z.string(), name: z.string() }))),
      'Eligible assignees',
    ),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'get',
  path: `${ADMIN_PREFIX}/enquiries/{id}`,
  tags: ['Admin enquiries'],
  summary: 'One enquiry with its details and context',
  request: { params: idParamSchema },
  responses: {
    200: jsonContent(successBodySchema(enquirySchema), 'Enquiry'),
    404: jsonContent(errorBodySchema, 'No such enquiry'),
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: 'patch',
  path: `${ADMIN_PREFIX}/enquiries/{id}`,
  tags: ['Admin enquiries'],
  summary: 'Move an enquiry through its workflow (optimistic locking via `version`)',
  description: 'Changing `assignedToId` also needs lead.enquiry.assign.',
  request: { params: idParamSchema, body: jsonContent(enquiryUpdateSchema, 'Changes') },
  responses: {
    200: jsonContent(successBodySchema(enquirySchema), 'Updated'),
    404: jsonContent(errorBodySchema, 'No such enquiry'),
    409: jsonContent(errorBodySchema, 'STALE_RESOURCE'),
    ...commonErrorResponses,
  },
});

/* ---------------------------------------------------------------- routes */

enquiryRouter.post(
  '/enquiries',
  optionalAuth('CUSTOMER'),
  csrfProtection('CUSTOMER'),
  // Per client, not per typed contact: rotating the email must not reset the allowance.
  authRateLimit('enquiry', { byIdentifier: false }),
  validate({ body: enquiryCreateSchema }),
  asyncHandler(publicEnquiryController.submit),
);

adminEnquiryRouter.get(
  '/enquiries',
  authenticate('ADMIN'),
  requirePermission('lead.enquiry.read'),
  validate({ query: enquiryListQuerySchema }),
  asyncHandler(adminEnquiryController.list),
);

adminEnquiryRouter.get(
  '/enquiries/assignees',
  authenticate('ADMIN'),
  requirePermission('lead.enquiry.assign'),
  asyncHandler(adminEnquiryController.assignees),
);

adminEnquiryRouter.get(
  '/enquiries/:id',
  authenticate('ADMIN'),
  requirePermission('lead.enquiry.read'),
  validate({ params: idParamSchema }),
  asyncHandler(adminEnquiryController.get),
);

adminEnquiryRouter.patch(
  '/enquiries/:id',
  authenticate('ADMIN'),
  csrfProtection('ADMIN'),
  requirePermission('lead.enquiry.update'),
  validate({ params: idParamSchema, body: enquiryUpdateSchema }),
  asyncHandler(adminEnquiryController.update),
);
