/**
 * Advanced prompt fragment composition with dependency resolution,
 * conflict detection, and token-budget trimming.
 *
 * Builds on the simpler composeFragments() from prompt-fragments.ts.
 */

export interface ComposableFragment {
  id: string
  content: string
  /** Higher priority fragments are included first when budget-trimming (default: 0). */
  priority: number
  /** Fragment IDs this fragment depends on (will be auto-included). */
  dependencies?: string[]
  /** Fragment IDs this fragment conflicts with (mutually exclusive). */
  conflicts?: string[]
  /** Predicate — fragment is included only when condition returns true. */
  condition?: (context: Record<string, unknown>) => boolean
}

export interface ComposeResult {
  content: string
  included: string[]
  excluded: string[]
  warnings: string[]
}

/**
 * Validate a fragment set for conflicts and missing dependencies.
 */
export function validateFragments(fragments: ComposableFragment[]): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const idSet = new Set(fragments.map((f) => f.id))

  for (const frag of fragments) {
    // Check for missing dependencies
    if (frag.dependencies) {
      for (const dep of frag.dependencies) {
        if (!idSet.has(dep)) {
          errors.push(`Fragment "${frag.id}" depends on "${dep}" which is not in the fragment set.`)
        }
      }
    }

    // Check for self-conflicts
    if (frag.conflicts?.includes(frag.id)) {
      errors.push(`Fragment "${frag.id}" lists itself as a conflict.`)
    }

    // Check for mutual conflict consistency (warning-level, still an error for strict validation)
    if (frag.conflicts) {
      for (const conflictId of frag.conflicts) {
        const other = fragments.find((f) => f.id === conflictId)
        if (other && !other.conflicts?.includes(frag.id)) {
          errors.push(
            `Fragment "${frag.id}" conflicts with "${conflictId}" but "${conflictId}" does not list "${frag.id}" as a conflict.`,
          )
        }
      }
    }
  }

  // Check for duplicate IDs
  const seen = new Set<string>()
  for (const frag of fragments) {
    if (seen.has(frag.id)) {
      errors.push(`Duplicate fragment ID "${frag.id}".`)
    }
    seen.add(frag.id)
  }

  return { valid: errors.length === 0, errors }
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Compose fragments with dependency resolution, conflict detection, and budget trimming.
 *
 * Resolution order:
 * 1. Evaluate conditions — exclude fragments whose condition returns false.
 * 2. Resolve dependencies — pull in required fragments (transitively).
 * 3. Detect conflicts — when two conflicting fragments are both included, keep the higher-priority one.
 * 4. Sort by priority (descending) then by original order.
 * 5. Trim to maxTokens budget if specified.
 */
export function composeAdvancedFragments(
  fragments: ComposableFragment[],
  options?: {
    maxTokens?: number
    context?: Record<string, unknown>
  },
): ComposeResult {
  const ctx = options?.context ?? {}
  const warnings: string[] = []

  const byId = new Map<string, ComposableFragment>()
  for (const f of fragments) {
    byId.set(f.id, f)
  }

  // Step 1: condition filtering
  const conditionPassed = new Set<string>()
  for (const frag of fragments) {
    if (!frag.condition || frag.condition(ctx)) {
      conditionPassed.add(frag.id)
    }
  }

  // Step 2: resolve dependencies (transitive)
  const resolvedIds = new Set<string>()

  function resolve(id: string, chain: Set<string>): void {
    if (resolvedIds.has(id)) return
    if (chain.has(id)) {
      warnings.push(`Circular dependency detected involving "${id}". Skipping.`)
      return
    }
    const frag = byId.get(id)
    if (!frag) return
    chain.add(id)

    if (frag.dependencies) {
      for (const dep of frag.dependencies) {
        if (!conditionPassed.has(dep)) {
          warnings.push(`Dependency "${dep}" of "${id}" excluded by condition. Including anyway.`)
          conditionPassed.add(dep)
        }
        resolve(dep, new Set(chain))
      }
    }
    resolvedIds.add(id)
  }

  for (const id of conditionPassed) {
    resolve(id, new Set())
  }

  // Step 3: conflict resolution — higher priority wins
  const excluded = new Set<string>()
  const resolvedArray = fragments.filter((f) => resolvedIds.has(f.id))

  for (const frag of resolvedArray) {
    if (excluded.has(frag.id)) continue
    if (frag.conflicts) {
      for (const conflictId of frag.conflicts) {
        if (excluded.has(conflictId)) continue
        const other = byId.get(conflictId)
        if (!other || !resolvedIds.has(conflictId)) continue

        // Both are included — evict the lower priority one
        if (frag.priority >= other.priority) {
          excluded.add(conflictId)
          warnings.push(`Excluded "${conflictId}" (conflicts with "${frag.id}", lower priority).`)
        } else {
          excluded.add(frag.id)
          warnings.push(`Excluded "${frag.id}" (conflicts with "${conflictId}", lower priority).`)
          break
        }
      }
    }
  }

  // Step 4: sort by priority desc, then original order
  const ordered = resolvedArray
    .filter((f) => !excluded.has(f.id))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return fragments.indexOf(a) - fragments.indexOf(b)
    })

  // Step 5: budget trimming
  const included: string[] = []
  const finalExcluded: string[] = []
  const parts: string[] = []
  let usedTokens = 0
  const maxTokens = options?.maxTokens ?? Infinity

  for (const frag of ordered) {
    const fragTokens = estimateTokens(frag.content)
    if (usedTokens + fragTokens > maxTokens) {
      finalExcluded.push(frag.id)
      warnings.push(`Fragment "${frag.id}" excluded: exceeds token budget.`)
      continue
    }
    included.push(frag.id)
    parts.push(frag.content)
    usedTokens += fragTokens
  }

  // Add condition-excluded and conflict-excluded to the excluded list
  for (const frag of fragments) {
    if (!included.includes(frag.id) && !finalExcluded.includes(frag.id)) {
      finalExcluded.push(frag.id)
    }
  }

  return {
    content: parts.join('\n\n---\n\n'),
    included,
    excluded: finalExcluded,
    warnings,
  }
}
