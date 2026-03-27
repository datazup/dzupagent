/**
 * Template registry — mutable collection for registering, querying,
 * and discovering agent templates.
 *
 * @module templates/template-registry
 */

import type { AgentTemplate, AgentTemplateCategory } from './agent-templates.js'
import { ALL_AGENT_TEMPLATES } from './agent-templates.js'

/**
 * Mutable registry of agent templates.
 *
 * The registry is pre-populated with built-in templates but accepts custom
 * templates via `register()`. Duplicate IDs overwrite the previous entry.
 */
export class TemplateRegistry {
  private readonly templates = new Map<string, AgentTemplate>()

  /**
   * Create a new registry, optionally pre-populated with built-in templates.
   *
   * @param includeBuiltins - If `true` (default), loads the 22 built-in templates.
   */
  constructor(includeBuiltins = true) {
    if (includeBuiltins) {
      for (const t of ALL_AGENT_TEMPLATES) {
        this.templates.set(t.id, t)
      }
    }
  }

  /**
   * Register a template. Overwrites any existing template with the same ID.
   */
  register(template: AgentTemplate): void {
    this.templates.set(template.id, template)
  }

  /**
   * Get a template by ID.
   *
   * @returns The matching template, or `undefined` if not found.
   */
  get(id: string): AgentTemplate | undefined {
    return this.templates.get(id)
  }

  /**
   * List all registered templates.
   */
  list(): AgentTemplate[] {
    return [...this.templates.values()]
  }

  /**
   * List templates matching a specific tag (case-sensitive).
   */
  listByTag(tag: string): AgentTemplate[] {
    return [...this.templates.values()].filter(t => t.tags.includes(tag))
  }

  /**
   * List templates belonging to a specific category.
   */
  listByCategory(category: AgentTemplateCategory): AgentTemplate[] {
    return [...this.templates.values()].filter(t => t.category === category)
  }

  /**
   * Remove a template by ID.
   *
   * @returns `true` if the template existed and was removed.
   */
  remove(id: string): boolean {
    return this.templates.delete(id)
  }

  /**
   * Number of registered templates.
   */
  get size(): number {
    return this.templates.size
  }
}
