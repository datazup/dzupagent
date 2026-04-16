/**
 * withMemoryEnrichment — adapter wrapper that recalls relevant memories from
 * `@dzupagent/memory` before each `execute()` / `resumeSession()` call and
 * injects the recalled snippets into the request's system prompt.
 *
 * Design notes:
 * - Wraps any `AgentCLIAdapter` (does not subclass) — keeps the adapter
 *   hierarchy flat.
 * - Memory recall is best-effort: errors are caught and logged; the original
 *   call is never blocked by a memory failure.
 * - The recall results are serialised to a compact text block and prepended
 *   to `input.systemPrompt`.  The combined prompt is then handed to the
 *   wrapped adapter; the adapter applies provider-specific encoding
 *   (e.g. ClaudeAdapter turns it into a preset-append object automatically).
 * - If no memories are recalled, `input.systemPrompt` is left unchanged.
 *
 * Usage:
 *   const enriched = withMemoryEnrichment(new ClaudeAgentAdapter({ … }), {
 *     memoryService,
 *     namespace: 'agent-context',
 *     scope:     { tenantId: 'acme', projectId: 'myapp' },
 *     limit:     5,
 *     header:    '## Recalled context\n',
 *   })
 *   // enriched satisfies AgentCLIAdapter
 *   for await (const evt of enriched.execute({ prompt: '…' })) { … }
 */

import type { AgentCLIAdapter, AgentInput, AgentEvent, AdapterCapabilityProfile, HealthStatus } from '../types.js'

// ---------------------------------------------------------------------------
// Minimal MemoryService interface — avoids a hard dep on @dzupagent/memory
// while still being type-safe at call sites that have the real package.
// ---------------------------------------------------------------------------

export interface MemoryServiceLike {
  search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MemoryEnrichmentOptions {
  /** The MemoryService (or compatible duck-type) to recall from. */
  memoryService: MemoryServiceLike

  /** Namespace to search (e.g. 'agent-context', 'decisions', 'lessons'). */
  namespace: string

  /**
   * Scope keys that identify the tenant / project for namespace isolation
   * (e.g. `{ tenantId: 'acme', projectId: 'myapp' }`).
   */
  scope: Record<string, string>

  /** Maximum number of memory items to recall per request. Defaults to 5. */
  limit?: number

  /**
   * Header prepended to the recalled memories block.
   * Defaults to `## Recalled context\n`.
   */
  header?: string

  /**
   * Extract a human-readable snippet from a memory record.
   * Defaults to the `text` field, then JSON.stringify of the whole record.
   */
  formatRecord?: (record: Record<string, unknown>) => string

  /**
   * Optional logger for non-fatal errors during memory recall.
   * Defaults to `console.warn`.
   */
  onRecallError?: (err: unknown) => void
}

// ---------------------------------------------------------------------------
// Wrapper factory
// ---------------------------------------------------------------------------

/**
 * Wraps an `AgentCLIAdapter` with memory enrichment.
 * Returns a new object that satisfies `AgentCLIAdapter`.
 */
export function withMemoryEnrichment(
  adapter: AgentCLIAdapter,
  opts: MemoryEnrichmentOptions,
): AgentCLIAdapter {
  const limit = opts.limit ?? 5
  const header = opts.header ?? '## Recalled context\n'
  const formatRecord = opts.formatRecord ?? defaultFormatRecord
  const onRecallError = opts.onRecallError ?? ((e) => console.warn('[withMemoryEnrichment] recall error:', e))

  async function recallAndEnrich(input: AgentInput): Promise<AgentInput> {
    let memories: Record<string, unknown>[] = []
    try {
      memories = await opts.memoryService.search(opts.namespace, opts.scope, input.prompt, limit)
    } catch (err) {
      onRecallError(err)
      return input
    }

    if (memories.length === 0) return input

    const snippets = memories.map((r) => `- ${formatRecord(r)}`).join('\n')
    const memoryBlock = `${header}${snippets}\n`
    const existingSystemPrompt = input.systemPrompt ?? ''
    const combinedSystemPrompt = existingSystemPrompt
      ? `${existingSystemPrompt}\n\n${memoryBlock}`
      : memoryBlock

    return { ...input, systemPrompt: combinedSystemPrompt }
  }

  // Build the wrapper preserving all methods of the original adapter.
  const wrapper: AgentCLIAdapter = {
    get providerId() {
      return adapter.providerId
    },

    getCapabilities(): AdapterCapabilityProfile {
      return adapter.getCapabilities()
    },

    configure(config: Parameters<AgentCLIAdapter['configure']>[0]): void {
      adapter.configure(config)
    },

    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      const enriched = await recallAndEnrich(input)
      yield* adapter.execute(enriched)
    },

    async *resumeSession(
      sessionId: string,
      input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      const enriched = await recallAndEnrich(input)
      yield* adapter.resumeSession(sessionId, enriched)
    },

    interrupt(): void {
      adapter.interrupt()
    },

    async healthCheck(): Promise<HealthStatus> {
      return adapter.healthCheck()
    },
  }

  return wrapper
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultFormatRecord(record: Record<string, unknown>): string {
  if (typeof record['text'] === 'string') return record['text']
  try {
    return JSON.stringify(record)
  } catch {
    return String(record)
  }
}

// ---------------------------------------------------------------------------
// Hierarchical Memory Enrichment
// ---------------------------------------------------------------------------

export type MemoryLevel = 'global' | 'workspace' | 'project' | 'agent'

export interface HierarchicalMemorySource {
  level: MemoryLevel
  loader: MemoryServiceLike
  skip?: boolean
}

export interface HierarchicalMemoryEnrichmentOptions {
  sources: HierarchicalMemorySource[]
  /** Max total tokens across ALL sources combined. Default: no limit */
  maxTotalTokens?: number
  /** Called after successful recall of all sources */
  onRecalled?: (
    entries: Array<{ level: MemoryLevel; name: string; tokenEstimate: number }>,
    totalTokens: number,
  ) => void
  /** Called when a source throws during recall — other sources still load */
  onRecallError?: (err: unknown) => void
}

/**
 * Wraps an `AgentCLIAdapter` with hierarchical memory enrichment.
 *
 * Unlike `withMemoryEnrichment` (single source), this variant accepts
 * multiple memory sources at different hierarchy levels (global, workspace,
 * project, agent), applies a combined token budget, and isolates failures
 * so one broken source never blocks the others.
 */
export function withHierarchicalMemoryEnrichment(
  adapter: AgentCLIAdapter,
  opts: HierarchicalMemoryEnrichmentOptions,
): AgentCLIAdapter {
  const onRecallError = opts.onRecallError ?? ((e) => console.warn('[withHierarchicalMemoryEnrichment] recall error:', e))

  async function recallAndEnrich(input: AgentInput): Promise<AgentInput> {
    const allRecords: Array<{
      level: MemoryLevel
      record: Record<string, unknown>
      text: string
      tokenEstimate: number
    }> = []

    for (const source of opts.sources) {
      if (source.skip) continue

      let records: Record<string, unknown>[]
      try {
        records = await source.loader.search('', {}, '', undefined)
      } catch (err) {
        onRecallError(err)
        continue
      }

      for (const record of records) {
        const text = defaultFormatRecord(record)
        const tokenEstimate = Math.ceil(text.length / 4)
        allRecords.push({ level: source.level, record, text, tokenEstimate })
      }
    }

    if (allRecords.length === 0) return input

    // Apply token budget — whole-record truncation
    const includedRecords: typeof allRecords = []
    let totalTokens = 0

    for (const entry of allRecords) {
      if (opts.maxTotalTokens !== undefined && totalTokens + entry.tokenEstimate > opts.maxTotalTokens) {
        break
      }
      includedRecords.push(entry)
      totalTokens += entry.tokenEstimate
    }

    if (includedRecords.length === 0) return input

    // Build the memory block
    const snippets = includedRecords.map((e) => `- ${e.text}`).join('\n')
    const memoryBlock = `## Project Context\n${snippets}\n`

    const existingSystemPrompt = input.systemPrompt ?? ''
    const combinedSystemPrompt = existingSystemPrompt
      ? `${existingSystemPrompt}\n\n${memoryBlock}`
      : memoryBlock

    // Fire onRecalled callback
    if (opts.onRecalled) {
      const entries = includedRecords.map((e) => ({
        level: e.level,
        name: typeof e.record['name'] === 'string'
          ? e.record['name']
          : typeof e.record['key'] === 'string'
            ? e.record['key']
            : defaultFormatRecord(e.record).slice(0, 50),
        tokenEstimate: e.tokenEstimate,
      }))
      opts.onRecalled(entries, totalTokens)
    }

    return { ...input, systemPrompt: combinedSystemPrompt }
  }

  const wrapper: AgentCLIAdapter = {
    get providerId() {
      return adapter.providerId
    },

    getCapabilities(): AdapterCapabilityProfile {
      return adapter.getCapabilities()
    },

    configure(config: Parameters<AgentCLIAdapter['configure']>[0]): void {
      adapter.configure(config)
    },

    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      const enriched = await recallAndEnrich(input)
      yield* adapter.execute(enriched)
    },

    async *resumeSession(
      sessionId: string,
      input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      const enriched = await recallAndEnrich(input)
      yield* adapter.resumeSession(sessionId, enriched)
    },

    interrupt(): void {
      adapter.interrupt()
    },

    async healthCheck(): Promise<HealthStatus> {
      return adapter.healthCheck()
    },
  }

  return wrapper
}
