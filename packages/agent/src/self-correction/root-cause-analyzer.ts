/**
 * RootCauseAnalyzer --- LLM-driven error diagnosis for pipeline failures.
 *
 * Combines heuristic pattern matching with an LLM-powered deep analysis
 * that identifies root causes, traces causal chains, and suggests targeted
 * fixes. Always falls back to heuristics when the LLM is unavailable or
 * returns an unparseable response.
 *
 * General-purpose --- works for any agent pipeline, not specific to
 * code generation.
 *
 * @module self-correction/root-cause-analyzer
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full root-cause diagnosis produced by the analyzer. */
export interface RootCauseReport {
  /** The immediate error that triggered analysis. */
  immediateError: string
  /** LLM-identified root cause. */
  rootCause: string
  /** Ordered chain of contributing factors. */
  causalChain: string[]
  /** Pipeline nodes affected. */
  affectedNodes: string[]
  /** Suggested fixes, ordered by likelihood of success. */
  suggestedFixes: string[]
  /** Confidence in the diagnosis (0-1). */
  confidence: number
  /** Whether past similar errors were found. */
  hasPastContext: boolean
}

/** Configuration for the RootCauseAnalyzer. */
export interface RootCauseAnalyzerConfig {
  /** LLM for analysis (required). */
  llm: BaseChatModel
  /** Past error context to include (optional). */
  pastErrors?: Array<{ error: string; resolution?: string }>
  /** Max past errors to include in prompt (default: 3). */
  maxPastErrors?: number
}

/** Parameters for a single analysis invocation. */
export interface AnalyzeParams {
  /** The error message to analyze. */
  error: string
  /** The pipeline node that failed. */
  nodeId: string
  /** The type of the pipeline node (optional). */
  nodeType?: string
  /** Recent execution context (last few node outputs). */
  executionContext?: Array<{ nodeId: string; output?: string; error?: string }>
}

/** Quick heuristic classification result. */
export interface HeuristicClassification {
  category: string
  severity: string
  suggestedAction: string
}

// ---------------------------------------------------------------------------
// Heuristic patterns
// ---------------------------------------------------------------------------

interface HeuristicPattern {
  category: string
  severity: string
  suggestedAction: string
  patterns: RegExp[]
}

const HEURISTIC_PATTERNS: HeuristicPattern[] = [
  {
    category: 'timeout',
    severity: 'high',
    suggestedAction: 'Increase timeout or reduce workload size',
    patterns: [/timeout/i, /timed?\s*out/i, /deadline\s+exceeded/i, /ETIMEDOUT/i],
  },
  {
    category: 'resource_exhaustion',
    severity: 'critical',
    suggestedAction: 'Reduce memory/token usage or increase resource limits',
    patterns: [
      /out\s+of\s+memory/i, /heap.*(?:limit|exceeded)/i, /ENOMEM/i,
      /rate\s*limit/i, /429/, /quota\s+exceeded/i, /token\s+limit/i,
      /budget\s+exceeded/i, /cost\s+limit/i,
    ],
  },
  {
    category: 'dependency_missing',
    severity: 'high',
    suggestedAction: 'Install missing dependency or check import paths',
    patterns: [
      /cannot\s+find\s+module/i, /module\s+not\s+found/i,
      /ENOENT/i, /no\s+such\s+file/i, /missing\s+dependency/i,
    ],
  },
  {
    category: 'type_mismatch',
    severity: 'medium',
    suggestedAction: 'Fix type annotations or validate input shapes',
    patterns: [
      /type\s+error/i, /is\s+not\s+assignable\s+to/i,
      /property.*does\s+not\s+exist/i, /expected\s+type/i,
    ],
  },
  {
    category: 'import_error',
    severity: 'high',
    suggestedAction: 'Fix import path or export declaration',
    patterns: [
      /unexpected\s+token\s+.*import/i, /cannot\s+use\s+import/i,
      /is\s+not\s+exported/i, /does\s+not\s+provide\s+an\s+export/i,
      /ERR_MODULE_NOT_FOUND/i,
    ],
  },
  {
    category: 'auth_error',
    severity: 'critical',
    suggestedAction: 'Check API keys, tokens, and permissions',
    patterns: [
      /unauthorized/i, /forbidden/i, /401/, /403/,
      /invalid\s+(?:api\s+)?key/i, /authentication\s+failed/i,
      /permission\s+denied/i, /access\s+denied/i,
    ],
  },
  {
    category: 'schema_error',
    severity: 'medium',
    suggestedAction: 'Validate schema definitions and data shape',
    patterns: [
      /schema\s+(?:validation|error)/i, /invalid\s+schema/i,
      /required\s+(?:field|property)/i, /validation\s+failed/i,
      /zod.*error/i, /parsing?\s+(?:error|failed)/i,
    ],
  },
  {
    category: 'build_failure',
    severity: 'high',
    suggestedAction: 'Fix compilation errors in source code',
    patterns: [
      /compilation?\s+(?:error|failed)/i, /build\s+failed/i,
      /typescript\s+error/i, /syntax\s+error/i,
    ],
  },
  {
    category: 'test_failure',
    severity: 'medium',
    suggestedAction: 'Fix failing assertions or update test expectations',
    patterns: [
      /test\s+(?:failed|failure)/i, /assertion\s+(?:error|failed)/i,
      /expect.*(?:toBe|toEqual|toMatch)/i, /\d+\s+(?:tests?\s+)?failed/i,
    ],
  },
  {
    category: 'network_error',
    severity: 'high',
    suggestedAction: 'Check network connectivity and service availability',
    patterns: [
      /ECONNREFUSED/i, /ECONNRESET/i, /ENOTFOUND/i,
      /network\s+error/i, /fetch\s+failed/i,
      /502/, /503/, /504/,
    ],
  },
  {
    category: 'generation_failure',
    severity: 'medium',
    suggestedAction: 'Retry with adjusted prompt or model parameters',
    patterns: [
      /generation\s+failed/i, /llm\s+(?:error|failed)/i,
      /model\s+(?:error|unavailable)/i, /invalid\s+(?:response|output)/i,
      /500/,
    ],
  },
]

// ---------------------------------------------------------------------------
// System prompt for LLM analysis
// ---------------------------------------------------------------------------

const ROOT_CAUSE_SYSTEM_PROMPT = `You are an expert error diagnostician for software agent pipelines. Your task is to analyze a pipeline error and produce a structured root cause diagnosis.

Given an error message, the pipeline node context, and optionally past similar errors, you must:

1. Identify the ROOT CAUSE --- not just the symptom. Look past the immediate error to what actually went wrong.
2. Trace the CAUSAL CHAIN --- the sequence of events/conditions that led to the error.
3. List AFFECTED NODES --- which pipeline nodes are impacted.
4. Suggest 1-3 TARGETED FIXES --- concrete actions to resolve the issue, ordered by likelihood of success.
5. Assess CONFIDENCE --- how confident you are in the diagnosis (0.0-1.0).

Respond with ONLY a JSON object in this exact format (no markdown, no explanation, just the JSON):
{
  "rootCause": "string describing the root cause",
  "causalChain": ["step1", "step2", "step3"],
  "affectedNodes": ["nodeId1", "nodeId2"],
  "suggestedFixes": ["fix1", "fix2"],
  "confidence": 0.85
}

Be specific and actionable. Do not be vague. If you are uncertain, lower your confidence score.`

// ---------------------------------------------------------------------------
// RootCauseAnalyzer
// ---------------------------------------------------------------------------

/**
 * Analyzes pipeline errors using a combination of LLM-powered deep
 * analysis and heuristic pattern matching.
 *
 * ```ts
 * const analyzer = new RootCauseAnalyzer({ llm: myModel })
 * const report = await analyzer.analyze({
 *   error: 'Cannot find module "lodash"',
 *   nodeId: 'gen_backend',
 * })
 * console.log(report.rootCause)       // LLM-identified root cause
 * console.log(report.suggestedFixes)  // Ordered fix suggestions
 * ```
 */
export class RootCauseAnalyzer {
  private readonly llm: BaseChatModel
  private readonly pastErrors: Array<{ error: string; resolution?: string }>
  private readonly maxPastErrors: number

  constructor(config: RootCauseAnalyzerConfig) {
    this.llm = config.llm
    this.pastErrors = config.pastErrors ?? []
    this.maxPastErrors = config.maxPastErrors ?? 3
  }

  /**
   * Analyze an error and produce a root cause report.
   * Falls back to heuristic classification if the LLM call fails.
   */
  async analyze(params: AnalyzeParams): Promise<RootCauseReport> {
    try {
      return await this.analyzeWithLlm(params)
    } catch {
      return this.buildFallbackReport(params)
    }
  }

  /**
   * Quick classification without LLM (fallback when LLM unavailable).
   * Uses heuristic pattern matching with extended categories.
   */
  classifyHeuristic(error: string): HeuristicClassification {
    const lower = error.toLowerCase()
    for (const pattern of HEURISTIC_PATTERNS) {
      for (const regex of pattern.patterns) {
        if (regex.test(lower) || regex.test(error)) {
          return {
            category: pattern.category,
            severity: pattern.severity,
            suggestedAction: pattern.suggestedAction,
          }
        }
      }
    }
    return {
      category: 'unknown',
      severity: 'medium',
      suggestedAction: 'Inspect error details and retry with adjusted parameters',
    }
  }

  // ---------------------------------------------------------------------------
  // Private: LLM analysis
  // ---------------------------------------------------------------------------

  private async analyzeWithLlm(params: AnalyzeParams): Promise<RootCauseReport> {
    const prompt = this.buildPrompt(params)
    const hasPastContext = this.pastErrors.length > 0

    const response = await this.llm.invoke([
      new SystemMessage(ROOT_CAUSE_SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ])

    const responseText = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)

    const parsed = this.parseJsonResponse(responseText)

    if (!parsed) {
      // LLM returned something we cannot parse --- fall back
      return this.buildFallbackReport(params)
    }

    return {
      immediateError: params.error,
      rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : params.error,
      causalChain: Array.isArray(parsed.causalChain)
        ? parsed.causalChain.filter((s: unknown): s is string => typeof s === 'string')
        : [],
      affectedNodes: Array.isArray(parsed.affectedNodes)
        ? parsed.affectedNodes.filter((s: unknown): s is string => typeof s === 'string')
        : [params.nodeId],
      suggestedFixes: Array.isArray(parsed.suggestedFixes)
        ? parsed.suggestedFixes.filter((s: unknown): s is string => typeof s === 'string')
        : [],
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      hasPastContext,
    }
  }

  private buildPrompt(params: AnalyzeParams): string {
    const sections: string[] = []

    sections.push(`## Error\n${params.error}`)
    sections.push(`## Failed Node\nID: ${params.nodeId}${params.nodeType ? `\nType: ${params.nodeType}` : ''}`)

    if (params.executionContext && params.executionContext.length > 0) {
      const contextLines = params.executionContext.map((ctx) => {
        const parts = [`- Node "${ctx.nodeId}"`]
        if (ctx.output) parts.push(`  Output: ${ctx.output.slice(0, 200)}`)
        if (ctx.error) parts.push(`  Error: ${ctx.error.slice(0, 200)}`)
        return parts.join('\n')
      })
      sections.push(`## Recent Execution Context\n${contextLines.join('\n')}`)
    }

    const relevantPast = this.pastErrors.slice(0, this.maxPastErrors)
    if (relevantPast.length > 0) {
      const pastLines = relevantPast.map((pe, i) => {
        let line = `${i + 1}. Error: ${pe.error.slice(0, 200)}`
        if (pe.resolution) line += `\n   Resolution: ${pe.resolution.slice(0, 200)}`
        return line
      })
      sections.push(`## Past Similar Errors\n${pastLines.join('\n')}`)
    }

    return sections.join('\n\n')
  }

  // ---------------------------------------------------------------------------
  // Private: JSON parsing
  // ---------------------------------------------------------------------------

  private parseJsonResponse(text: string): Record<string, unknown> | undefined {
    // Try direct JSON.parse first
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not valid JSON directly --- try to extract from markdown or surrounding text
    }

    // Try extracting JSON from code fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (fenceMatch?.[1]) {
      try {
        const parsed: unknown = JSON.parse(fenceMatch[1])
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // Fall through
      }
    }

    // Try extracting the first { ... } block
    const braceMatch = text.match(/\{[\s\S]*\}/)
    if (braceMatch) {
      try {
        const parsed: unknown = JSON.parse(braceMatch[0])
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // Fall through
      }
    }

    return undefined
  }

  // ---------------------------------------------------------------------------
  // Private: Fallback report from heuristics
  // ---------------------------------------------------------------------------

  private buildFallbackReport(params: AnalyzeParams): RootCauseReport {
    const heuristic = this.classifyHeuristic(params.error)
    return {
      immediateError: params.error,
      rootCause: `Heuristic classification: ${heuristic.category}`,
      causalChain: [params.error],
      affectedNodes: [params.nodeId],
      suggestedFixes: [heuristic.suggestedAction],
      confidence: 0.3,
      hasPastContext: this.pastErrors.length > 0,
    }
  }
}
