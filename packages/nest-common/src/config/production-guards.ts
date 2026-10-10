import type { z } from 'zod';
import type { NodeEnv } from './base-env.schema';

/** Every dev placeholder secret in `.env.example` contains this marker. */
export const DEV_PLACEHOLDER_MARKER = 'change-me';

export interface RefuseDevPlaceholdersOptions {
  /**
   * Exact values that are also refused in production, for dev values that cannot carry the
   * marker (e.g. the SHA-256 hashes of the dev BFF secrets).
   */
  forbiddenValues?: readonly string[];
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/**
 * `superRefine` callback for an app env schema: when `NODE_ENV=production`, any variable whose
 * value contains `change-me` (or equals one of `forbiddenValues`) fails validation, so a
 * container started with the dev placeholders from `.env.example` refuses to boot.
 *
 * Only keys of the schema are checked (zod strips unknown keys first). The issue names the
 * variable but never echoes its value.
 *
 *   export const apiEnvSchema = baseEnvSchema.extend({ ... }).superRefine(refuseDevPlaceholdersInProduction());
 */
export function refuseDevPlaceholdersInProduction<TEnv extends { NODE_ENV: NodeEnv }>(
  options: RefuseDevPlaceholdersOptions = {},
): (env: TEnv, ctx: z.RefinementCtx<TEnv>) => void {
  const forbidden: ReadonlySet<string> = new Set(options.forbiddenValues ?? []);
  return (env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const [key, value] of Object.entries(env)) {
      const isPlaceholder = stringsOf(value).some(
        (item) => item.toLowerCase().includes(DEV_PLACEHOLDER_MARKER) || forbidden.has(item),
      );
      if (isPlaceholder) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Dev placeholder value is not allowed in production; set a real secret',
        });
      }
    }
  };
}
