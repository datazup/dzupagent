/**
 * @dzipagent/domain-nl2sql — SQL Safety Validation Tool
 *
 * Pure regex-based validation that checks SQL for destructive operations,
 * multi-statement injection, and forbidden table references.
 * No LLM call — deterministic and fast.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace single-quoted and double-quoted string literals with empty strings. */
function stripStringLiterals(sql: string): string {
  // Match 'escaped\'quotes' and "escaped\"quotes"
  return sql.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/** Remove block comments and line comments. */
function stripComments(sql: string): string {
  // Block comments: /* ... */ (non-greedy, handles nested loosely)
  let cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, ' ')
  // Line comments: -- to end of line
  cleaned = cleaned.replace(/--[^\n\r]*/g, ' ')
  return cleaned
}

/** Preprocess SQL: strip comments and string literals so regex hits real code. */
function preprocessSQL(sql: string): string {
  return stripComments(stripStringLiterals(sql))
}

// ---------------------------------------------------------------------------
// Destructive keyword patterns (word-boundary)
// ---------------------------------------------------------------------------

const DESTRUCTIVE_KEYWORDS = [
  'DROP',
  'ALTER',
  'CREATE',
  'RENAME',
  'DELETE',
  'TRUNCATE',
  'UPDATE',
  'INSERT',
  'REPLACE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'EXEC',
  'EXECUTE',
  'CALL',
  'COPY',
  'LOAD\\s+DATA',
  'SET',
] as const

const DESTRUCTIVE_PATTERN = new RegExp(
  `\\b(?:${DESTRUCTIVE_KEYWORDS.join('|')})\\b`,
  'gi',
)

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createValidateSafetyTool(
  _config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'validate-sql-safety',
    description:
      'Check SQL for destructive operations (DROP, DELETE, INSERT, etc). No LLM call — pure regex validation.',
    schema: z.object({
      sql: z.string().describe('The SQL statement to validate'),
      forbiddenTables: z
        .array(z.string())
        .optional()
        .describe('Optional list of table names that must not be referenced'),
    }),
    func: async ({ sql, forbiddenTables }) => {
      try {
        const violations: string[] = []
        const cleaned = preprocessSQL(sql)

        // 1. Multi-statement injection: semicolons followed by non-whitespace
        //    Allow trailing semicolons but flag chained statements.
        const semiParts = cleaned
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        if (semiParts.length > 1) {
          violations.push(
            'Multi-statement SQL detected — possible injection risk',
          )
        }

        // 2. Destructive keyword scan
        const matches = cleaned.match(DESTRUCTIVE_PATTERN)
        if (matches) {
          const unique = [...new Set(matches.map((m) => m.toUpperCase()))]
          for (const keyword of unique) {
            violations.push(`Destructive keyword detected: ${keyword}`)
          }
        }

        // 3. Forbidden table references
        if (forbiddenTables && forbiddenTables.length > 0) {
          const tablePattern =
            /\b(?:FROM|JOIN)\s+(\w+(?:\.\w+)?)/gi
          let tableMatch: RegExpExecArray | null
          const referencedTables = new Set<string>()

          while ((tableMatch = tablePattern.exec(cleaned)) !== null) {
            const captured = tableMatch[1]
            if (captured) referencedTables.add(captured.toLowerCase())
          }

          for (const forbidden of forbiddenTables) {
            const normalised = forbidden.toLowerCase()
            if (referencedTables.has(normalised)) {
              violations.push(`Forbidden table referenced: ${forbidden}`)
            }
            // Also check schema-qualified variant
            for (const ref of referencedTables) {
              if (ref.endsWith(`.${normalised}`)) {
                violations.push(
                  `Forbidden table referenced (schema-qualified): ${ref}`,
                )
              }
            }
          }
        }

        const result = {
          isSafe: violations.length === 0,
          violations,
        }
        return JSON.stringify(result)
      } catch (error) {
        return JSON.stringify({
          isSafe: false,
          violations: [
            `Safety validation error: ${error instanceof Error ? error.message : String(error)}`,
          ],
        })
      }
    },
  })
}
