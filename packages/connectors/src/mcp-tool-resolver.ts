/**
 * MCPAsyncToolResolver — backs Stage 3 semantic resolution with a real
 * MCPClient for lazy MCP tool discovery.
 *
 * Contract rules (from Wave 11 ADR §3.2):
 *  - `resolve()` returns `null` for unknown refs (never throws for unknowns)
 *  - `resolve()` rejects only on infrastructure failure (network, DB) —
 *    the compiler surfaces this as `RESOLVER_INFRA_ERROR`.
 *  - `listAvailable()` is synchronous; the catalogue is cached locally and
 *    refreshed out-of-band via TTL (default 60s) or an explicit
 *    `refreshCatalogue()` call.
 */
import type { AsyncToolResolver, ResolvedTool } from '@dzupagent/flow-ast'
import type { MCPClient } from '@dzupagent/core'
import type {
  McpToolHandle,
  McpInvocationResult,
} from '@dzupagent/core'
import type { JSONSchema7 } from 'json-schema'

/** Options for the MCPAsyncToolResolver. */
export interface MCPAsyncToolResolverOptions {
  /**
   * Catalogue TTL in milliseconds. The cached list of refs returned by
   * `listAvailable()` is considered stale after this interval and refreshed
   * lazily on the next `resolve()` call. Default: 60_000ms.
   */
  ttlMs?: number
}

/**
 * An `AsyncToolResolver` backed by a live `MCPClient` instance.
 *
 * The resolver caches a flat list of `serverId/toolName` refs that it keeps
 * in sync with the client. Discovery of the catalogue is synchronous with
 * respect to the compiler — `listAvailable()` never awaits, so suggestions
 * for "did you mean ..." diagnostics do not incur round-trips.
 */
export class MCPAsyncToolResolver implements AsyncToolResolver {
  private readonly client: MCPClient
  private readonly ttlMs: number
  private cachedRefs: string[] = []
  private lastRefreshAt = 0

  constructor(client: MCPClient, options: MCPAsyncToolResolverOptions = {}) {
    this.client = client
    this.ttlMs = options.ttlMs ?? 60_000
    // Populate initial catalogue synchronously from whatever the client
    // already has loaded (eager + deferred). Connection / discovery is the
    // caller's responsibility — we never initiate it.
    this.refreshCatalogue()
  }

  /**
   * Repopulate the cached ref list from the underlying MCPClient. Call
   * this from a TTL timer, a LISTEN/NOTIFY handler, or after an explicit
   * `connectAll()` when the caller knows new tools are available.
   */
  refreshCatalogue(): void {
    const refs = new Set<string>()
    for (const tool of this.client.getEagerTools()) {
      refs.add(this.makeRef(tool.serverId, tool.name))
    }
    for (const tool of this.client.getDeferredToolNames()) {
      refs.add(this.makeRef(tool.serverId, tool.name))
    }
    this.cachedRefs = Array.from(refs).sort()
    this.lastRefreshAt = Date.now()
  }

  listAvailable(): string[] {
    return this.cachedRefs.slice()
  }

  async resolve(ref: string): Promise<ResolvedTool | null> {
    // Lazy TTL refresh: keeps the cache fresh without requiring callers to
    // wire up a background timer.
    if (Date.now() - this.lastRefreshAt >= this.ttlMs) {
      try {
        this.refreshCatalogue()
      } catch (err) {
        // refreshCatalogue itself only reads local state, but surface any
        // unexpected failure as an infra error so the compiler can emit
        // RESOLVER_INFRA_ERROR instead of silently proceeding with stale
        // data.
        throw new Error(
          `MCPAsyncToolResolver catalogue refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const parsed = this.parseRef(ref)
    if (!parsed) return null

    // Prefer an exact findTool lookup — it also resolves unqualified names
    // when the MCP catalogue has a single matching tool.
    const descriptor = this.client.findTool(parsed.toolName)
    if (!descriptor) return null
    if (parsed.serverId !== undefined && descriptor.serverId !== parsed.serverId) {
      // Ref qualified a server that does not own this tool — treat as
      // unknown rather than silently collapsing.
      return null
    }

    const handle: McpToolHandle = {
      kind: 'mcp-tool',
      id: this.makeRef(descriptor.serverId, descriptor.name),
      serverId: descriptor.serverId,
      toolName: descriptor.name,
      inputSchema: descriptor.inputSchema as unknown as JSONSchema7,
      invoke: async (input: unknown): Promise<McpInvocationResult> => {
        const args = (input ?? {}) as Record<string, unknown>
        let result
        try {
          result = await this.client.invokeTool(descriptor.name, args)
        } catch (err) {
          // MCPClient.invokeTool is documented non-throwing, but we guard
          // anyway so handle consumers get a consistent shape.
          throw new Error(
            `MCP tool invocation failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return {
          content: (result.content ?? []).map((part) => {
            if (part.type === 'text') {
              return { type: 'text' as const, value: part.text ?? '' }
            }
            if (part.type === 'image') {
              return { type: 'image' as const, value: part.data ?? '' }
            }
            return { type: 'json' as const, value: part }
          }),
          isError: result.isError === true,
        }
      },
    }

    return {
      ref,
      kind: 'mcp-tool',
      inputSchema: descriptor.inputSchema,
      handle,
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private makeRef(serverId: string, toolName: string): string {
    return `${serverId}/${toolName}`
  }

  private parseRef(ref: string): { serverId?: string; toolName: string } | null {
    if (!ref) return null
    const slash = ref.indexOf('/')
    if (slash === -1) {
      return { toolName: ref }
    }
    const serverId = ref.slice(0, slash)
    const toolName = ref.slice(slash + 1)
    if (!serverId || !toolName) return null
    return { serverId, toolName }
  }
}
