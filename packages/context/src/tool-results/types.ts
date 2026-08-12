import type { BaseMessage } from '@langchain/core/messages'

import type { TokenMeasurementMethod } from '../token-lifecycle.js'

/** Strict opt-in profile for completed tool-call/result compaction. */
export interface CompletedToolCompactionProfileV1 {
  schema: 'datazup.context.completed-tool-compaction-profile/v1'
  /** Number of most-recent completed call/result pairs retained verbatim. */
  preserveRecentCompletedPairs: number
  /** Results below this measured content size are not worth compacting. */
  minimumResultTokens: number
  /** Upper bound on result messages replaced in one invocation. */
  maxCompactedResults: number
  /** Stop after this many measured tokens have actually been reclaimed. */
  targetReclaimedTokens?: number
  /** Whether tokenizer provenance is mandatory for an adoptable result. */
  measurement: 'allow-heuristic' | 'require-tokenizer'
}

export type CompletedToolCompactionReasonV1 =
  | 'compacted'
  | 'target-not-met'
  | 'no-eligible-results'
  | 'no-token-reclamation'
  | 'invalid-input'
  | 'invalid-profile'
  | 'invalid-tool-pairing'
  | 'clone-rejected'
  | 'token-measurement-unproven'

/** Truthful, content-free outcome from completed tool-result compaction. */
export interface CompletedToolCompactionResultV1 {
  schema: 'datazup.context.completed-tool-compaction-result/v1'
  status: 'completed' | 'partial' | 'unchanged' | 'rejected'
  reason: CompletedToolCompactionReasonV1
  messages: BaseMessage[]
  beforeTokens: number
  afterTokens: number
  reclaimedTokens: number
  measurementMethod: TokenMeasurementMethod
  model?: string
  compactedToolCallIds: string[]
}
