/**
 * @dzipagent/domain-nl2sql — SQL Execution Tool
 *
 * Executes a validated SQL query against the target database with RLS filter
 * injection. Sanitizes error messages and classifies failure types.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig, RLSPolicy } from '../types/index.js'

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

type SQLErrorType =
  | 'table_not_found'
  | 'column_not_found'
  | 'syntax'
  | 'timeout'
  | 'permission'
  | 'structural'
  | 'infrastructure'
  | 'unknown'

/**
 * Classify a SQL execution error into a category for the agent to act on.
 */
function classifyError(error: Error): SQLErrorType {
  const msg = error.message.toLowerCase()

  if (
    msg.includes('relation') && msg.includes('does not exist') ||
    msg.includes('table') && msg.includes('not found') ||
    msg.includes("doesn't exist") ||
    msg.includes('unknown table')
  ) {
    return 'table_not_found'
  }

  if (
    msg.includes('column') && msg.includes('does not exist') ||
    msg.includes('unknown column') ||
    msg.includes('no such column')
  ) {
    return 'column_not_found'
  }

  if (
    msg.includes('syntax error') ||
    msg.includes('parse error') ||
    msg.includes('unexpected token')
  ) {
    return 'syntax'
  }

  if (
    msg.includes('timeout') ||
    msg.includes('canceling statement due to statement timeout') ||
    msg.includes('query exceeded')
  ) {
    return 'timeout'
  }

  if (
    msg.includes('permission denied') ||
    msg.includes('access denied') ||
    msg.includes('insufficient privileges')
  ) {
    return 'permission'
  }

  if (
    msg.includes('ambiguous') ||
    msg.includes('group by') ||
    msg.includes('aggregate') ||
    msg.includes('subquery') ||
    msg.includes('must appear in')
  ) {
    return 'structural'
  }

  if (
    msg.includes('connection') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('pool')
  ) {
    return 'infrastructure'
  }

  return 'unknown'
}

// ---------------------------------------------------------------------------
// Sensitive data sanitization
// ---------------------------------------------------------------------------

/**
 * Patterns that may leak credentials or infrastructure details.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Connection strings
  { pattern: /(?:postgres(?:ql)?|mysql|mssql|mongodb):\/\/[^\s'"]+/gi, replacement: '[CONNECTION_STRING_REDACTED]' },
  // Passwords in various formats
  { pattern: /password\s*[=:]\s*['"]?[^\s'"]+/gi, replacement: 'password=[REDACTED]' },
  // IP addresses with ports
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+\b/g, replacement: '[HOST_REDACTED]' },
  // AWS/GCP/Azure credentials
  { pattern: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g, replacement: '[AWS_KEY_REDACTED]' },
  { pattern: /(?:sk-|pk_)[a-zA-Z0-9]{20,}/g, replacement: '[API_KEY_REDACTED]' },
]

/**
 * Remove passwords, connection strings, and other sensitive data from error messages.
 */
function sanitizeErrorMessage(message: string): string {
  let sanitized = message
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement)
  }
  return sanitized
}

// ---------------------------------------------------------------------------
// RLS filter injection
// ---------------------------------------------------------------------------

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Inject RLS WHERE clauses for each policy whose table appears in the SQL.
 *
 * Strategy:
 * - If the query already has a WHERE clause, prepend the RLS filter with AND.
 * - Otherwise, insert a WHERE clause before ORDER BY / GROUP BY / LIMIT / HAVING,
 *   or at the end of the statement.
 */
function injectRLSFilters(sql: string, policies: RLSPolicy[]): string {
  let modified = sql

  for (const policy of policies) {
    const tablePattern = new RegExp(
      `\\b${escapeRegex(policy.tableName)}\\b`,
      'gi',
    )

    if (!tablePattern.test(modified)) {
      continue
    }

    const whereMatch = modified.match(/\bWHERE\b/i)
    if (whereMatch && whereMatch.index !== undefined) {
      // Insert RLS condition right after WHERE
      const whereEnd = whereMatch.index + whereMatch[0].length
      modified =
        modified.slice(0, whereEnd) +
        ` ${policy.filterExpression} AND` +
        modified.slice(whereEnd)
    } else {
      // No WHERE clause — insert before terminal clauses or at statement end
      const terminalMatch = modified.match(
        /\b(ORDER\s+BY|GROUP\s+BY|LIMIT|HAVING)\b/i,
      )

      if (terminalMatch && terminalMatch.index !== undefined) {
        const insertAt = terminalMatch.index
        modified =
          modified.slice(0, insertAt) +
          `WHERE ${policy.filterExpression} ` +
          modified.slice(insertAt)
      } else {
        // Append at the end, removing trailing semicolons
        modified =
          modified.replace(/;?\s*$/, '') +
          ` WHERE ${policy.filterExpression}`
      }
    }
  }

  return modified
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExecuteQueryTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'execute-sql-query',
    description:
      'Execute a validated SQL query against the target database with RLS filter injection.',
    schema: z.object({
      sql: z.string().describe('The SQL query to execute (must be SELECT-only)'),
    }),
    func: async ({ sql }) => {
      try {
        // -----------------------------------------------------------------
        // Step 1: Safety check — reject non-SELECT statements
        // -----------------------------------------------------------------
        const trimmed = sql.trim()
        const firstKeyword = trimmed.split(/\s+/)[0]?.toUpperCase() ?? ''

        if (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH') {
          return JSON.stringify({
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
            error: `Execution blocked: only SELECT/WITH statements are allowed. Got: ${firstKeyword}`,
            errorType: 'syntax' as SQLErrorType,
          })
        }

        // Additional pattern check for dangerous statements embedded in CTEs
        const dangerousPatterns =
          /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i
        if (dangerousPatterns.test(trimmed)) {
          return JSON.stringify({
            columns: [],
            rows: [],
            rowCount: 0,
            truncated: false,
            error: 'Execution blocked: SQL contains disallowed keywords.',
            errorType: 'syntax' as SQLErrorType,
          })
        }

        // -----------------------------------------------------------------
        // Step 2: Inject RLS filters if configured
        // -----------------------------------------------------------------
        let executableSQL = trimmed
        if (config.rlsPolicies && config.rlsPolicies.length > 0) {
          executableSQL = injectRLSFilters(executableSQL, config.rlsPolicies)
        }

        // -----------------------------------------------------------------
        // Step 3: Execute the query
        // -----------------------------------------------------------------
        const timeoutMs = config.queryTimeout ?? 30_000
        const maxRows = config.maxRows ?? 500

        const result = await config.sqlConnector.executeQuery(executableSQL, {
          timeoutMs,
          maxRows,
        })

        return JSON.stringify({
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
        })
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const errorType = classifyError(error)
        const sanitizedMessage = sanitizeErrorMessage(error.message)

        return JSON.stringify({
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          error: sanitizedMessage,
          errorType,
        })
      }
    },
  })
}
