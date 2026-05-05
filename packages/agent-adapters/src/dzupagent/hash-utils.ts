/**
 * Shared hashing utilities for the .dzupagent/ subsystem.
 *
 * Centralizes SHA-256 hashing previously duplicated across syncer.ts and
 * importer.ts so divergence detection and import bookkeeping use a single
 * canonical implementation.
 */

import { createHash } from 'node:crypto'

/** Compute the lowercase hex SHA-256 digest of a UTF-8 string. */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}
