/**
 * @dzipagent/domain-nl2sql — SQL Structure Validation Tool
 *
 * Pure regex-based validation that checks SQL references correct tables
 * from the available schema. No LLM call — deterministic.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'

// ---------------------------------------------------------------------------
// SQL keywords to filter out of table references
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = new Set([
  'select',
  'where',
  'on',
  'and',
  'or',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'full',
  'natural',
  'lateral',
  'case',
  'when',
  'then',
  'else',
  'end',
  'as',
  'in',
  'not',
  'is',
  'null',
  'true',
  'false',
  'between',
  'like',
  'ilike',
  'exists',
  'having',
  'group',
  'order',
  'by',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'all',
  'distinct',
  'asc',
  'desc',
  'nulls',
  'first',
  'last',
  'values',
  'set',
  'into',
  'table',
  'with',
  'recursive',
  'over',
  'partition',
  'row',
  'rows',
  'range',
  'unbounded',
  'preceding',
  'following',
  'current',
  'filter',
  'window',
  'fetch',
  'next',
  'only',
])

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createValidateStructureTool(
  _config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'validate-sql-structure',
    description:
      'Validate SQL references correct tables. No LLM — regex-based table extraction and validation.',
    schema: z.object({
      sql: z.string().describe('The SQL statement to validate'),
      availableTables: z
        .array(z.string())
        .describe(
          'List of table names (optionally schema-qualified) that are available in the database',
        ),
    }),
    func: async ({ sql, availableTables }) => {
      try {
        const issues: string[] = []
        const forbiddenTables: string[] = []
        const trimmed = sql.trim()

        // 1. Must start with SELECT or WITH (case-insensitive)
        if (!/^\s*(?:SELECT|WITH)\b/i.test(trimmed)) {
          issues.push(
            'SQL must start with SELECT or WITH (only read queries allowed)',
          )
        }

        // 2. Extract CTE aliases from WITH clauses
        const cteAliases = new Set<string>()
        const ctePattern = /\bWITH\s+(?:RECURSIVE\s+)?(\w+)\s+AS\s*\(/gi
        let cteMatch: RegExpExecArray | null
        while ((cteMatch = ctePattern.exec(sql)) !== null) {
          const captured = cteMatch[1]
          if (captured) cteAliases.add(captured.toLowerCase())
        }
        // Additional CTEs after commas: , alias AS (
        const additionalCtePattern = /,\s*(\w+)\s+AS\s*\(/gi
        let addCteMatch: RegExpExecArray | null
        while ((addCteMatch = additionalCtePattern.exec(sql)) !== null) {
          const captured = addCteMatch[1]
          if (captured) cteAliases.add(captured.toLowerCase())
        }

        // 3. Extract subquery aliases: ) AS alias
        const subqueryAliases = new Set<string>()
        const subqueryPattern = /\)\s+AS\s+(\w+)/gi
        let sqMatch: RegExpExecArray | null
        while ((sqMatch = subqueryPattern.exec(sql)) !== null) {
          const captured = sqMatch[1]
          if (captured) subqueryAliases.add(captured.toLowerCase())
        }

        // 4. Extract table references from FROM/JOIN clauses
        const tableRefPattern = /\b(?:FROM|JOIN)\s+(\w+(?:\.\w+)?)/gi
        let tableMatch: RegExpExecArray | null
        const referencedTables = new Set<string>()

        while ((tableMatch = tableRefPattern.exec(sql)) !== null) {
          const captured = tableMatch[1]
          if (!captured) continue
          const ref = captured.toLowerCase()
          // Skip SQL keywords that might appear after FROM/JOIN
          if (!SQL_KEYWORDS.has(ref)) {
            referencedTables.add(ref)
          }
        }

        // 5. Build normalised lookup of available tables
        const availableSet = new Set(
          availableTables.map((t: string) => t.toLowerCase()),
        )

        // Also build a set of just table names without schema prefix
        const availableUnqualified = new Set<string>()
        for (const t of availableTables) {
          const parts = t.split('.')
          const lastPart = parts[parts.length - 1]
          if (lastPart) availableUnqualified.add(lastPart.toLowerCase())
        }

        // 6. Check each reference
        for (const ref of referencedTables) {
          // Skip if it is a CTE alias or subquery alias
          if (cteAliases.has(ref) || subqueryAliases.has(ref)) {
            continue
          }

          // Check full match (schema.table or just table)
          if (availableSet.has(ref)) {
            continue
          }

          // Check unqualified match (the ref might be unqualified while available is qualified)
          const refParts = ref.split('.')
          const refTable = refParts[refParts.length - 1] ?? ref
          if (availableUnqualified.has(refTable)) {
            continue
          }

          // Not found
          forbiddenTables.push(ref)
          issues.push(`Table "${ref}" is not in the available schema`)
        }

        const result = {
          isValid: issues.length === 0,
          issues,
          forbiddenTables,
        }
        return JSON.stringify(result)
      } catch (error) {
        return JSON.stringify({
          isValid: false,
          issues: [
            `Structure validation error: ${error instanceof Error ? error.message : String(error)}`,
          ],
          forbiddenTables: [],
        })
      }
    },
  })
}
