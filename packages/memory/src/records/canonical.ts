import { decodeMemoryRecordV1 } from './decoder.js'
import {
  canonicalizeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
} from './safe-json.js'
import type { MemoryRecordV1 } from './types.js'

/** Return canonical JSON with recursively sorted object keys. */
export function canonicalizeMemoryRecordV1(input: unknown): string {
  return canonicalizeSafeJson(snapshotSafeJson(decodeMemoryRecordV1(input)))
}

/** Digest the complete canonical record envelope. */
export function digestMemoryRecordV1(input: unknown): `sha256:${string}` {
  return digestSafeJson(snapshotSafeJson(decodeMemoryRecordV1(input)))
}

/** Return a detached, deeply immutable decoded copy. */
export function cloneMemoryRecordV1(input: unknown): MemoryRecordV1 {
  return decodeMemoryRecordV1(input)
}

/** Return a detached, deeply immutable decoded copy. */
export function freezeMemoryRecordV1(input: unknown): Readonly<MemoryRecordV1> {
  return decodeMemoryRecordV1(input)
}
