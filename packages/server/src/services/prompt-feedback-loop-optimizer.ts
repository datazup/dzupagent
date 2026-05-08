/**
 * PromptFeedbackLoop optimizer adapters — small utilities for delegating to
 * the host-supplied `PromptOptimizer` and constructing eval datasets.
 */

import type { EvalDatasetLike } from '@dzupagent/eval-contracts'

/**
 * Default `EvalDatasetLike` implementation used when the host does not supply
 * `datasetFactory`. Implements the minimal surface the loop needs (entries +
 * metadata). Hosts that want the canonical `EvalDataset` from
 * `@dzupagent/evals` should pass it via config.
 */
export function defaultDatasetFactory(
  entries: ReadonlyArray<{ id: string; input: string; expectedOutput?: string }>,
  meta: { name: string },
): EvalDatasetLike {
  const frozen = entries.map((e) => {
    const entry: { id: string; input: string; expectedOutput?: string } = {
      id: e.id,
      input: e.input,
    }
    if (e.expectedOutput !== undefined) entry.expectedOutput = e.expectedOutput
    return entry
  })
  return {
    metadata: {
      name: meta.name,
      totalEntries: frozen.length,
      tags: [],
    },
    entries(): ReadonlyArray<{ id: string; input: string; expectedOutput?: string | undefined }> {
      return frozen
    },
    size(): number {
      return frozen.length
    },
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function defaultOnError(runId: string, message: string): void {
  const prefix = runId ? `[PromptFeedbackLoop] run=${runId}` : '[PromptFeedbackLoop]'
  process.stderr.write(`${prefix} ${message}\n`)
}
