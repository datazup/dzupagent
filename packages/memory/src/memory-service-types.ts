/**
 * Type definitions for {@link MemoryService}.
 *
 * These types live in their own module so that the coordinator file
 * (`memory-service.ts`) can stay focused on orchestration and the
 * sibling helper modules (`memory-service-store`, `memory-service-search`,
 * `memory-service-prompt`) can import them without circular references.
 */
import type { SemanticStoreAdapter } from './memory-types.js'
import type { ConsolidationEngineConfig } from './consolidation-engine.js'
import type { ReferenceTracker } from './provenance/reference-tracker.js'

/**
 * Structurally-typed PII detection result. Mirrors
 * `PIIDetectionResult` from `@dzupagent/core/security/pii-detector`
 * without creating a hard dependency on core (memory sits below core
 * in the dependency graph).
 */
export interface MemoryPIIResult {
  hasPII: boolean
  redacted: string
}

/**
 * Structurally-typed event bus for non-fatal memory telemetry.
 * Mirrors the shape of `DzupEventBus.emit` — only the method we use.
 */
export interface MemoryEventBus {
  emit(event: { type: string } & Record<string, unknown>): void
}

export interface MemoryServiceOptions {
  rejectUnsafe?: boolean
  semanticStore?: SemanticStoreAdapter
  referenceTracker?: ReferenceTracker
  /**
   * Toggle PII detection/redaction on the write path. Defaults to true:
   * without an injected `detectPII`, a string `text` field is redacted with
   * the `@dzupagent/security` scanner. Set `false` to store text verbatim.
   */
  piiRedactionEnabled?: boolean
  /**
   * Optional PII detector, replacing the default. When provided and
   * `piiRedactionEnabled !== false`, text content (or the JSON of a value
   * without `text`) is scanned and redacted before persistence. Structurally
   * typed to accept `detectPII` from `@dzupagent/core/security` without a
   * compile-time dependency on core.
   */
  detectPII?: (text: string) => MemoryPIIResult
  /** Optional event bus for non-fatal telemetry emission. */
  eventBus?: MemoryEventBus
  /** Agent id used as a tag when emitting memory events. */
  agentId?: string
  /** Optional post-run consolidation engine configuration. */
  consolidation?: ConsolidationEngineConfig
}

/**
 * Outcome of {@link MemoryService.put}. `put` never throws, so this is the
 * only way a caller can tell a stored record from one dropped by
 * `rejectUnsafe` or lost to a failing store.
 *
 * `written` reports the primary store write only; semantic indexing stays
 * non-fatal and surfaces failures through `memory:error`.
 */
export type MemoryPutResult =
  | { status: 'written'; piiRedacted: boolean }
  | { status: 'rejected'; reason: 'unsafe_content'; threats: string[] }
  | { status: 'failed'; error: string }

/**
 * Caller-supplied context identifying the agent run that issued a read.
 * When present, MemoryService records a fire-and-forget citation via
 * the configured ReferenceTracker (if any).
 */
export interface ReadContext {
  runId: string
}
