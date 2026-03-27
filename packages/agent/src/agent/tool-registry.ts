/**
 * DynamicToolRegistry — allows tools to be added/removed during agent execution.
 *
 * Emits events when tools change so the tool loop can rebind the model.
 */
import type { StructuredToolInterface } from '@langchain/core/tools'

export type ToolRegistryEvent =
  | { type: 'tool:registered'; name: string; tool: StructuredToolInterface }
  | { type: 'tool:unregistered'; name: string }
  | { type: 'tools:replaced'; count: number }

export class DynamicToolRegistry {
  private readonly tools: Map<string, StructuredToolInterface> = new Map()
  private readonly listeners: Array<(event: ToolRegistryEvent) => void> = []

  constructor(initialTools?: StructuredToolInterface[]) {
    if (initialTools) {
      for (const tool of initialTools) {
        this.tools.set(tool.name, tool)
      }
    }
  }

  /** Register a new tool. Overwrites if a tool with the same name exists. */
  register(tool: StructuredToolInterface): void {
    this.tools.set(tool.name, tool)
    this.emit({ type: 'tool:registered', name: tool.name, tool })
  }

  /** Remove a tool by name. Returns true if the tool existed. */
  unregister(name: string): boolean {
    const existed = this.tools.delete(name)
    if (existed) {
      this.emit({ type: 'tool:unregistered', name })
    }
    return existed
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Get a tool by name. */
  get(name: string): StructuredToolInterface | undefined {
    return this.tools.get(name)
  }

  /** Get all registered tools as an array. */
  getAll(): StructuredToolInterface[] {
    return [...this.tools.values()]
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size
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
    this.tools.clear()
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
    this.emit({ type: 'tools:replaced', count: tools.length })
  }

  private emit(event: ToolRegistryEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
