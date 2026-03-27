/**
 * Parallel sampling — run N independent code generation attempts on forked
 * VFS instances, score each result, and merge the winner back.
 *
 * Inspired by Replit's parallel sampling pattern: fork the virtual filesystem
 * for each candidate, execute in isolation, pick the best, merge.
 */

import { VirtualFS } from './virtual-fs.js'
import { CopyOnWriteVFS } from './cow-vfs.js'
import type { SampleResult } from './vfs-types.js'

/**
 * Run N parallel sampling functions, each on its own CoW fork.
 *
 * Each function receives a forked CopyOnWriteVFS and an index. Results are
 * collected with timing and error information. Failed samples (those that
 * threw) are captured with error details rather than crashing the whole run.
 *
 * @param vfs - The source VirtualFS to fork from
 * @param count - Number of parallel samples to run (1-10)
 * @param fn - Async function to execute on each fork
 * @returns Array of SampleResult, one per fork (including errored samples)
 */
export async function sample<T>(
  vfs: VirtualFS,
  count: number,
  fn: (fork: CopyOnWriteVFS, index: number) => Promise<T>,
): Promise<SampleResult<T>[]> {
  if (count < 1 || count > 10) {
    throw new Error(`Sample count must be between 1 and 10, got ${count}`)
  }

  const forks: CopyOnWriteVFS[] = []
  for (let i = 0; i < count; i++) {
    forks.push(new CopyOnWriteVFS(vfs, `sample-${i}`))
  }

  const promises = forks.map(async (fork, index) => {
    const start = performance.now()
    try {
      const result = await fn(fork, index)
      const durationMs = performance.now() - start
      return {
        forkIndex: index,
        result,
        index,
        durationMs,
      } satisfies SampleResult<T>
    } catch (err: unknown) {
      const durationMs = performance.now() - start
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        forkIndex: index,
        result: undefined as unknown as T,
        index,
        durationMs,
        error: errorMessage,
      } satisfies SampleResult<T>
    }
  })

  return Promise.all(promises)
}

/**
 * Select the best sample using a scoring function.
 *
 * Filters out errored samples, then picks the one with the highest score.
 * Returns null if all samples errored.
 *
 * @param results - Array of SampleResult from a `sample()` call
 * @param scorer - Function that scores a result (higher is better)
 * @returns The best SampleResult, or null if all errored
 */
export function selectBest<T>(
  results: SampleResult<T>[],
  scorer: (result: T) => number,
): SampleResult<T> | null {
  const successful = results.filter(r => r.error === undefined)
  if (successful.length === 0) return null

  let best = successful[0]!
  let bestScore = scorer(best.result)

  for (let i = 1; i < successful.length; i++) {
    const candidate = successful[i]!
    const candidateScore = scorer(candidate.result)
    if (candidateScore > bestScore) {
      best = candidate
      bestScore = candidateScore
    }
  }

  return best
}

/**
 * Commit the best sample's fork changes back to the source VFS.
 *
 * Uses 'theirs' merge strategy (fork content wins), since the fork
 * was selected as the winner.
 *
 * @param vfs - The original VirtualFS that was forked
 * @param results - All sample results (needed to access forks)
 * @param winner - The winning SampleResult from selectBest()
 * @param forks - The fork instances (in index order) from the sample run
 */
export function commitBest<T>(
  winner: SampleResult<T>,
  forks: CopyOnWriteVFS[],
): void {
  const fork = forks[winner.forkIndex]
  if (!fork) {
    throw new Error(`No fork found at index ${winner.forkIndex}`)
  }
  fork.merge('theirs')
}

/**
 * High-level parallel sampler: fork, run, score, merge the best.
 *
 * Combines `sample()`, `selectBest()`, and `commitBest()` into a single call.
 *
 * @param vfs - Source VirtualFS
 * @param count - Number of parallel attempts
 * @param fn - Function to execute on each fork
 * @param scorer - Scoring function (higher is better)
 * @returns The winning result, or null if all attempts failed
 */
export async function sampleAndCommitBest<T>(
  vfs: VirtualFS,
  count: number,
  fn: (fork: CopyOnWriteVFS, index: number) => Promise<T>,
  scorer: (result: T) => number,
): Promise<{ winner: SampleResult<T>; allResults: SampleResult<T>[] } | null> {
  // Create forks manually so we can pass them to commitBest
  if (count < 1 || count > 10) {
    throw new Error(`Sample count must be between 1 and 10, got ${count}`)
  }

  const forks: CopyOnWriteVFS[] = []
  for (let i = 0; i < count; i++) {
    forks.push(new CopyOnWriteVFS(vfs, `sample-${i}`))
  }

  const promises = forks.map(async (fork, index) => {
    const start = performance.now()
    try {
      const result = await fn(fork, index)
      const durationMs = performance.now() - start
      return {
        forkIndex: index,
        result,
        index,
        durationMs,
      } satisfies SampleResult<T>
    } catch (err: unknown) {
      const durationMs = performance.now() - start
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        forkIndex: index,
        result: undefined as unknown as T,
        index,
        durationMs,
        error: errorMessage,
      } satisfies SampleResult<T>
    }
  })

  const allResults = await Promise.all(promises)
  const winner = selectBest(allResults, scorer)
  if (!winner) return null

  commitBest(winner, forks)
  return { winner, allResults }
}
