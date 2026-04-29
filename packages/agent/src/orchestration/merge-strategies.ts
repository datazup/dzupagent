/**
 * Merge strategies for combining parallel agent results.
 *
 * Each strategy takes an array of result strings and produces
 * a single merged output. Used by mapReduce / mapReduceMulti
 * and AgentOrchestrator.parallel.
 */

/** A function that merges multiple result strings into one. */
export type MergeStrategyFn = (results: string[]) => string | Promise<string>

/**
 * Concatenate all results with separator lines.
 */
export const concatMerge: MergeStrategyFn = (results) =>
  results.join('\n\n---\n\n')

/**
 * Simple majority vote -- return the most common result.
 * Useful for classification tasks where agents output a single label.
 * Ties are broken by first occurrence.
 */
export const voteMerge: MergeStrategyFn = (results) => {
  const counts = new Map<string, number>()
  for (const r of results) {
    const normalized = r.trim()
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }

  let best = ''
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/**
 * Format all results as a numbered list.
 */
export const numberedMerge: MergeStrategyFn = (results) =>
  results.map((r, i) => `${i + 1}. ${r}`).join('\n\n')

/**
 * Serialize all results as a JSON array.
 */
export const jsonArrayMerge: MergeStrategyFn = (results) =>
  JSON.stringify(results, null, 2)

/** Built-in strategy registry. */
const builtinStrategies = {
  concat: concatMerge,
  vote: voteMerge,
  numbered: numberedMerge,
  json: jsonArrayMerge,
} satisfies Record<string, MergeStrategyFn>

export type MergeStrategyName = keyof typeof builtinStrategies

export function isMergeStrategyName(name: string): name is MergeStrategyName {
  return Object.prototype.hasOwnProperty.call(builtinStrategies, name)
}

/**
 * Get a merge strategy by name.
 * @throws if the name is not a known built-in strategy.
 */
export function getMergeStrategy(name: string): MergeStrategyFn {
  if (!isMergeStrategyName(name)) {
    const known = Object.keys(builtinStrategies).join(', ')
    throw new Error(`Unknown merge strategy "${name}". Known strategies: ${known}`)
  }
  return builtinStrategies[name]
}
