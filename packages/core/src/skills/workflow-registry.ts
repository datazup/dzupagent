/**
 * Workflow registry — stores and retrieves named SkillChain workflows
 * with tag-based search, JSON serialization, and case-insensitive lookup.
 */

import type { SkillChain } from './skill-chain.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowRegistryEntry {
  name: string
  chain: SkillChain
  description?: string | undefined
  tags?: string[] | undefined
  /** ISO-8601 timestamp of registration. */
  registeredAt: string
}

export interface WorkflowRegistrySnapshot {
  schemaVersion: '1.0.0'
  exportedAt: string
  entries: WorkflowRegistryEntry[]
}

export interface WorkflowRegistrationOptions {
  overwrite?: boolean
  description?: string
  tags?: string[]
}

export interface WorkflowFindResult {
  name: string
  chain: SkillChain
  /** 0-1 relevance score. */
  confidence: number
  matchReason: string
}

export interface WorkflowListEntry {
  name: string
  description?: string | undefined
  tags?: string[] | undefined
  stepCount: number
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class WorkflowRegistry {
  private readonly entries: Map<string, WorkflowRegistryEntry> = new Map()

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  register(name: string, chain: SkillChain, options?: WorkflowRegistrationOptions): void {
    if (!name || name.trim().length === 0) {
      throw new Error('Workflow name must not be empty')
    }
    const key = name.toLowerCase().trim()
    if (this.entries.has(key) && !options?.overwrite) {
      throw new Error(`Workflow "${name}" is already registered. Use overwrite option to replace it.`)
    }
    this.entries.set(key, {
      name,
      chain,
      description: options?.description,
      tags: options?.tags,
      registeredAt: new Date().toISOString(),
    })
  }

  unregister(name: string): boolean {
    const key = name.toLowerCase().trim()
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  get(name: string): SkillChain | undefined {
    const key = name.toLowerCase().trim()
    return this.entries.get(key)?.chain
  }

  find(query: string): WorkflowFindResult[] {
    const q = query.toLowerCase().trim()
    if (q.length === 0) return []

    const results: WorkflowFindResult[] = []

    for (const entry of this.entries.values()) {
      let bestScore = 0
      let bestReason = ''

      // Name match → 1.0
      if (entry.name.toLowerCase().includes(q)) {
        bestScore = 1.0
        bestReason = 'name match'
      }

      // Tag match → 0.7
      if (entry.tags) {
        for (const tag of entry.tags) {
          if (tag.toLowerCase().includes(q) && 0.7 > bestScore) {
            bestScore = 0.7
            bestReason = `tag match: ${tag}`
          }
        }
      }

      // Description match → 0.4
      if (entry.description && entry.description.toLowerCase().includes(q) && 0.4 > bestScore) {
        bestScore = 0.4
        bestReason = 'description match'
      }

      if (bestScore > 0) {
        results.push({
          name: entry.name,
          chain: entry.chain,
          confidence: bestScore,
          matchReason: bestReason,
        })
      }
    }

    // Sort descending by confidence
    results.sort((a, b) => b.confidence - a.confidence)
    return results
  }

  list(): WorkflowListEntry[] {
    const items: WorkflowListEntry[] = []
    for (const entry of this.entries.values()) {
      items.push({
        name: entry.name,
        description: entry.description,
        tags: entry.tags,
        stepCount: entry.chain.steps.length,
      })
    }
    items.sort((a, b) => a.name.localeCompare(b.name))
    return items
  }

  get size(): number {
    return this.entries.size
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  toJSON(): WorkflowRegistrySnapshot {
    return {
      schemaVersion: '1.0.0',
      exportedAt: new Date().toISOString(),
      entries: [...this.entries.values()],
    }
  }

  static fromJSON(snapshot: WorkflowRegistrySnapshot): WorkflowRegistry {
    if (snapshot.schemaVersion !== '1.0.0') {
      throw new Error(
        `Unsupported schema version "${snapshot.schemaVersion}". Expected "1.0.0".`,
      )
    }
    for (const entry of snapshot.entries) {
      if (!entry.name || typeof entry.name !== 'string' || entry.name.trim().length === 0) {
        throw new Error(`WorkflowRegistry.fromJSON: entry has invalid or missing name`)
      }
      if (!entry.chain || !entry.chain.name || !Array.isArray(entry.chain.steps)) {
        throw new Error(`WorkflowRegistry.fromJSON: entry "${entry.name}" has invalid chain structure`)
      }
      if (entry.chain.steps.length === 0) {
        throw new Error(`WorkflowRegistry.fromJSON: entry "${entry.name}" chain has no steps`)
      }
      for (const step of entry.chain.steps) {
        if (!step.skillName || typeof step.skillName !== 'string') {
          throw new Error(`WorkflowRegistry.fromJSON: entry "${entry.name}" has a step with invalid skillName`)
        }
      }
    }
    const registry = new WorkflowRegistry()
    for (const entry of snapshot.entries) {
      registry.entries.set(entry.name.toLowerCase().trim(), entry)
    }
    return registry
  }
}
