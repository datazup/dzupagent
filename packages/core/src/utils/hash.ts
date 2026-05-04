import { createHash } from 'node:crypto'

/**
 * Produce a short deterministic hex fingerprint of any serializable value.
 * Used by stuck detectors and dedup utilities to compare tool inputs without
 * storing the full payload.
 */
export function hashToolInput(input: unknown): string {
  const str = typeof input === 'string' ? input : JSON.stringify(input)
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}
