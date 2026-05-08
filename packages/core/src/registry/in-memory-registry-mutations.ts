/**
 * Pure mutation helpers for the in-memory registry.
 *
 * These helpers build immutable `RegisteredAgent` snapshots without touching
 * registry state. The `InMemoryRegistry` class composes them to keep the
 * registration / update flows declarative.
 *
 * Implements:
 *  - S6 (immutability): all updates return fresh objects via spread.
 *  - Newly-added capability detection used to emit `registry:capability_added`.
 */
import type {
  RegisterAgentInput,
  RegisteredAgent,
} from './types.js'

/**
 * Build a `RegisteredAgent` from registration input, only setting optional
 * fields when the caller provided them. Mirrors the original conditional
 * spread pattern so that `undefined` values do not appear in the result.
 */
export function buildRegisteredAgent(
  id: string,
  input: RegisterAgentInput,
  now: Date,
): RegisteredAgent {
  return {
    id,
    name: input.name,
    description: input.description,
    protocols: input.protocols ?? [],
    capabilities: [...input.capabilities],
    health: { status: 'unknown' },
    registeredAt: now,
    lastUpdatedAt: now,
    ...(input.endpoint !== undefined && { endpoint: input.endpoint }),
    ...(input.authentication !== undefined && { authentication: input.authentication }),
    ...(input.version !== undefined && { version: input.version }),
    ...(input.sla !== undefined && { sla: { ...input.sla } }),
    ...(input.metadata !== undefined && { metadata: { ...input.metadata } }),
    ...(input.ttlMs !== undefined && { ttlMs: input.ttlMs }),
    ...(input.identity !== undefined && { identity: { ...input.identity } }),
    ...(input.uri !== undefined && { uri: input.uri }),
  }
}

/**
 * Result of applying a partial update to an existing `RegisteredAgent`:
 *  - `updated` — the fresh `RegisteredAgent` snapshot.
 *  - `changedFields` — names of top-level fields that changed (for events).
 *  - `addedCapabilities` — newly-added capability names (for fan-out).
 */
export interface UpdateApplicationResult {
  updated: RegisteredAgent
  changedFields: string[]
  addedCapabilities: string[]
}

/**
 * Apply a `Partial<RegisterAgentInput>` to an existing agent and return a new
 * snapshot. Pure: does not mutate `existing`. Tracks which fields were
 * touched so callers can emit the corresponding registry events.
 */
export function applyUpdateChanges(
  existing: RegisteredAgent,
  changes: Partial<RegisterAgentInput>,
  now: Date,
): UpdateApplicationResult {
  const changedFields: string[] = []
  const addedCapabilities: string[] = []

  const updated: RegisteredAgent = {
    ...existing,
    lastUpdatedAt: now,
  }

  if (changes.name !== undefined) {
    updated.name = changes.name
    changedFields.push('name')
  }
  if (changes.description !== undefined) {
    updated.description = changes.description
    changedFields.push('description')
  }
  if (changes.endpoint !== undefined) {
    updated.endpoint = changes.endpoint
    changedFields.push('endpoint')
  }
  if (changes.protocols !== undefined) {
    updated.protocols = [...changes.protocols]
    changedFields.push('protocols')
  }
  if (changes.capabilities !== undefined) {
    const existingNames = new Set(existing.capabilities.map((c) => c.name))
    for (const cap of changes.capabilities) {
      if (!existingNames.has(cap.name)) {
        addedCapabilities.push(cap.name)
      }
    }
    updated.capabilities = [...changes.capabilities]
    changedFields.push('capabilities')
  }
  if (changes.authentication !== undefined) {
    updated.authentication = changes.authentication
    changedFields.push('authentication')
  }
  if (changes.version !== undefined) {
    updated.version = changes.version
    changedFields.push('version')
  }
  if (changes.sla !== undefined) {
    updated.sla = { ...changes.sla }
    changedFields.push('sla')
  }
  if (changes.metadata !== undefined) {
    updated.metadata = { ...changes.metadata }
    changedFields.push('metadata')
  }
  if (changes.ttlMs !== undefined) {
    updated.ttlMs = changes.ttlMs
    changedFields.push('ttlMs')
  }
  if (changes.identity !== undefined) {
    updated.identity = { ...changes.identity }
    changedFields.push('identity')
  }
  if (changes.uri !== undefined) {
    updated.uri = changes.uri
    changedFields.push('uri')
  }

  return { updated, changedFields, addedCapabilities }
}
