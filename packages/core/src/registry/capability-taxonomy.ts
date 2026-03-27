/**
 * Standard capability taxonomy for DzipAgent agents.
 *
 * Capabilities use dot-separated hierarchical names (e.g. `code.review.security`).
 * This module defines the standard tree and provides lookup helpers.
 */

// ---------------------------------------------------------------------------
// Tree types
// ---------------------------------------------------------------------------

/** A node in the capability tree: has a description and optional children. */
export interface CapabilityTreeNode {
  description: string
  [key: string]: string | CapabilityTreeNode
}

/** Recursive tree structure for capability taxonomy. */
export type CapabilityTree = Record<string, CapabilityTreeNode>

// ---------------------------------------------------------------------------
// Standard capability tree
// ---------------------------------------------------------------------------

export const STANDARD_CAPABILITIES: CapabilityTree = {
  code: {
    description: 'Code-related capabilities',
    generate: { description: 'Generate new code' },
    review: {
      description: 'Review code quality',
      security: { description: 'Security-focused code review' },
      performance: { description: 'Performance-focused code review' },
    },
    edit: {
      description: 'Edit existing code',
      'bulk-rename': { description: 'Bulk rename operations' },
      'line-by-line': { description: 'Line-by-line edits' },
      refactor: { description: 'Code refactoring' },
    },
    test: { description: 'Generate or run tests' },
    explain: { description: 'Explain code' },
  },
  data: {
    description: 'Data-related capabilities',
    analyze: { description: 'Analyze data sets' },
    transform: { description: 'Transform data formats' },
    query: { description: 'Query data sources' },
    visualize: { description: 'Create data visualizations' },
  },
  memory: {
    description: 'Memory management capabilities',
    store: { description: 'Store information persistently' },
    retrieve: { description: 'Retrieve stored information' },
    consolidate: { description: 'Consolidate and deduplicate memories' },
    search: { description: 'Semantic search over memories' },
  },
  planning: {
    description: 'Planning and orchestration capabilities',
    decompose: { description: 'Break down complex tasks' },
    schedule: { description: 'Schedule task execution' },
    prioritize: { description: 'Prioritize tasks and subtasks' },
    coordinate: { description: 'Coordinate multi-agent work' },
  },
  communication: {
    description: 'Communication capabilities',
    summarize: { description: 'Summarize content' },
    translate: { description: 'Translate between languages' },
    format: { description: 'Format output for specific audiences' },
    notify: { description: 'Send notifications' },
  },
}

// ---------------------------------------------------------------------------
// Flattened index (built lazily)
// ---------------------------------------------------------------------------

let flatIndex: Map<string, string> | undefined

function buildFlatIndex(): Map<string, string> {
  const result = new Map<string, string>()

  function walk(node: CapabilityTree | CapabilityTreeNode, prefix: string): void {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description') continue
      if (typeof value === 'string') continue
      const path = prefix ? `${prefix}.${key}` : key
      const desc = typeof value.description === 'string' ? value.description : ''
      result.set(path, desc)
      walk(value as CapabilityTree, path)
    }
  }

  walk(STANDARD_CAPABILITIES, '')
  return result
}

function getIndex(): Map<string, string> {
  if (!flatIndex) {
    flatIndex = buildFlatIndex()
  }
  return flatIndex
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a capability name exists in the standard taxonomy.
 *
 * @example
 * isStandardCapability('code.review.security') // true
 * isStandardCapability('nonexistent')           // false
 */
export function isStandardCapability(name: string): boolean {
  return getIndex().has(name)
}

/**
 * Get the description of a standard capability, or undefined if not found.
 */
export function getCapabilityDescription(name: string): string | undefined {
  return getIndex().get(name)
}

/**
 * List all standard capability paths.
 */
export function listStandardCapabilities(): string[] {
  return [...getIndex().keys()]
}
