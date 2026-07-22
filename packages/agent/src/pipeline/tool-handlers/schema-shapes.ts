/**
 * Minimal structural shape for a Zod-like schema. Kept dependency-free so that
 * both low-level helpers and the validation type surface can reference it
 * without forming an import cycle.
 */
export interface RuntimeZodLikeSchema {
  safeParse(data: unknown): {
    success: boolean;
    error?: unknown;
  };
}
