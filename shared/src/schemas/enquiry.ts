import { z } from 'zod';

import { ENQUIRY_STATUSES } from '../enums';

import { leadFormKeySchema, versionSchema } from './catalogAdmin';
import { idSchema, listQuerySchema, slugSchema } from './common';

/**
 * Enquiries: what a customer asks for when the catalog does not sell it off the shelf - contract
 * work, custom furniture, interiors, bulk orders. Never an order: nothing is priced or reserved.
 */

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 -]{7,18}$/, 'Enter a valid phone number');

const detailValue = z.union([z.string().trim().max(1_000), z.number().finite(), z.boolean()]);

export const enquiryCreateSchema = z
  .object({
    /** The form it came from: a LEAD_FORM navigation item, a category's form or a CTA block. */
    formKey: leadFormKeySchema,
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(191).optional(),
    phone: phoneSchema.optional(),
    pincode: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit pincode')
      .optional(),
    city: z.string().trim().min(1).max(120).optional(),
    companyName: z.string().trim().min(1).max(191).optional(),
    message: z.string().trim().max(5_000).optional(),
    quantity: z.number().int().min(1).max(1_000_000).optional(),
    /** Integer paise (D5); the form converts rupees at the edge. */
    budgetPaise: z.number().int().min(0).max(2_000_000_000).optional(),
    categorySlug: slugSchema.optional(),
    productSlug: slugSchema.optional(),
    /** Extra answers a form asks for ("roomCount": 3); stored as JSON, at most 30 of them. */
    details: z
      .record(z.string().trim().min(1).max(64), detailValue)
      .refine((value) => Object.keys(value).length <= 30, 'At most 30 details')
      .optional(),
    /** Honeypot. People never see it; a filled one marks the enquiry as spam. */
    website: z.string().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.email && !value.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phone'],
        message: 'Give an email address or a phone number so we can reply',
      });
    }
  });

export const enquiryListQuerySchema = listQuerySchema.extend({
  status: z.enum(ENQUIRY_STATUSES).optional(),
  formKey: leadFormKeySchema.optional(),
  categoryId: idSchema.optional(),
  assignedToId: idSchema.optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export const enquiryUpdateSchema = z
  .object({
    status: z.enum(ENQUIRY_STATUSES).optional(),
    assignedToId: idSchema.nullable().optional(),
    adminNote: z.string().trim().max(5_000).nullable().optional(),
    version: versionSchema,
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.assignedToId !== undefined ||
      value.adminNote !== undefined,
    { message: 'Change at least one of status, assignedToId or adminNote' },
  );

export type EnquiryCreateInput = z.infer<typeof enquiryCreateSchema>;
export type EnquiryListQuery = z.infer<typeof enquiryListQuerySchema>;
export type EnquiryUpdateInput = z.infer<typeof enquiryUpdateSchema>;
