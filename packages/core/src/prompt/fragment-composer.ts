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

import { defaultTokenizerRegistry } from '../llm/tokenizer-registry.js'

/**
 * Token estimate routed through the default tokenizer registry. Falls back to
 * the char/4 heuristic when no real tokenizer backend is available, but uses
 * a precise count when `@anthropic-ai/tokenizer` or `js-tiktoken` is
 * installed and a model id is supplied.
 */
function estimateTokens(text: string, model?: string): number {
  return defaultTokenizerRegistry.resolve(model ?? 'heuristic').countTokens(text)
}

/**
 * Compose fragments with dependency resolution, conflict detection, and budget trimming.
 *
 * Resolution order:
 * 1. Evaluate conditions — exclude fragments whose condition returns false.
 * 2. Resolve dependencies — pull in required fragments (transitively). Fragments with a
 *    missing or circular dependency are excluded with a warning.
 * 3. Detect conflicts — when two conflicting fragments are both included, keep the higher-priority one.
 *    Fragments whose dependency was evicted are excluded too. A fragment evicted by a fragment
 *    that is itself dropped later is restored when nothing kept conflicts with it.
 * 4. Sort by priority (descending) then by original order.
 * 5. Trim to maxTokens budget if specified. A fragment is admitted only together with its
 *    dependencies, and the joined content (separators included) must fit the budget.
 *
 * Every included fragment's dependencies are also included.
 */
export function composeAdvancedFragments(
  fragments: ComposableFragment[],
  options?: {
    maxTokens?: number
    context?: Record<string, unknown>
    /** Model id used to pick a tokenizer for `maxTokens` accounting. */
    model?: string
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
  /** Fragments that can never be included, with the reason recorded. */
  const unsatisfiable = new Map<string, string>()

  function resolve(id: string, chain: string[]): void {
    if (resolvedIds.has(id)) return
    const cycleStart = chain.indexOf(id)
    if (cycleStart !== -1) {
      warnings.push(`Circular dependency detected involving "${id}". Skipping.`)
      for (const member of chain.slice(cycleStart)) {
        unsatisfiable.set(member, 'circular dependency')
      }
      return
    }
    const frag = byId.get(id)
    if (!frag) return
    const nextChain = [...chain, id]

    if (frag.dependencies) {
      for (const dep of frag.dependencies) {
        if (!byId.has(dep)) {
          unsatisfiable.set(id, `depends on "${dep}" which is not in the fragment set`)
          continue
        }
        if (!conditionPassed.has(dep)) {
          warnings.push(`Dependency "${dep}" of "${id}" excluded by condition. Including anyway.`)
          conditionPassed.add(dep)
        }
        resolve(dep, nextChain)
      }
    }
    resolvedIds.add(id)
  }

  for (const id of conditionPassed) {
    resolve(id, [])
  }

  const excluded = new Set<string>()
  /** Conflict and closure exclusions that may be undone, with their warning. */
  const reversible = new Map<string, string>()

  function exclude(id: string, warning: string): void {
    excluded.add(id)
    reversible.set(id, warning)
    warnings.push(warning)
  }

  function dropWarning(warning: string | undefined): void {
    const index = warning === undefined ? -1 : warnings.indexOf(warning)
    if (index !== -1) warnings.splice(index, 1)
  }

  for (const [id, reason] of unsatisfiable) {
    excluded.add(id)
    warnings.push(`Fragment "${id}" excluded: ${reason}.`)
  }

  /**
   * Exclude every resolved fragment that depends on an excluded fragment,
   * transitively, so the remaining set is closed under dependencies.
   */
  function enforceDependencyClosure(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const frag of fragments) {
        if (!resolvedIds.has(frag.id) || excluded.has(frag.id)) continue
        const missing = frag.dependencies?.find((dep) => excluded.has(dep))
        if (missing !== undefined) {
          exclude(frag.id, `Fragment "${frag.id}" excluded: dependency "${missing}" is not included.`)
          changed = true
        }
      }
    }
  }

  enforceDependencyClosure()

  // Step 3: conflict resolution — higher priority wins
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
          exclude(conflictId, `Excluded "${conflictId}" (conflicts with "${frag.id}", lower priority).`)
        } else {
          exclude(frag.id, `Excluded "${frag.id}" (conflicts with "${conflictId}", lower priority).`)
          break
        }
      }
    }
  }

  enforceDependencyClosure()

  // Restore, highest priority first, every reversibly excluded fragment whose
  // dependencies are kept and which conflicts with no kept fragment — e.g. a
  // conflict partner whose evictor the closure pass dropped. Budget still
  // applies in step 5.
  const byPriority = (a: ComposableFragment, b: ComposableFragment): number => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return fragments.indexOf(a) - fragments.indexOf(b)
  }
  const conflictsWithKept = (frag: ComposableFragment): boolean =>
    resolvedArray.some(
      (other) =>
        other.id !== frag.id &&
        !excluded.has(other.id) &&
        (frag.conflicts?.includes(other.id) === true || other.conflicts?.includes(frag.id) === true),
    )
  let restored = true
  while (restored) {
    restored = false
    for (const frag of resolvedArray.filter((f) => reversible.has(f.id)).sort(byPriority)) {
      if (frag.dependencies?.some((dep) => excluded.has(dep)) || conflictsWithKept(frag)) continue
      excluded.delete(frag.id)
      dropWarning(reversible.get(frag.id))
      reversible.delete(frag.id)
      restored = true
    }
  }

  // Step 4: sort by priority desc, then original order
  const ordered = resolvedArray
    .filter((f) => !excluded.has(f.id))
    .sort(byPriority)

  // Step 5: budget trimming — a fragment is admitted together with its
  // not-yet-included dependencies, and only when both the summed part
  // estimates and the joined content (separators included) fit the budget.
  const separator = '\n\n---\n\n'
  const includedSet = new Set<string>()
  const finalExcluded: string[] = []
  /** Budget warning per excluded fragment, dropped if a dependent admits it later. */
  const budgetWarnings = new Map<string, string>()
  let usedTokens = 0
  const maxTokens = options?.maxTokens ?? Infinity

  function pendingGroup(frag: ComposableFragment): ComposableFragment[] {
    const group = new Map<string, ComposableFragment>()
    const visit = (f: ComposableFragment): void => {
      if (includedSet.has(f.id) || group.has(f.id)) return
      group.set(f.id, f)
      for (const dep of f.dependencies ?? []) {
        const depFrag = byId.get(dep)
        if (depFrag) visit(depFrag)
      }
    }
    visit(frag)
    return [...group.values()]
  }

  for (const frag of ordered) {
    if (includedSet.has(frag.id)) continue
    const group = pendingGroup(frag)
    const groupTokens = group.reduce((sum, f) => sum + estimateTokens(f.content, options?.model), 0)
    if (usedTokens + groupTokens > maxTokens) {
      finalExcluded.push(frag.id)
      const warning =
        group.length > 1
          ? `Fragment "${frag.id}" excluded: exceeds token budget together with its dependencies.`
          : `Fragment "${frag.id}" excluded: exceeds token budget.`
      budgetWarnings.set(frag.id, warning)
      warnings.push(warning)
      continue
    }
    if (maxTokens !== Infinity) {
      const candidate = ordered
        .filter((f) => includedSet.has(f.id) || group.includes(f))
        .map((f) => f.content)
        .join(separator)
      if (estimateTokens(candidate, options?.model) > maxTokens) {
        finalExcluded.push(frag.id)
        const warning = `Fragment "${frag.id}" excluded: exceeds token budget once joined with separators.`
        budgetWarnings.set(frag.id, warning)
        warnings.push(warning)
        continue
      }
    }
    for (const f of group) {
      includedSet.add(f.id)
      const wasExcluded = finalExcluded.indexOf(f.id)
      if (wasExcluded !== -1) {
        finalExcluded.splice(wasExcluded, 1)
        dropWarning(budgetWarnings.get(f.id))
      }
    }
    usedTokens += groupTokens
  }

  const includedFragments = ordered.filter((f) => includedSet.has(f.id))
  const included = includedFragments.map((f) => f.id)

  // Add condition-excluded and conflict-excluded to the excluded list
  for (const frag of fragments) {
    if (!includedSet.has(frag.id) && !finalExcluded.includes(frag.id)) {
      finalExcluded.push(frag.id)
    }
  }

  return {
    content: includedFragments.map((f) => f.content).join(separator),
    included,
    excluded: finalExcluded,
    warnings,
  }
}
