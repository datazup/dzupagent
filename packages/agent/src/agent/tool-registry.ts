/**
 * DynamicToolRegistry — allows tools to be added/removed during agent execution.
 *
 * Emits events when tools change so the tool loop can rebind the model.
 *
 * MC-GA03: the registry also tracks per-tool ownership metadata
 * (`ownerId` + `scope`) used by the permission layer. Tools registered
 * without an `ownerId` default to `'shared'`; tools registered with an
 * `ownerId` default to `'private'`. Borrowed tools cannot be
 * re-delegated to a different owner (anti-laundering invariant).
 */
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError } from '@dzupagent/core'
import type {
  ToolScope,
  ToolPermissionEntry,
  ToolPermissionPolicy,
} from '@dzupagent/agent-types'

export type ToolRegistryEvent =
  | { type: 'tool:registered'; name: string; tool: StructuredToolInterface }
  | { type: 'tool:unregistered'; name: string }
  | { type: 'tools:replaced'; count: number }

/** Options accepted by `DynamicToolRegistry.register`. */
export interface RegisterOptions {
  /** Owning agent id. When present and `scope` omitted, defaults to `'private'`. */
  ownerId?: string
  /**
   * Explicit scope override. Defaults to `'shared'` when no `ownerId`,
   * or `'private'` when an `ownerId` is supplied.
   */
  scope?: ToolScope
}

interface RegistryEntry {
  tool: StructuredToolInterface
  ownerId?: string
  scope: ToolScope
}

export class DynamicToolRegistry {
  private readonly entries: Map<string, RegistryEntry> = new Map()
  private readonly listeners: Array<(event: ToolRegistryEvent) => void> = []

  constructor(initialTools?: StructuredToolInterface[]) {
    if (initialTools) {
      for (const tool of initialTools) {
        this.entries.set(tool.name, { tool, scope: 'shared' })
      }
    }
  }

  /**
   * Register a new tool.
   *
   * Defaults:
   * - `scope = 'shared'` when no `ownerId` is supplied.
   * - `scope = 'private'` when an `ownerId` is supplied.
   *
   * Anti-laundering: re-registering an existing `borrowed` tool with a
   * different `ownerId` throws a `TOOL_PERMISSION_DENIED` `ForgeError`.
   */
  register(tool: StructuredToolInterface, options?: RegisterOptions): void {
    const existing = this.entries.get(tool.name)
    if (
      existing
      && existing.scope === 'borrowed'
      && options?.ownerId !== existing.ownerId
    ) {
      throw new ForgeError({
        code: 'TOOL_PERMISSION_DENIED',
        message: `Cannot re-delegate borrowed tool "${tool.name}" to a different owner`,
        context: {
          toolName: tool.name,
          existingOwnerId: existing.ownerId,
          attemptedOwnerId: options?.ownerId,
        },
      })
    }

    const scope: ToolScope
      = options?.scope ?? (options?.ownerId ? 'private' : 'shared')
    const entry: RegistryEntry = { tool, scope }
    if (options?.ownerId !== undefined) entry.ownerId = options.ownerId

    this.entries.set(tool.name, entry)
    this.emit({ type: 'tool:registered', name: tool.name, tool })
  }

  /** Remove a tool by name. Returns true if the tool existed. */
  unregister(name: string): boolean {
    const existed = this.entries.delete(name)
    if (existed) {
      this.emit({ type: 'tool:unregistered', name })
    }
    return existed
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.entries.has(name)
  }

  /** Get a tool by name. */
  get(name: string): StructuredToolInterface | undefined {
    return this.entries.get(name)?.tool
  }

  /** Get all registered tools as an array. */
  getAll(): StructuredToolInterface[] {
    return [...this.entries.values()].map(e => e.tool)
  }

  /** Number of registered tools. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Return the tools accessible to `agentId`.
   *
   * Includes:
   * - every `shared` tool
   * - every `private` or `borrowed` tool whose `ownerId === agentId`
   */
  getToolsForAgent(agentId: string): StructuredToolInterface[] {
    const out: StructuredToolInterface[] = []
    for (const entry of this.entries.values()) {
      if (entry.scope === 'shared' || entry.ownerId === agentId) {
        out.push(entry.tool)
      }
    }
    return out
  }

  /** Return the permission entry (name/ownerId/scope) for a tool. */
  getEntry(name: string): ToolPermissionEntry | undefined {
    const entry = this.entries.get(name)
    if (!entry) return undefined
    const out: ToolPermissionEntry = { name, scope: entry.scope }
    if (entry.ownerId !== undefined) out.ownerId = entry.ownerId
    return out
  }

  /** Return the declared owner of a tool, or `undefined` if unowned / unknown. */
  getOwnerId(name: string): string | undefined {
    return this.entries.get(name)?.ownerId
  }

  /** Return the scope of a tool, or `undefined` if unknown. */
  getScope(name: string): ToolScope | undefined {
    return this.entries.get(name)?.scope
  }

  /** Subscribe to registry changes. Returns an unsubscribe function. */
  onChange(listener: (event: ToolRegistryEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx !== -1) this.listeners.splice(idx, 1)
    }
  }

  /** Replace all tools atomically (bulk update). */
  replaceAll(tools: StructuredToolInterface[]): void {
    this.entries.clear()
    for (const tool of tools) {
      this.entries.set(tool.name, { tool, scope: 'shared' })
    }
    this.emit({ type: 'tools:replaced', count: tools.length })
  }

  private emit(event: ToolRegistryEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

/**
 * Default ownership-based permission policy backed by a
 * {@link DynamicToolRegistry}.
 *
 * Rules:
 * - Unknown tool → deny.
 * - `'shared'` scope → allow any caller.
 * - `'private'` / `'borrowed'` scope → allow only when
 *   `ownerId === callerAgentId`.
 */
export class OwnershipPermissionPolicy implements ToolPermissionPolicy {
  constructor(private readonly registry: DynamicToolRegistry) {}

  hasPermission(callerAgentId: string, toolName: string): boolean {
    const scope = this.registry.getScope(toolName)
    if (scope === undefined) return false
    if (scope === 'shared') return true
    // private / borrowed: owner must match caller
    return this.registry.getOwnerId(toolName) === callerAgentId
  }
}
