/**
 * Shared ID generation helpers for memory pipelines.
 */

/**
 * Generate an ID in the form `${prefix}_${timestamp}_${random}`.
 */
export function createTimestampedId(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now()}_${suffix}`
}
