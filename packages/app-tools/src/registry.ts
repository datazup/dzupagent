import type { DomainToolDefinition, DomainToolRegistry } from './types.js'

/**
 * In-memory implementation of {@link DomainToolRegistry}.
 *
 * Backed by a simple `Map<string, DomainToolDefinition>` keyed by the tool's
 * dot-namespaced `name`. Registering a tool with an existing name overwrites
 * the previous definition.
 */
export class InMemoryDomainToolRegistry implements DomainToolRegistry {
  private readonly tools = new Map<string, DomainToolDefinition>()

  register(tool: DomainToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): DomainToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): DomainToolDefinition[] {
    return Array.from(this.tools.values())
  }

  listByNamespace(namespace: string): DomainToolDefinition[] {
    return this.list().filter((tool) => tool.namespace === namespace)
  }
}
