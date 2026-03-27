/**
 * Arrow schema and builder for tool result frames.
 *
 * Captures structured tool outputs with relevance scores and token costs,
 * enabling columnar analytics over tool call results across agent runs.
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

/** Arrow schema for tool result frames. */
export const TOOL_RESULT_SCHEMA = new Schema([
  new Field('tool_name', new Dictionary(new Utf8(), new Int32()), false),
  new Field('result_index', new Int32(), false),
  new Field('result_key', new Utf8(), true),
  new Field('result_value', new Utf8(), false),
  new Field('relevance_score', new Float64(), true),
  new Field('token_cost', new Int32(), false),
  new Field('metadata_json', new Utf8(), true),
  new Field('timestamp', new Int64(), false),
])

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/** A single tool result entry. */
export interface ToolResultEntry {
  key?: string
  value: string
  score?: number
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const DEFAULT_CHARS_PER_TOKEN = 4

/**
 * Builds Arrow tables from tool invocation results.
 *
 * Each result entry becomes one row. Token cost is estimated from
 * `value.length / charsPerToken` (default 4).
 */
export class ToolResultFrameBuilder {
  /**
   * Build a Table from a single tool's output results.
   *
   * @param toolName       Name of the tool that produced the results.
   * @param results        Array of result entries.
   * @param charsPerToken  Characters-per-token ratio for cost estimation (default 4).
   */
  static fromToolOutput(
    toolName: string,
    results: ReadonlyArray<ToolResultEntry>,
    charsPerToken?: number,
  ): Table {
    const cpt = charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
    const now = BigInt(Date.now())

    const tool_name: string[] = []
    const result_index: number[] = []
    const result_key: (string | null)[] = []
    const result_value: string[] = []
    const relevance_score: (number | null)[] = []
    const token_cost: number[] = []
    const metadata_json: (string | null)[] = []
    const timestamp: bigint[] = []

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!
      tool_name.push(toolName)
      result_index.push(i)
      result_key.push(r.key ?? null)
      result_value.push(r.value)
      relevance_score.push(r.score ?? null)
      token_cost.push(Math.ceil(r.value.length / cpt))
      metadata_json.push(r.metadata ? JSON.stringify(r.metadata) : null)
      timestamp.push(now)
    }

    return tableFromArrays({
      tool_name,
      result_index,
      result_key,
      result_value,
      relevance_score,
      token_cost,
      metadata_json,
      timestamp,
    })
  }
}
