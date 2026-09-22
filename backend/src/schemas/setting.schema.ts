import { z } from 'zod';

/** R2 — request shapes live next to the domain, not inline in the router. */
export const publicSettingsQuerySchema = z.object({
  /** Optional group filter, e.g. `site` or `payment`. */
  group: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_.]*$/, 'group must be lowercase letters, digits, "_" or "."')
    .optional(),
});

export type PublicSettingsQuery = z.infer<typeof publicSettingsQuerySchema>;
