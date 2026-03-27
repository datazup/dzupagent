/**
 * Result Validator Tool — checks query results for plausibility issues
 * and anomalies. Pure logic, no LLM calls. Non-blocking warnings only.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'
import type { ResultWarning } from '../types/index.js'

/** Column names that should never contain negative values. */
const NON_NEGATIVE_COLUMNS = new Set([
  'revenue',
  'price',
  'cost',
  'amount',
  'count',
  'quantity',
  'total',
  'salary',
  'balance',
])

/** Threshold for row count warning. */
const HIGH_ROW_COUNT = 10_000

/** Threshold for NULL ratio warning (50%). */
const NULL_RATIO_THRESHOLD = 0.5

interface ParsedResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
}

/**
 * Attempt to parse the JSON result string into a structured form.
 * Handles both `{ columns, rows, rowCount }` and array-of-objects formats.
 */
function parseResult(resultJson: string): ParsedResult {
  const parsed: unknown = JSON.parse(resultJson)

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>

    // Standard QueryResultData format: { columns, rows, rowCount }
    if (Array.isArray(obj['columns']) && Array.isArray(obj['rows'])) {
      const columns = (obj['columns'] as string[]).map(String)
      const rows = obj['rows'] as unknown[][]
      const rowCount =
        typeof obj['rowCount'] === 'number' ? obj['rowCount'] : rows.length
      return { columns, rows, rowCount }
    }
  }

  // Array-of-objects format
  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0] as Record<string, unknown>
    const columns = Object.keys(first)
    const rows = (parsed as Record<string, unknown>[]).map((row) =>
      columns.map((col) => row[col]),
    )
    return { columns, rows, rowCount: rows.length }
  }

  return { columns: [], rows: [], rowCount: 0 }
}

/**
 * Check if a column name matches any non-negative column pattern.
 */
function isNonNegativeColumn(columnName: string): boolean {
  const lower = columnName.toLowerCase()
  for (const keyword of NON_NEGATIVE_COLUMNS) {
    if (lower.includes(keyword)) return true
  }
  return false
}

/**
 * Run all plausibility checks and collect warnings.
 */
function validateResult(
  _query: string,
  _sql: string,
  resultJson: string,
): ResultWarning[] {
  const warnings: ResultWarning[] = []

  let data: ParsedResult
  try {
    data = parseResult(resultJson)
  } catch {
    warnings.push({
      message: 'Could not parse query result JSON for validation.',
      severity: 'info',
    })
    return warnings
  }

  // --- Empty result detection ---
  if (data.rowCount === 0 || data.rows.length === 0) {
    warnings.push({
      message:
        'Query returned no results. The filters may be too restrictive, or the data may not exist.',
      severity: 'warning',
    })
    return warnings // No further checks meaningful on empty data
  }

  // --- Row count plausibility ---
  if (data.rowCount > HIGH_ROW_COUNT) {
    warnings.push({
      message: `Query returned ${data.rowCount.toLocaleString()} rows, which is unusually large. Consider adding filters or aggregation.`,
      severity: 'warning',
    })
  }

  // --- Per-column checks ---
  for (let colIdx = 0; colIdx < data.columns.length; colIdx++) {
    const colName = data.columns[colIdx]!
    const values = data.rows.map((row) => row[colIdx])

    // NULL ratio check
    const nullCount = values.filter(
      (v) => v === null || v === undefined || v === '',
    ).length
    const nullRatio = nullCount / Math.max(values.length, 1)
    if (nullRatio > NULL_RATIO_THRESHOLD) {
      warnings.push({
        message: `Column "${colName}" has ${Math.round(nullRatio * 100)}% NULL/empty values, which may indicate a data quality issue.`,
        severity: 'info',
      })
    }

    // Negative values in non-negative columns
    if (isNonNegativeColumn(colName)) {
      const hasNegative = values.some((v) => {
        if (typeof v === 'number') return v < 0
        if (typeof v === 'string') {
          const num = Number(v)
          return !Number.isNaN(num) && num < 0
        }
        return false
      })
      if (hasNegative) {
        warnings.push({
          message: `Column "${colName}" contains negative values, which is unexpected for this type of metric.`,
          severity: 'caution',
        })
      }
    }
  }

  // --- Duplicate row detection ---
  if (data.rows.length > 1) {
    const serialized = new Set<string>()
    let duplicateCount = 0
    for (const row of data.rows) {
      const key = JSON.stringify(row)
      if (serialized.has(key)) {
        duplicateCount++
      } else {
        serialized.add(key)
      }
    }
    if (duplicateCount > 0) {
      const pct = Math.round((duplicateCount / data.rows.length) * 100)
      warnings.push({
        message: `Found ${duplicateCount} duplicate row${duplicateCount > 1 ? 's' : ''} (${pct}% of results). Consider adding DISTINCT or reviewing JOINs.`,
        severity: pct > 20 ? 'warning' : 'info',
      })
    }
  }

  return warnings
}

/**
 * Creates a tool that validates query results for plausibility issues.
 * Uses pure logic — no LLM calls.
 */
export function createResultValidatorTool(
  _config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'validate-result',
    description:
      'Check query results for plausibility issues and anomalies. Non-blocking warnings only.',
    schema: z.object({
      query: z.string().describe('The original natural language question'),
      sql: z.string().describe('The SQL query that was executed'),
      result: z.string().describe('JSON string of QueryResultData'),
    }),
    func: async (input) => {
      try {
        const warnings = validateResult(input.query, input.sql, input.result)
        return JSON.stringify({ warnings })
      } catch (err: unknown) {
        return JSON.stringify({
          warnings: [
            {
              message: `Validation error: ${err instanceof Error ? err.message : String(err)}`,
              severity: 'info' as const,
            },
          ],
        })
      }
    },
  })
}
