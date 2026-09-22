/**
 * R3 — the one and only response envelope. Both frontends and every test assert against these.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ApiMeta = Record<string, unknown>;

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: ApiMeta | null;
}

export interface ApiErrorDetail {
  /** Machine-readable SNAKE_CASE code, e.g. `VALIDATION_ERROR`. */
  code: string;
  message: string;
  details: unknown | null;
  /** Mirrors the `x-request-id` response header — quote this in a bug report. */
  traceId: string;
}

export interface ApiErrorBody {
  success: false;
  error: ApiErrorDetail;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;

/** R5 — the meta block every list endpoint returns. */
export interface PaginationMeta extends ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}

/** A successful list response. */
export interface Paginated<T> extends ApiSuccess<T[]> {
  meta: PaginationMeta;
}

export interface PaginationInput {
  page: number;
  limit: number;
  total: number;
}

export function buildPaginationMeta({ page, limit, total }: PaginationInput): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return { page, limit, total, totalPages, hasNext: page < totalPages };
}

export function isApiError(body: unknown): body is ApiErrorBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { success?: unknown }).success === false &&
    typeof (body as { error?: unknown }).error === 'object'
  );
}
