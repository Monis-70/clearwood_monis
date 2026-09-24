import type { EnquiryStatus } from '../enums';

/** What the customer gets back: a reference, never their own details echoed. */
export interface EnquiryReceiptDto {
  reference: string;
  receivedAt: string;
}

export interface AdminEnquirySummaryDto {
  id: string;
  formKey: string;
  status: EnquiryStatus;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  categoryId: string | null;
  categoryName: string | null;
  productId: string | null;
  assignedToId: string | null;
  createdAt: string;
}

export interface AdminEnquiryDto extends AdminEnquirySummaryDto {
  pincode: string | null;
  companyName: string | null;
  message: string | null;
  quantity: number | null;
  budgetPaise: number | null;
  productName: string | null;
  customerId: string | null;
  source: string;
  details: Record<string, string | number | boolean>;
  adminNote: string | null;
  version: number;
  updatedAt: string;
}
