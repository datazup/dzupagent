/**
 * CRDT push handling for shared memory spaces.
 *
 * Wraps an incoming value in an LWWMap, merges with any existing LWWMap
 * stored under the same key, persists the merged value via the
 * provenance writer, and reports back whether the merge resolved any
 * conflicts so the manager can emit the appropriate events.
 */

import type { MemoryService } from '../memory-service.js'
import type { ProvenanceWriter } from '../provenance/provenance-writer.js'
import type { CRDTResolver } from '../crdt/crdt-resolver.js'
import type { LWWMap } from '../crdt/types.js'
import type { MemoryShareRequest, SharedMemorySpace } from './types.js'
import { hasFields } from './space-helpers.js'

export interface CRDTPushResult {
  /** True if the merge resolved one or more field-level conflicts. */
  hadConflict: boolean
}

/**
 * Handle a CRDT push for a shared space.
 *
 * Caller is responsible for participant/permission validation and for
 * emitting `memory:space:write` / `memory:space:conflict` events based on
 * the returned report.
 */
export async function handleCRDTPushForSpace(deps: {
  memoryService: MemoryService
  provenanceWriter: ProvenanceWriter
  crdtResolver: CRDTResolver
  space: SharedMemorySpace
  request: MemoryShareRequest
  ns: string
  scope: Record<string, string>
}): Promise<CRDTPushResult> {
  const { memoryService, provenanceWriter, crdtResolver, request, ns, scope } = deps

  // Create an LWWMap from the incoming value
  const incomingMap = crdtResolver.createMap(request.value)

  // Check if there is an existing value for this key
  const existing = await memoryService.get(ns, scope, request.key)
  let finalValue: Record<string, unknown>
  let hadConflict = false

  if (existing.length > 0) {
    const existingRecord = existing[0]
    const existingCrdt = existingRecord?.['_crdt']
    if (existingCrdt != null && typeof existingCrdt === 'object' && hasFields(existingCrdt)) {
      const existingMap: LWWMap = { fields: (existingCrdt as { fields: LWWMap['fields'] }).fields }
      const mergeResult = crdtResolver.mergeMaps(existingMap, incomingMap)
      finalValue = {
        ...crdtResolver.toObject(mergeResult.merged),
        _crdt: mergeResult.merged,
      }
      hadConflict = mergeResult.conflictsResolved > 0
    } else {
      // Existing record was not written via CRDT — treat incoming as authoritative
      finalValue = {
        ...crdtResolver.toObject(incomingMap),
        _crdt: incomingMap,
      }
    }
  } else {
    finalValue = {
      ...crdtResolver.toObject(incomingMap),
      _crdt: incomingMap,
    }
  }

  await provenanceWriter.put(
    ns,
    scope,
    request.key,
    finalValue,
    { agentUri: request.from, source: 'shared' },
  )

  return { hadConflict }
}
