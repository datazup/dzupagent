/**
 * AgentRegistryAsyncToolResolver — backs Stage 3 semantic resolution with
 * a remote AgentRegistry HTTP endpoint.
 *
 * The resolver fetches a catalogue of known agent refs on construct and on
 * a TTL basis, and looks up individual refs on demand. It never wraps an
 * in-process `AgentRegistry` implementation — use that directly (sync) if
 * the registry is co-located with the compiler.
 *
 * Contract rules (from Wave 11 ADR §3.2):
 *  - `resolve()` returns `null` for unknown refs (never throws for unknowns)
 *  - `resolve()` rejects only on infrastructure failure (network, timeout) —
 *    the compiler surfaces this as `RESOLVER_INFRA_ERROR`.
 *  - `listAvailable()` is synchronous and returns the cached catalogue;
 *    refreshes happen lazily on the next `resolve()` once the TTL elapses.
 */
import type { AsyncToolResolver, ResolvedTool } from '@dzupagent/flow-ast'
import type {
  AgentHandle,
  AgentInvocation,
  AgentInvocationResult,
} from '@dzupagent/core'
import type { JSONSchema7 } from 'json-schema'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal fetch signature we rely on — matches the global fetch API. */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  statusText: string
  json(): Promise<unknown>
}>

/** Options for the AgentRegistryAsyncToolResolver. */
export interface AgentRegistryAsyncToolResolverOptions {
  /** Base URL of the agent registry service (no trailing slash required). */
  baseUrl: string
  /** Optional HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>
  /** Catalogue TTL in milliseconds. Default: 60_000ms. */
  ttlMs?: number
  /** Per-request timeout in milliseconds. Default: 10_000ms. */
  timeoutMs?: number
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: FetchLike
}

/** Shape of a single agent entry returned by the registry. */
interface RemoteAgentDescriptor {
  id: string
  name?: string
  displayName?: string
  inputSchema?: unknown
  outputSchema?: unknown
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export class AgentRegistryAsyncToolResolver implements AsyncToolResolver {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly fetchFn: FetchLike

  private cachedRefs: string[] = []
  private cachedAgents = new Map<string, RemoteAgentDescriptor>()
  private lastRefreshAt = 0
  private refreshInFlight: Promise<void> | null = null

  constructor(options: AgentRegistryAsyncToolResolverOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.headers = { 'accept': 'application/json', ...(options.headers ?? {}) }
    this.ttlMs = options.ttlMs ?? 60_000
    this.timeoutMs = options.timeoutMs ?? 10_000
    const injected = options.fetch
    if (injected) {
      this.fetchFn = injected
    } else if (typeof globalThis.fetch === 'function') {
      this.fetchFn = globalThis.fetch.bind(globalThis) as FetchLike
    } else {
      throw new Error(
        'AgentRegistryAsyncToolResolver requires a fetch implementation; pass options.fetch or run on Node.js 20+',
      )
    }
  }

  /**
   * Force a catalogue refresh. Safe to call from a TTL timer or a
   * registry change subscription. Throws on infra failure so the caller
   * can escalate to `RESOLVER_INFRA_ERROR`.
   */
  async refreshCatalogue(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }
    this.refreshInFlight = this.doRefresh()
    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  listAvailable(): string[] {
    return this.cachedRefs.slice()
  }

  async resolve(ref: string): Promise<ResolvedTool | null> {
    if (!ref) return null

    // Lazy refresh on TTL expiry so `listAvailable()` eventually reflects
    // upstream changes without requiring a background timer.
    if (Date.now() - this.lastRefreshAt >= this.ttlMs) {
      await this.refreshCatalogue()
    }

    let descriptor = this.cachedAgents.get(ref)
    if (!descriptor) {
      // Fall back to a direct point lookup — catalogue may be stale or
      // paginated and the caller is asking for a known id.
      const fetched = await this.fetchAgent(ref)
      if (!fetched) return null
      descriptor = fetched
      // Populate cache so subsequent resolves and listAvailable() reflect
      // the discovery.
      this.cachedAgents.set(descriptor.id, descriptor)
      if (!this.cachedRefs.includes(descriptor.id)) {
        this.cachedRefs = [...this.cachedRefs, descriptor.id].sort()
      }
    }

    const handle: AgentHandle = {
      kind: 'agent',
      id: descriptor.id,
      displayName: descriptor.displayName ?? descriptor.name ?? descriptor.id,
      invoke: async (invocation: AgentInvocation): Promise<AgentInvocationResult> => {
        return this.invokeAgent(descriptor.id, invocation)
      },
    }

    return {
      ref,
      kind: 'agent',
      inputSchema: (descriptor.inputSchema ?? {}) as JSONSchema7,
      outputSchema: descriptor.outputSchema,
      handle,
    }
  }

  // -------------------------------------------------------------------------
  // HTTP primitives
  // -------------------------------------------------------------------------

  private async doRefresh(): Promise<void> {
    const response = await this.requestJson(`${this.baseUrl}/agents`, 'GET')
    const descriptors = this.parseList(response)
    this.cachedAgents = new Map(descriptors.map((d) => [d.id, d]))
    this.cachedRefs = descriptors.map((d) => d.id).sort()
    this.lastRefreshAt = Date.now()
  }

  private async fetchAgent(ref: string): Promise<RemoteAgentDescriptor | null> {
    try {
      const response = await this.requestJson(
        `${this.baseUrl}/agents/${encodeURIComponent(ref)}`,
        'GET',
      )
      return this.parseDescriptor(response)
    } catch (err) {
      // Preserve the 404-as-null contract: only a missing-resource response
      // collapses to null; any other failure re-throws for the compiler.
      if (err instanceof NotFoundError) return null
      throw err
    }
  }

  private async invokeAgent(
    agentId: string,
    invocation: AgentInvocation,
  ): Promise<AgentInvocationResult> {
    const started = Date.now()
    const response = await this.requestJson(
      `${this.baseUrl}/agents/${encodeURIComponent(agentId)}/invoke`,
      'POST',
      JSON.stringify({
        prompt: invocation.prompt,
        context: invocation.context,
        parentRunId: invocation.parentRunId,
      }),
    )
    const body = (response ?? {}) as {
      output?: unknown
      runId?: string
      durationMs?: number
    }
    return {
      output: body.output ?? null,
      runId: body.runId ?? `${agentId}-${started}`,
      durationMs: body.durationMs ?? Date.now() - started,
    }
  }

  private async requestJson(
    url: string,
    method: 'GET' | 'POST',
    body?: string,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { ...this.headers }
      if (body !== undefined) {
        headers['content-type'] = 'application/json'
      }
      const init: Parameters<FetchLike>[1] = {
        method,
        headers,
        signal: controller.signal,
      }
      if (body !== undefined) {
        init.body = body
      }
      const response = await this.fetchFn(url, init)
      if (response.status === 404) {
        throw new NotFoundError(url)
      }
      if (!response.ok) {
        throw new Error(
          `AgentRegistry HTTP ${response.status}: ${response.statusText}`,
        )
      }
      return await response.json()
    } catch (err) {
      if (err instanceof NotFoundError) throw err
      throw new Error(
        `AgentRegistry request failed (${method} ${url}): ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  private parseList(raw: unknown): RemoteAgentDescriptor[] {
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { agents?: unknown[] })?.agents)
        ? (raw as { agents: unknown[] }).agents
        : Array.isArray((raw as { results?: unknown[] })?.results)
          ? (raw as { results: unknown[] }).results
          : []
    const out: RemoteAgentDescriptor[] = []
    for (const entry of list) {
      const descriptor = this.parseDescriptor(entry)
      if (descriptor) out.push(descriptor)
    }
    return out
  }

  private parseDescriptor(raw: unknown): RemoteAgentDescriptor | null {
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id : undefined
    if (!id) return null
    const descriptor: RemoteAgentDescriptor = { id }
    if (typeof obj.name === 'string') descriptor.name = obj.name
    if (typeof obj.displayName === 'string') descriptor.displayName = obj.displayName
    if (obj.inputSchema !== undefined) descriptor.inputSchema = obj.inputSchema
    if (obj.outputSchema !== undefined) descriptor.outputSchema = obj.outputSchema
    return descriptor
  }
}

// ---------------------------------------------------------------------------
// Internal error — used only to signal "unknown ref" without collapsing real
// network failures into `null`.
// ---------------------------------------------------------------------------

class NotFoundError extends Error {
  constructor(url: string) {
    super(`Not found: ${url}`)
    this.name = 'NotFoundError'
  }
}
