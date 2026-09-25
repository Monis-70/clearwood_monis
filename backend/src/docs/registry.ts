import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Must run before any `.openapi()` / `registry.register()` call.
extendZodWithOpenApi(z);

/** R7 — Zod schemas are the single source of truth; the spec is generated, never hand-written. */
export const registry = new OpenAPIRegistry();

export const errorBodySchema = registry.register(
  'ErrorResponse',
  z
    .object({
      success: z.literal(false),
      error: z.object({
        code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
        message: z.string(),
        details: z.any().nullable(),
        traceId: z.string().uuid(),
      }),
    })
    .openapi({ description: 'The single error envelope used by every endpoint (R3).' }),
);

export function successBodySchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    success: z.literal(true),
    data,
    meta: z.record(z.any()).nullable(),
  });
}

export function jsonContent<T extends z.ZodTypeAny>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

/** What `noContent()` sends: 200, the success envelope and `data: null` - never a bare 204. */
export const nullDataResponse = jsonContent(successBodySchema(z.null()), 'Done (data is null)');

/** Attached to every registered path so the error envelope is documented once. */
export const commonErrorResponses = {
  422: jsonContent(errorBodySchema, 'Validation failed'),
  429: jsonContent(errorBodySchema, 'Rate limited'),
  500: jsonContent(errorBodySchema, 'Unexpected error'),
};

export { z };
