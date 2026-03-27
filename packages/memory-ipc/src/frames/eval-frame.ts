/**
 * Arrow schema and builder for evaluation result frames.
 *
 * Captures LLM evaluation metrics including scores per dimension,
 * latency, token usage, and cost for benchmarking and comparison.
 */

import {
  Schema,
  Field,
  Utf8,
  Float64,
  Int32,
  Int64,
  Dictionary,
  type Table,
  tableFromArrays,
} from 'apache-arrow'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Arrow schema for eval result frames. */
export const EVAL_FRAME_SCHEMA = new Schema([
  new Field('eval_id', new Utf8(), false),
  new Field('test_case', new Utf8(), false),
  new Field('expected', new Utf8(), true),
  new Field('actual', new Utf8(), true),
  new Field('score', new Float64(), false),
  new Field('dimension', new Dictionary(new Utf8(), new Int32()), false),
  new Field('model', new Dictionary(new Utf8(), new Int32()), false),
  new Field('latency_ms', new Float64(), false),
  new Field('input_tokens', new Int32(), false),
  new Field('output_tokens', new Int32(), false),
  new Field('cost_usd', new Float64(), false),
  new Field('timestamp', new Int64(), false),
  new Field('metadata_json', new Utf8(), true),
])

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/** A single evaluation result entry. */
export interface EvalResultEntry {
  evalId: string
  testCase: string
  expected?: string
  actual?: string
  score: number
  dimension: string
  model: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds Arrow tables from evaluation results.
 *
 * Each eval result entry becomes one row, enabling columnar aggregation
 * by dimension, model, or test case.
 */
export class EvalFrameBuilder {
  /**
   * Build a Table from an array of eval results.
   */
  static fromEvalResults(
    results: ReadonlyArray<EvalResultEntry>,
  ): Table {
    const now = BigInt(Date.now())

    const eval_id: string[] = []
    const test_case: string[] = []
    const expected: (string | null)[] = []
    const actual: (string | null)[] = []
    const score: number[] = []
    const dimension: string[] = []
    const model: string[] = []
    const latency_ms: number[] = []
    const input_tokens: number[] = []
    const output_tokens: number[] = []
    const cost_usd: number[] = []
    const timestamp: bigint[] = []
    const metadata_json: (string | null)[] = []

    for (const r of results) {
      eval_id.push(r.evalId)
      test_case.push(r.testCase)
      expected.push(r.expected ?? null)
      actual.push(r.actual ?? null)
      score.push(r.score)
      dimension.push(r.dimension)
      model.push(r.model)
      latency_ms.push(r.latencyMs)
      input_tokens.push(r.inputTokens)
      output_tokens.push(r.outputTokens)
      cost_usd.push(r.costUsd)
      timestamp.push(now)
      metadata_json.push(r.metadata ? JSON.stringify(r.metadata) : null)
    }

    return tableFromArrays({
      eval_id,
      test_case,
      expected,
      actual,
      score,
      dimension,
      model,
      latency_ms,
      input_tokens,
      output_tokens,
      cost_usd,
      timestamp,
      metadata_json,
    })
  }
}
