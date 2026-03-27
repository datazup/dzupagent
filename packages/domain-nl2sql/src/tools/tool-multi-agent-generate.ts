/**
 * Multi-Agent Generate Tool — generates multiple SQL candidates at different
 * temperatures and selects the best one via consensus scoring.
 */

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { NL2SQLToolkitConfig } from '../types/index.js'

const CandidateOutputSchema = z.object({
  sql: z.string(),
  explanation: z.string(),
  tablesUsed: z.array(z.string()),
})

type CandidateOutput = z.infer<typeof CandidateOutputSchema>

interface ScoredCandidate {
  sql: string
  explanation: string
  tablesUsed: string[]
  strategy: string
  score: number
  breakdown: {
    schemaCompliance: number
    syntacticCorrectness: number
    exampleSimilarity: number
    consensusBonus: number
  }
}

const SYSTEM_PROMPT = `You are an expert SQL generator. Given a natural language question, database schema, and SQL dialect, generate a correct SQL query.

Rules:
- Generate ONLY valid, read-only SQL (SELECT/WITH statements).
- Use the exact table and column names from the provided schema.
- Respect the specified SQL dialect syntax.
- Include an explanation of what the query does.
- List all tables referenced in the query.

Output a single SQL query that correctly answers the question.`

/**
 * Normalize SQL for comparison: lowercase, collapse whitespace, strip trailing semicolons.
 */
function normalizeSQL(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
}

/**
 * Extract table names from a SQL string (best-effort heuristic).
 */
function extractTablesFromSQL(sql: string): Set<string> {
  const tables = new Set<string>()
  const normalized = sql.replace(/\s+/g, ' ')

  // Match FROM and JOIN clauses
  const patterns = [
    /\bFROM\s+(\w+(?:\.\w+)?)/gi,
    /\bJOIN\s+(\w+(?:\.\w+)?)/gi,
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(normalized)) !== null) {
      const tableName = match[1]
      if (tableName) {
        tables.add(tableName.toLowerCase())
      }
    }
  }

  return tables
}

/**
 * Score a SQL candidate on multiple dimensions.
 */
function scoreCandidate(
  candidate: CandidateOutput,
  schemaText: string,
  examples: string | undefined,
  allCandidates: CandidateOutput[],
): ScoredCandidate['breakdown'] {
  // --- Schema compliance (30 points) ---
  // Check if tables used exist in the schema
  const schemaLower = schemaText.toLowerCase()
  const extractedTables = extractTablesFromSQL(candidate.sql)
  const declaredTables = candidate.tablesUsed.map((t) => t.toLowerCase())

  let tablesInSchema = 0
  const allTables = new Set([...extractedTables, ...declaredTables])
  for (const table of allTables) {
    // Check both raw name and dotted name in schema text
    const baseName = table.includes('.') ? table.split('.').pop()! : table
    if (schemaLower.includes(baseName)) {
      tablesInSchema++
    }
  }
  const totalTables = Math.max(allTables.size, 1)
  const schemaCompliance = Math.round((tablesInSchema / totalTables) * 30)

  // --- Syntactic correctness (20 points) ---
  // Basic heuristic checks
  let syntacticCorrectness = 20
  const sqlUpper = candidate.sql.toUpperCase().trim()

  if (!sqlUpper.startsWith('SELECT') && !sqlUpper.startsWith('WITH')) {
    syntacticCorrectness = 0
  } else {
    // Check for balanced parentheses
    const opens = (candidate.sql.match(/\(/g) ?? []).length
    const closes = (candidate.sql.match(/\)/g) ?? []).length
    if (opens !== closes) {
      syntacticCorrectness -= 10
    }
    // Check for unclosed quotes
    const singleQuotes = (candidate.sql.match(/'/g) ?? []).length
    if (singleQuotes % 2 !== 0) {
      syntacticCorrectness -= 10
    }
  }
  syntacticCorrectness = Math.max(syntacticCorrectness, 0)

  // --- Example similarity (20 points) ---
  let exampleSimilarity = 10 // default when no examples
  if (examples && examples.trim().length > 0) {
    const examplesLower = examples.toLowerCase()
    const candidateNorm = normalizeSQL(candidate.sql)

    // Check structural similarity with examples
    let matchingPatterns = 0
    const patterns = ['group by', 'order by', 'join', 'where', 'having', 'limit', 'with']
    for (const pattern of patterns) {
      const inExample = examplesLower.includes(pattern)
      const inCandidate = candidateNorm.includes(pattern)
      if (inExample && inCandidate) matchingPatterns++
    }
    exampleSimilarity = Math.min(Math.round((matchingPatterns / Math.max(patterns.length, 1)) * 20), 20)
  }

  // --- Consensus bonus (30 points) ---
  // Candidates that agree with others get bonus points
  const candidateNorm = normalizeSQL(candidate.sql)
  let agreementCount = 0
  for (const other of allCandidates) {
    if (other === candidate) continue
    const otherNorm = normalizeSQL(other.sql)

    // Check structural similarity (same tables, same clauses)
    const candidateTables = extractTablesFromSQL(candidate.sql)
    const otherTables = extractTablesFromSQL(other.sql)

    // Table overlap
    let overlap = 0
    for (const t of candidateTables) {
      if (otherTables.has(t)) overlap++
    }
    const maxTables = Math.max(candidateTables.size, otherTables.size, 1)
    const tableOverlap = overlap / maxTables

    // Structural similarity via normalized comparison
    const structuralSimilarity = candidateNorm === otherNorm ? 1.0 : tableOverlap * 0.7

    if (structuralSimilarity >= 0.5) {
      agreementCount++
    }
  }
  const otherCount = Math.max(allCandidates.length - 1, 1)
  const consensusBonus = Math.round((agreementCount / otherCount) * 30)

  return { schemaCompliance, syntacticCorrectness, exampleSimilarity, consensusBonus }
}

/**
 * Creates a tool that generates multiple SQL candidates at different
 * temperatures and selects the best one via scoring.
 */
export function createMultiAgentGenerateTool(
  config: NL2SQLToolkitConfig,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'multi-agent-generate-sql',
    description:
      'Generate multiple SQL candidates at different temperatures and select the best one via scoring.',
    schema: z.object({
      query: z.string().describe('The natural language question'),
      schema: z.string().describe('Database schema context (DDL)'),
      examples: z.string().optional().describe('Similar SQL examples for reference'),
      dialect: z.string().describe('SQL dialect (e.g., postgresql, mysql, bigquery)'),
    }),
    func: async (input) => {
      try {
        // Generate 3 candidates concurrently using prompt-based variation
        // strategies. Each candidate uses a different generation persona to
        // produce diverse SQL approaches, since BaseChatModel does not
        // expose per-call temperature binding in the type system.
        const strategies: Array<{ label: string; instruction: string }> = [
          {
            label: 'precise',
            instruction:
              'Generate the most precise, conservative SQL query. Prefer exact matches, avoid unnecessary complexity, and use the simplest approach that correctly answers the question.',
          },
          {
            label: 'balanced',
            instruction:
              'Generate a well-balanced SQL query. Use standard patterns and include reasonable edge-case handling such as NULL checks or COALESCE where appropriate.',
          },
          {
            label: 'creative',
            instruction:
              'Generate an alternative SQL query. Consider using different JOIN orders, subquery vs CTE approaches, or alternative aggregation strategies. Still must be correct.',
          },
        ]

        const structuredModel = config.chatModel.withStructuredOutput(CandidateOutputSchema)

        const examplesBlock = input.examples
          ? `\nSimilar examples:\n${input.examples}`
          : ''

        const candidatePromises = strategies.map(async (strategy) => {
          const result: CandidateOutput = await structuredModel.invoke([
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `${strategy.instruction}\n\nSQL Dialect: ${input.dialect}\n\nDatabase schema:\n${input.schema}${examplesBlock}\n\nQuestion: ${input.query}`,
            },
          ])

          return { ...result, strategy: strategy.label }
        })

        const candidates = await Promise.all(candidatePromises)

        // Score each candidate
        const scored: ScoredCandidate[] = candidates.map((candidate) => {
          const breakdown = scoreCandidate(
            candidate,
            input.schema,
            input.examples,
            candidates,
          )
          const score =
            breakdown.schemaCompliance +
            breakdown.syntacticCorrectness +
            breakdown.exampleSimilarity +
            breakdown.consensusBonus

          return { ...candidate, score, breakdown }
        })

        // Sort by score descending, pick the best
        scored.sort((a, b) => b.score - a.score)
        const best = scored[0]!

        return JSON.stringify({
          sql: best.sql,
          explanation: best.explanation,
          tablesUsed: best.tablesUsed,
          candidates: scored.map((c) => ({
            sql: c.sql,
            score: c.score,
            strategy: c.strategy,
            breakdown: c.breakdown,
          })),
        })
      } catch (err: unknown) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          sql: '',
          explanation: '',
          tablesUsed: [],
          candidates: [],
        })
      }
    },
  })
}
