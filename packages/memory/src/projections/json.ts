import { canonicalizeSafeJson, snapshotSafeJson } from '../records/safe-json.js'
import type { MemoryProjectionRequestV1 } from './types.js'
import { assertOutputBound, projectMemoryRecordV1 } from './project.js'
import { decodeProjectionRequest } from './validation.js'

/** Render canonical JSON with recursively sorted keys and one trailing newline. */
export function projectMemoryRecordToJson(request: MemoryProjectionRequestV1): string {
  const projection = projectMemoryRecordV1(request)
  const text = `${canonicalizeSafeJson(snapshotSafeJson(projection))}\n`
  assertOutputBound(text, decodeProjectionRequest(request).profile)
  return text
}
