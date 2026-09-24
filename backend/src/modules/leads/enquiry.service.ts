import type { Enquiry } from '@prisma/client';

import type { EnquiryStatus } from '@shared/enums';
import type {
  EnquiryCreateInput,
  EnquiryListQuery,
  EnquiryUpdateInput,
} from '@shared/schemas/enquiry';
import type {
  AdminEnquiryDto,
  AdminEnquirySummaryDto,
  EnquiryReceiptDto,
} from '@shared/types/enquiry';

import { logger } from '../../config/logger';
import { enquiryRepository } from '../../repositories/enquiry.repository';
import type { PageResult } from '../../repositories/helpers';
import { categoryService } from '../../services/category.service';
import { AppError } from '../../utils/AppError';
import { jsonColumn } from '../../utils/jsonColumn';

/**
 * Enquiries: contract work, custom furniture, interiors, bulk orders - what a customer asks for
 * when the catalog does not sell it off the shelf (PROJECT_CONTEXT §47). The foundation Prompt 10B
 * builds its lead forms on: generic over `formKey`, never an order, no mail yet (SMTP is on hold).
 *
 * A form key is accepted only while some live surface offers it - an active LEAD_FORM navigation
 * item, a live category's `leadFormKey`, or an active LEAD_FORM_CTA block - so the endpoint
 * cannot become a free-text inbox for keys nobody published. Personal details are never logged.
 */

type Details = Record<string, string | number | boolean>;
const detailsColumn = jsonColumn<Details>(undefined, 'Enquiry.detailsJson');

export interface EnquiryOrigin {
  customerId: string | null;
  ip: string | null;
  userAgent: string | null;
}

function toSummary(
  row: Enquiry,
  names: { categories: Map<string, string> },
): AdminEnquirySummaryDto {
  return {
    id: row.id,
    formKey: row.formKey,
    status: row.status as EnquiryStatus,
    name: row.name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    categoryId: row.categoryId,
    categoryName: row.categoryId ? (names.categories.get(row.categoryId) ?? null) : null,
    productId: row.productId,
    assignedToId: row.assignedToId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadOrThrow(id: string): Promise<Enquiry> {
  const row = await enquiryRepository.findById(id);
  if (!row) throw AppError.notFound('Enquiry not found', { id });
  return row;
}

export const enquiryService = {
  async submit(input: EnquiryCreateInput, origin: EnquiryOrigin): Promise<EnquiryReceiptDto> {
    const live = await categoryService.liveIds();
    if (!(await enquiryRepository.isOfferedFormKey(input.formKey, live))) {
      throw AppError.validation('This form is not available', { formKey: input.formKey });
    }

    const categoryId = input.categorySlug
      ? await enquiryRepository.findCategoryId(input.categorySlug)
      : null;
    if (input.categorySlug && (!categoryId || !live.has(categoryId))) {
      throw AppError.validation('Unknown category', { categorySlug: input.categorySlug });
    }

    const productId = input.productSlug
      ? await enquiryRepository.findReachableProductId(input.productSlug)
      : null;
    if (input.productSlug && !productId) {
      throw AppError.validation('Unknown product', { productSlug: input.productSlug });
    }

    const created = await enquiryRepository.create({
      formKey: input.formKey,
      // A filled honeypot is kept for review but never lands in the working queue.
      status: input.website ? 'SPAM' : 'NEW',
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      pincode: input.pincode ?? null,
      city: input.city ?? null,
      companyName: input.companyName ?? null,
      message: input.message ?? null,
      quantity: input.quantity ?? null,
      budgetPaise: input.budgetPaise ?? null,
      categoryId,
      productId,
      customerId: origin.customerId,
      source: 'WEB',
      detailsJson: input.details ? detailsColumn.serialize(input.details) : null,
      ip: origin.ip?.slice(0, 45) ?? null,
      userAgent: origin.userAgent?.slice(0, 512) ?? null,
    });

    logger.info({ enquiryId: created.id, formKey: created.formKey }, 'enquiry received');
    return { reference: created.id, receivedAt: created.createdAt.toISOString() };
  },

  async list(query: EnquiryListQuery): Promise<PageResult<AdminEnquirySummaryDto>> {
    const page = await enquiryRepository.list(query);
    const names = await enquiryRepository.contextNames(
      [...new Set(page.items.flatMap((row) => (row.categoryId ? [row.categoryId] : [])))],
      [],
    );
    return { ...page, items: page.items.map((row) => toSummary(row, names)) };
  },

  async get(id: string): Promise<AdminEnquiryDto> {
    const row = await loadOrThrow(id);
    const names = await enquiryRepository.contextNames(
      row.categoryId ? [row.categoryId] : [],
      row.productId ? [row.productId] : [],
    );

    return {
      ...toSummary(row, names),
      pincode: row.pincode,
      companyName: row.companyName,
      message: row.message,
      quantity: row.quantity,
      budgetPaise: row.budgetPaise,
      productName: row.productId ? (names.products.get(row.productId) ?? null) : null,
      customerId: row.customerId,
      source: row.source,
      details: detailsColumn.parse(row.detailsJson, {}),
      adminNote: row.adminNote,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  /** `canAssign`: the caller holds lead.enquiry.assign, which moving the owner requires. */
  async update(
    id: string,
    input: EnquiryUpdateInput,
    canAssign: boolean,
  ): Promise<AdminEnquiryDto> {
    await loadOrThrow(id);

    if (input.assignedToId !== undefined && !canAssign) {
      throw AppError.forbidden('Assigning an enquiry requires lead.enquiry.assign', {
        required: 'lead.enquiry.assign',
      });
    }
    if (input.assignedToId && !(await enquiryRepository.findActiveAdmin(input.assignedToId))) {
      throw AppError.validation('Unknown or inactive admin user', {
        assignedToId: input.assignedToId,
      });
    }

    await enquiryRepository.update(id, input.version, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
      ...(input.adminNote !== undefined ? { adminNote: input.adminNote } : {}),
    });

    return this.get(id);
  },
};
