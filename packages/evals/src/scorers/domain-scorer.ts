/**
 * Domain-specific quality evaluation scorer.
 *
 * Provides pre-built evaluation rubrics for different AI agent use cases
 * (SQL, code, analysis, ops, general). Each domain has its own weighted
 * quality criteria evaluated via deterministic checks, LLM-as-judge, or both.
 *
 * Usage:
 *   const scorer = new DomainScorer({ domain: 'sql', model: myLlm });
 *   const result = await scorer.score(evalInput);
 *
 *   // Auto-detect domain from content:
 *   const auto = DomainScorer.createAutoDetect(myLlm);
 *   const result2 = await auto.score(evalInput);
 */

import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported evaluation domains. */
export type EvalDomain = 'sql' | 'code' | 'analysis' | 'ops' | 'general';

/** A single quality criterion within a domain. */
export interface DomainCriterion {
  name: string;
  description: string;
  /** Weight 0-1. All weights within a domain should sum to 1. */
  weight: number;
  /** Deterministic check function (if possible). */
  deterministicCheck?: (input: EvalInput) => { score: number; reasoning: string };
  /** LLM rubric (used when no deterministic check, or as supplement). */
  llmRubric: string;
}

/** Domain configuration with all its criteria. */
export interface DomainConfig {
  domain: EvalDomain;
  name: string;
  description: string;
  criteria: DomainCriterion[];
}

/** Per-criterion evaluation result. */
export interface CriterionResult {
  criterion: string;
  score: number;
  reasoning: string;
  method: 'deterministic' | 'llm-judge' | 'combined';
}

/** Result of a domain-specific evaluation. */
export interface DomainScorerResult extends ScorerResult {
  domain: EvalDomain;
  criterionResults: CriterionResult[];
}

/** Constructor parameters for DomainScorer. */
export interface DomainScorerParams {
  domain: EvalDomain;
  /** LLM for judge-based criteria. Required if the domain has LLM-only rubrics. */
  model?: BaseChatModel;
  /** Override the built-in domain config. */
  customConfig?: Partial<DomainConfig>;
  /** Override specific criterion weights. */
  weightOverrides?: Partial<Record<string, number>>;
  /** Pass threshold (default: 0.6). */
  passThreshold?: number;
  /** Max LLM retries on parse failure (default: 2). */
  maxRetries?: number;
  /**
   * When true, domain is auto-detected per input.
   * @internal Used by `DomainScorer.createAutoDetect()`.
   */
  autoDetect?: boolean;
}

// ---------------------------------------------------------------------------
// Zod schema for LLM criterion scoring response
// ---------------------------------------------------------------------------

const criterionResponseSchema = z.object({
  score: z.number().min(0).max(10),
  reasoning: z.string(),
});

type CriterionResponse = z.infer<typeof criterionResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function combinedText(input: EvalInput): string {
  return `${input.input}\n${input.output}${input.reference ? `\n${input.reference}` : ''}`;
}

/**
 * Parse a JSON object from an LLM response string, then validate with Zod.
 * Returns null on failure.
 */
function parseCriterionResponse(raw: string): CriterionResponse | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  const result = criterionResponseSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Count how many patterns from a list are present in the text.
 */
function countPatterns(text: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(text)).length;
}

// ---------------------------------------------------------------------------
// SQL Domain deterministic checks
// ---------------------------------------------------------------------------

function sqlCorrectnessDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // Check for basic SQL structure
  const hasSelect = /\bSELECT\b/i.test(output);
  const hasFrom = /\bFROM\b/i.test(output);
  const hasMutationKeyword = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(output);

  if (!hasSelect && !hasMutationKeyword) {
    issues.push('No SQL statement keyword found (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER)');
    score -= 0.4;
  }

  if (hasSelect && !hasFrom) {
    issues.push('SELECT without FROM clause');
    score -= 0.2;
  }

  // Balanced parentheses
  const openParens = (output.match(/\(/g) ?? []).length;
  const closeParens = (output.match(/\)/g) ?? []).length;
  if (openParens !== closeParens) {
    issues.push(`Unbalanced parentheses: ${openParens} open vs ${closeParens} close`);
    score -= 0.3;
  }

  // Trailing comma before FROM/WHERE
  if (/,\s*(FROM|WHERE)\b/i.test(output)) {
    issues.push('Trailing comma before FROM or WHERE');
    score -= 0.2;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0 ? `Issues: ${issues.join('; ')}` : 'SQL syntax checks passed',
  };
}

function sqlEfficiencyDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  if (/\bSELECT\s+\*/i.test(output)) {
    issues.push('SELECT * used instead of explicit columns');
    score -= 0.25;
  }

  if (/\bDISTINCT\b/i.test(output) && !/--.*distinct/i.test(output)) {
    issues.push('DISTINCT used without documented justification');
    score -= 0.15;
  }

  // Subquery where JOIN might work: detect SELECT in FROM/WHERE subquery
  if (/\bWHERE\b.*\(\s*SELECT\b/i.test(output) || /\bFROM\s*\(\s*SELECT\b/i.test(output)) {
    issues.push('Subquery detected where JOIN might be more efficient');
    score -= 0.2;
  }

  // Missing LIMIT on unbounded query
  if (/\bSELECT\b/i.test(output) && !/\bLIMIT\b/i.test(output) && !/\bTOP\b/i.test(output) && !/\bWHERE\b/i.test(output)) {
    issues.push('Unbounded SELECT without LIMIT or WHERE clause');
    score -= 0.2;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0 ? `Efficiency issues: ${issues.join('; ')}` : 'No efficiency issues detected',
  };
}

function sqlInjectionSafetyDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // String concatenation patterns indicating unsafe interpolation
  const concatPatterns = [
    /['"]?\s*\+\s*\w+\s*\+\s*['"]?/,        // "SELECT " + var + " FROM"
    /\$\{[^}]+\}/,                             // ${variable} template literal
    /f['"].*\{[^}]+\}.*['"]/,                 // f-string pattern
    /['"]?\s*\.\s*format\s*\(/,               // .format() calls
    /% *s/,                                     // %s formatting
  ];

  const unsafeCount = countPatterns(output, concatPatterns);
  if (unsafeCount > 0) {
    issues.push(`Found ${unsafeCount} string interpolation/concatenation pattern(s)`);
    score -= 0.4;
  }

  // Check for parameterized query indicators
  const paramPatterns = [
    /\?\s*[,)]/,             // ? placeholders
    /\$\d+/,                 // $1, $2 placeholders
    /:[\w]+/,                // :named placeholders
    /@[\w]+/,                // @named placeholders
  ];

  const hasParams = countPatterns(output, paramPatterns) > 0;
  // Only flag if there is user-input-related context and no parameterization
  const mentionsUserInput = /\b(user[_ ]?input|request\.(body|query|params)|req\.(body|query|params))\b/i.test(
    combinedText(input),
  );
  if (mentionsUserInput && !hasParams && unsafeCount === 0) {
    issues.push('User input referenced but no parameterized query patterns detected');
    score -= 0.3;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Injection safety issues: ${issues.join('; ')}`
      : 'No injection safety issues detected',
  };
}

function sqlReadabilityDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // Check keyword casing (should be uppercase)
  const keywords = ['select', 'from', 'where', 'join', 'inner', 'left', 'right', 'outer',
    'group', 'order', 'having', 'limit', 'insert', 'update', 'delete', 'create', 'alter', 'drop'];
  const foundLowerKeywords = keywords.filter((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`);
    const regexUpper = new RegExp(`\\b${kw.toUpperCase()}\\b`);
    return regex.test(output) && !regexUpper.test(output);
  });

  if (foundLowerKeywords.length > 0) {
    issues.push(`Lowercase SQL keywords found: ${foundLowerKeywords.join(', ')}`);
    score -= 0.1 * Math.min(foundLowerKeywords.length, 3);
  }

  // Check for line breaks (multi-line is more readable for non-trivial queries)
  const hasClauses = /\b(FROM|WHERE|JOIN|GROUP|ORDER|HAVING)\b/i.test(output);
  const hasLineBreaks = /\n/.test(output.trim());
  if (hasClauses && !hasLineBreaks && output.length > 80) {
    issues.push('Complex query on a single line without line breaks');
    score -= 0.2;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Readability issues: ${issues.join('; ')}`
      : 'SQL readability checks passed',
  };
}

// ---------------------------------------------------------------------------
// Code Domain deterministic checks
// ---------------------------------------------------------------------------

function codeTypeCorrectnessDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // Count `any` type annotations (excluding comments)
  const lines = output.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const anyCount = lines.filter((l) => /:\s*any\b/.test(l) || /as\s+any\b/.test(l) || /<any>/.test(l)).length;
  if (anyCount > 0) {
    issues.push(`Found ${anyCount} usage(s) of 'any' type`);
    score -= 0.15 * Math.min(anyCount, 4);
  }

  // TypeScript suppression directives (ts-ignore, ts-expect-error)
  const tsIgnoreCount = (output.match(/@ts-ignore/g) ?? []).length;
  if (tsIgnoreCount > 0) {
    issues.push(`Found ${tsIgnoreCount} @ts-ignore directive(s)`);
    score -= 0.15 * Math.min(tsIgnoreCount, 3);
  }

  // ts-expect-error is slightly better than ts-ignore but still a concern
  const tsExpectCount = (output.match(/@ts-expect-error/g) ?? []).length;
  if (tsExpectCount > 0) {
    issues.push(`Found ${tsExpectCount} @ts-expect-error directive(s)`);
    score -= 0.05 * Math.min(tsExpectCount, 3);
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Type safety issues: ${issues.join('; ')}`
      : 'No type safety issues detected',
  };
}

function codeTestCoverageDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const testPatterns = [
    /\bdescribe\s*\(/,
    /\bit\s*\(/,
    /\btest\s*\(/,
    /\bexpect\s*\(/,
    /\bassert\b/,
    /\bbeforeEach\s*\(/,
    /\bafterEach\s*\(/,
  ];

  const foundCount = countPatterns(text, testPatterns);

  if (foundCount === 0) {
    return { score: 0.0, reasoning: 'No test patterns found (describe, it, test, expect, assert)' };
  }

  const score = clamp01(foundCount / 4); // 4+ patterns = full score
  return {
    score,
    reasoning: `Found ${foundCount} test pattern(s): ${score >= 0.75 ? 'good coverage indicators' : 'some test patterns present'}`,
  };
}

function codeSecurityDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const issues: string[] = [];
  let score = 1.0;

  // Hardcoded secrets
  const secretPatterns = [
    /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    /(?:AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,  // AWS keys
  ];
  if (countPatterns(output, secretPatterns) > 0) {
    issues.push('Possible hardcoded secret detected');
    score -= 0.4;
  }

  // eval()
  if (/\beval\s*\(/.test(output)) {
    issues.push('eval() usage detected');
    score -= 0.3;
  }

  // innerHTML
  if (/\.innerHTML\s*=/.test(output)) {
    issues.push('innerHTML assignment detected (XSS risk)');
    score -= 0.2;
  }

  // dangerouslySetInnerHTML
  if (/dangerouslySetInnerHTML/.test(output)) {
    issues.push('dangerouslySetInnerHTML usage detected');
    score -= 0.15;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Security issues: ${issues.join('; ')}`
      : 'No security issues detected',
  };
}

function codeErrorHandlingDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const indicators: string[] = [];
  let score = 0.5; // Start neutral

  // Presence of try/catch
  const tryCatchCount = (output.match(/\btry\s*\{/g) ?? []).length;
  if (tryCatchCount > 0) {
    indicators.push(`${tryCatchCount} try/catch block(s) found`);
    score += 0.2;
  }

  // Empty catch blocks (bad)
  if (/catch\s*\([^)]*\)\s*\{\s*\}/g.test(output)) {
    indicators.push('Empty catch block detected (swallowed error)');
    score -= 0.3;
  }

  // Typed errors
  if (/\binstanceof\s+\w*Error\b/.test(output) || /\bextends\s+Error\b/.test(output)) {
    indicators.push('Typed error handling detected');
    score += 0.15;
  }

  // .catch on promises
  if (/\.catch\s*\(/.test(output)) {
    indicators.push('Promise .catch() handling detected');
    score += 0.1;
  }

  return {
    score: clamp01(score),
    reasoning: indicators.length > 0
      ? `Error handling: ${indicators.join('; ')}`
      : 'No specific error handling patterns detected',
  };
}

// ---------------------------------------------------------------------------
// Analysis Domain deterministic checks
// ---------------------------------------------------------------------------

function analysisCitationDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const output = input.output;
  const indicators: string[] = [];
  let score = 0.0;

  // Reference patterns
  const refPatterns = [
    /\[[\d,\s-]+\]/,                  // [1], [1,2], [1-3]
    /\(\w+(?:\s+et\s+al\.?)?,?\s*\d{4}\)/,  // (Author, 2024) / (Author et al., 2024)
    /\bsource\s*:/i,                  // Source:
    /\breference\s*:/i,               // Reference:
    /\bcf\.\s/i,                      // cf.
    /\bsee\s/i,                       // see ...
    /https?:\/\/\S+/,                 // URLs
    /\baccording\s+to\b/i,            // according to
    /\bdata\s+shows?\b/i,             // data shows
    /\bfigure\s+\d/i,                 // Figure 1
    /\btable\s+\d/i,                  // Table 1
  ];

  const found = countPatterns(output, refPatterns);
  if (found > 0) {
    score = clamp01(found / 3); // 3+ reference indicators = full score
    indicators.push(`Found ${found} citation/reference pattern(s)`);
  } else {
    indicators.push('No citation or reference patterns found');
  }

  return {
    score,
    reasoning: indicators.join('; '),
  };
}

// ---------------------------------------------------------------------------
// Ops Domain deterministic checks
// ---------------------------------------------------------------------------

function opsIdempotencyDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const patterns = [
    /\bIF\s+NOT\s+EXISTS\b/i,
    /\bCREATE\s+OR\s+REPLACE\b/i,
    /\bupsert\b/i,
    /\bON\s+CONFLICT\b/i,
    /\bINSERT\s+.*\bOR\s+IGNORE\b/i,
    /\bmerge\b/i,
    /\bidempoten/i,
    /\b--create-namespace\b/i,
    /\bapply\b/i,   // kubectl apply is idempotent
  ];

  const found = countPatterns(text, patterns);
  const score = clamp01(found / 2);
  return {
    score,
    reasoning: found > 0
      ? `Found ${found} idempotency pattern(s)`
      : 'No idempotency patterns detected',
  };
}

function opsRollbackSafetyDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const patterns = [
    /\bBEGIN\b.*\b(COMMIT|ROLLBACK)\b/is,
    /\btransaction\b/i,
    /\brollback\b/i,
    /\bbackup\b/i,
    /\brevert\b/i,
    /\bundo\b/i,
    /\bmigration.*down\b/i,
    /\bdown\s*\(\s*\)/i,           // down() migration method
    /\bsnapshot\b/i,
  ];

  const found = countPatterns(text, patterns);
  const score = clamp01(found / 2);
  return {
    score,
    reasoning: found > 0
      ? `Found ${found} rollback/safety pattern(s)`
      : 'No rollback safety patterns detected',
  };
}

function opsPermissionScopeDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const issues: string[] = [];
  let score = 1.0;

  if (/\bsudo\b/.test(text) && !/\bjustif/i.test(text) && !/\breason/i.test(text)) {
    issues.push('sudo used without documented justification');
    score -= 0.3;
  }

  if (/\bchmod\s+777\b/.test(text)) {
    issues.push('chmod 777 detected (overly permissive)');
    score -= 0.3;
  }

  if (/["']?\*["']?\s*$|:\s*["']\*["']/m.test(text) && /\b(iam|policy|role|permission)\b/i.test(text)) {
    issues.push('Wildcard (*) IAM/permission pattern detected');
    score -= 0.3;
  }

  if (/\broot\b/i.test(text) && /\b(container|docker|pod)\b/i.test(text) && !/\bnon-root\b/i.test(text)) {
    issues.push('Running as root in container context');
    score -= 0.2;
  }

  return {
    score: clamp01(score),
    reasoning: issues.length > 0
      ? `Permission issues: ${issues.join('; ')}`
      : 'No permission scope issues detected',
  };
}

function opsMonitoringDeterministic(input: EvalInput): { score: number; reasoning: string } {
  const text = combinedText(input);
  const patterns = [
    /\blog(ger|ging)?\b/i,
    /\bconsole\.(log|warn|error|info)\b/,
    /\bhealth[_-]?check\b/i,
    /\b\/health\b/i,
    /\balert(s|ing)?\b/i,
    /\bmetric(s)?\b/i,
    /\bmonitor(ing)?\b/i,
    /\bprometheus\b/i,
    /\bgrafana\b/i,
    /\bdatadog\b/i,
    /\bsentry\b/i,
    /\btracing?\b/i,
    /\bopentelemetry\b/i,
  ];

  const found = countPatterns(text, patterns);
  const score = clamp01(found / 3);
  return {
    score,
    reasoning: found > 0
      ? `Found ${found} monitoring/observability pattern(s)`
      : 'No monitoring or observability patterns detected',
  };
}

// ---------------------------------------------------------------------------
// Built-in Domain Configurations
// ---------------------------------------------------------------------------

const SQL_CONFIG: DomainConfig = {
  domain: 'sql',
  name: 'SQL Quality',
  description: 'Evaluates SQL query quality across correctness, efficiency, safety, schema compliance, and readability.',
  criteria: [
    {
      name: 'queryCorrectness',
      description: 'Does the SQL produce correct results?',
      weight: 0.35,
      deterministicCheck: sqlCorrectnessDeterministic,
      llmRubric: 'Evaluate whether this SQL query correctly solves the stated problem. Check for logical errors, missing conditions, wrong joins, and incorrect aggregations. Score 0-10.',
    },
    {
      name: 'queryEfficiency',
      description: 'Is the query efficient?',
      weight: 0.20,
      deterministicCheck: sqlEfficiencyDeterministic,
      llmRubric: 'Evaluate the efficiency of this SQL query. Check for SELECT *, unnecessary DISTINCT, subqueries that could be JOINs, missing indexes hints, and unbounded queries. Score 0-10.',
    },
    {
      name: 'injectionSafety',
      description: 'Is the query safe from SQL injection?',
      weight: 0.20,
      deterministicCheck: sqlInjectionSafetyDeterministic,
      llmRubric: 'Evaluate whether this SQL query is safe from SQL injection. Check for parameterized queries, no string concatenation of user input, no raw interpolation. Score 0-10.',
    },
    {
      name: 'schemaCompliance',
      description: 'Does the query match the provided schema?',
      weight: 0.15,
      llmRubric: 'Evaluate whether this SQL query correctly references the provided database schema. Check table names, column names, data types, and relationships. Score 0-10.',
    },
    {
      name: 'readability',
      description: 'Is the SQL readable?',
      weight: 0.10,
      deterministicCheck: sqlReadabilityDeterministic,
      llmRubric: 'Evaluate the readability of this SQL query. Check keyword casing, consistent aliasing, indentation, and appropriate line breaks. Score 0-10.',
    },
  ],
};

const CODE_CONFIG: DomainConfig = {
  domain: 'code',
  name: 'Code Quality',
  description: 'Evaluates code quality across type safety, testing, security, error handling, and style.',
  criteria: [
    {
      name: 'typeCorrectness',
      description: 'TypeScript type safety',
      weight: 0.30,
      deterministicCheck: codeTypeCorrectnessDeterministic,
      llmRubric: 'Evaluate the TypeScript type safety of this code. Check for proper type annotations, no `any` types, correct generic usage, and discriminated unions where appropriate. Score 0-10.',
    },
    {
      name: 'testCoverage',
      description: 'Are there tests?',
      weight: 0.20,
      deterministicCheck: codeTestCoverageDeterministic,
      llmRubric: 'Evaluate the test coverage of this code. Check for describe/it/test blocks, edge case coverage, assertion quality, and mock usage. Score 0-10.',
    },
    {
      name: 'securityPractices',
      description: 'No hardcoded secrets, no eval(), no innerHTML',
      weight: 0.20,
      deterministicCheck: codeSecurityDeterministic,
      llmRubric: 'Evaluate the security practices in this code. Check for hardcoded secrets, eval() usage, innerHTML/dangerouslySetInnerHTML, and proper input validation. Score 0-10.',
    },
    {
      name: 'errorHandling',
      description: 'Proper try/catch, error types, no swallowed errors',
      weight: 0.15,
      deterministicCheck: codeErrorHandlingDeterministic,
      llmRubric: 'Evaluate error handling in this code. Check for proper try/catch blocks, typed errors, no swallowed errors (empty catch), and proper error propagation. Score 0-10.',
    },
    {
      name: 'codeStyle',
      description: 'Consistent naming, no magic numbers, proper imports',
      weight: 0.15,
      llmRubric: 'Evaluate the code style. Check for consistent naming conventions, no magic numbers, proper imports (no circular, no barrel re-exports of everything), clear function signatures, and appropriate documentation. Score 0-10.',
    },
  ],
};

const ANALYSIS_CONFIG: DomainConfig = {
  domain: 'analysis',
  name: 'Analysis Quality',
  description: 'Evaluates analytical output quality across accuracy, completeness, citations, methodology, and clarity.',
  criteria: [
    {
      name: 'accuracy',
      description: 'Are the conclusions correct?',
      weight: 0.35,
      llmRubric: 'Evaluate the factual accuracy of this analysis. Are the conclusions logically supported by the data? Are there any factual errors or misleading claims? Score 0-10.',
    },
    {
      name: 'completeness',
      description: 'All aspects covered?',
      weight: 0.25,
      llmRubric: 'Evaluate the completeness of this analysis. Are all relevant aspects addressed? Are there significant gaps or missing perspectives? Score 0-10.',
    },
    {
      name: 'citationQuality',
      description: 'Are sources cited?',
      weight: 0.20,
      deterministicCheck: analysisCitationDeterministic,
      llmRubric: 'Evaluate the citation and sourcing quality. Are claims backed by data or references? Are sources credible and properly attributed? Score 0-10.',
    },
    {
      name: 'methodology',
      description: 'Sound analytical approach?',
      weight: 0.10,
      llmRubric: 'Evaluate the analytical methodology. Is the approach sound and appropriate for the problem? Are assumptions stated? Is the reasoning transparent? Score 0-10.',
    },
    {
      name: 'clarity',
      description: 'Clear communication?',
      weight: 0.10,
      llmRubric: 'Evaluate the clarity of communication. Is the analysis well-structured, easy to follow, and appropriately targeted for its audience? Score 0-10.',
    },
  ],
};

const OPS_CONFIG: DomainConfig = {
  domain: 'ops',
  name: 'Operations Quality',
  description: 'Evaluates operational scripts/configs across idempotency, rollback safety, permissions, monitoring, and documentation.',
  criteria: [
    {
      name: 'idempotency',
      description: 'Can the operation be safely re-run?',
      weight: 0.25,
      deterministicCheck: opsIdempotencyDeterministic,
      llmRubric: 'Evaluate whether this operation is idempotent. Can it be safely re-run without side effects? Does it use CREATE IF NOT EXISTS, upsert patterns, or conditional creates? Score 0-10.',
    },
    {
      name: 'rollbackSafety',
      description: 'Is there a rollback path?',
      weight: 0.25,
      deterministicCheck: opsRollbackSafetyDeterministic,
      llmRubric: 'Evaluate rollback safety. Is there a clear rollback path? Are transactions used? Are backups mentioned? Is there a migration down method? Score 0-10.',
    },
    {
      name: 'permissionScope',
      description: 'Least-privilege?',
      weight: 0.20,
      deterministicCheck: opsPermissionScopeDeterministic,
      llmRubric: 'Evaluate the permission scope. Does this follow least-privilege principles? Are there unnecessary sudo/root usages, chmod 777, or wildcard IAM policies? Score 0-10.',
    },
    {
      name: 'monitoring',
      description: 'Observability included?',
      weight: 0.15,
      deterministicCheck: opsMonitoringDeterministic,
      llmRubric: 'Evaluate the monitoring and observability. Are there logging, health checks, alerts, or metrics? Is the operation observable in production? Score 0-10.',
    },
    {
      name: 'documentation',
      description: 'Runbook/docs?',
      weight: 0.15,
      llmRubric: 'Evaluate the documentation quality. Is there a runbook, inline comments explaining why, or operational documentation? Are prerequisites and dependencies documented? Score 0-10.',
    },
  ],
};

const GENERAL_CONFIG: DomainConfig = {
  domain: 'general',
  name: 'General Quality',
  description: 'General-purpose quality evaluation across correctness, completeness, clarity, relevance, and safety.',
  criteria: [
    {
      name: 'correctness',
      description: 'Is the output factually correct?',
      weight: 0.30,
      llmRubric: 'Evaluate the factual correctness of this output. Are the statements accurate? Does it solve the stated problem correctly? Score 0-10.',
    },
    {
      name: 'completeness',
      description: 'All aspects addressed?',
      weight: 0.25,
      llmRubric: 'Evaluate the completeness. Are all parts of the task addressed? Are there significant omissions? Score 0-10.',
    },
    {
      name: 'clarity',
      description: 'Clear and well-structured?',
      weight: 0.20,
      llmRubric: 'Evaluate the clarity and structure. Is the output well-organized, easy to understand, and appropriately detailed? Score 0-10.',
    },
    {
      name: 'relevance',
      description: 'Directly addresses the task?',
      weight: 0.15,
      llmRubric: 'Evaluate the relevance. Does the output directly address what was asked? Is there unnecessary padding or off-topic content? Score 0-10.',
    },
    {
      name: 'safety',
      description: 'Free from harmful content?',
      weight: 0.10,
      llmRubric: 'Evaluate the safety. Is the output free from harmful, biased, or inappropriate content? Score 0-10.',
    },
  ],
};

/** Map of all built-in domain configurations. */
const DOMAIN_CONFIGS: Record<EvalDomain, DomainConfig> = {
  sql: SQL_CONFIG,
  code: CODE_CONFIG,
  analysis: ANALYSIS_CONFIG,
  ops: OPS_CONFIG,
  general: GENERAL_CONFIG,
};

// ---------------------------------------------------------------------------
// Domain Detection
// ---------------------------------------------------------------------------

/** Pattern sets for domain auto-detection, ordered by specificity. */
const DOMAIN_DETECTION_PATTERNS: Array<{ domain: EvalDomain; patterns: RegExp[] }> = [
  {
    domain: 'sql',
    patterns: [
      /\bSELECT\b/i,
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+TABLE\b/i,
      /\bALTER\s+TABLE\b/i,
    ],
  },
  {
    domain: 'ops',
    patterns: [
      /\bdeploy/i,
      /\bkubernetes\b/i,
      /\bk8s\b/i,
      /\bdocker\b/i,
      /\bterraform\b/i,
      /\bansible\b/i,
      /\bmigration\b/i,
      /\brollback\b/i,
      /\bhelm\b/i,
      /\bci\/?cd\b/i,
    ],
  },
  {
    domain: 'code',
    patterns: [
      /\bfunction\s+\w+/,
      /\bclass\s+\w+/,
      /\bimport\s+/,
      /\bexport\s+/,
      /\bconst\s+\w+/,
      /\blet\s+\w+/,
      /\bdef\s+\w+/,
      /\breturn\s+/,
    ],
  },
  {
    domain: 'analysis',
    patterns: [
      /\banalyze\b/i,
      /\banalysis\b/i,
      /\breport\b/i,
      /\bfindings\b/i,
      /\bmetrics?\b/i,
      /\btrend\b/i,
      /\binsight/i,
      /\bcorrelat/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// DomainScorer
// ---------------------------------------------------------------------------

/**
 * Domain-specific quality evaluation scorer.
 *
 * Evaluates LLM outputs against domain-specific quality criteria using a
 * combination of deterministic pattern checks and LLM-as-judge rubrics.
 *
 * Each supported domain (sql, code, analysis, ops, general) has pre-built
 * criteria with weights. The final score is a weighted average of all
 * criterion scores.
 */
export class DomainScorer implements Scorer<EvalInput> {
  readonly config: ScorerConfig;

  private readonly domainConfig: DomainConfig;
  private readonly model: BaseChatModel | undefined;
  private readonly passThreshold: number;
  private readonly maxRetries: number;
  private readonly autoDetect: boolean;

  constructor(params: DomainScorerParams) {
    this.model = params.model;
    this.passThreshold = params.passThreshold ?? 0.6;
    this.maxRetries = params.maxRetries ?? 2;
    this.autoDetect = params.autoDetect ?? false;

    // Build the domain config, applying customConfig and weight overrides
    const baseConfig = { ...DOMAIN_CONFIGS[params.domain] };

    if (params.customConfig) {
      if (params.customConfig.name !== undefined) baseConfig.name = params.customConfig.name;
      if (params.customConfig.description !== undefined) baseConfig.description = params.customConfig.description;
      if (params.customConfig.criteria !== undefined) baseConfig.criteria = params.customConfig.criteria;
    }

    // Apply weight overrides
    if (params.weightOverrides) {
      baseConfig.criteria = baseConfig.criteria.map((c) => {
        const override = params.weightOverrides?.[c.name];
        return override !== undefined ? { ...c, weight: override } : c;
      });

      // Normalize weights to sum to 1
      const totalWeight = baseConfig.criteria.reduce((sum, c) => sum + c.weight, 0);
      if (totalWeight > 0 && Math.abs(totalWeight - 1) > 0.001) {
        baseConfig.criteria = baseConfig.criteria.map((c) => ({
          ...c,
          weight: c.weight / totalWeight,
        }));
      }
    }

    this.domainConfig = baseConfig;

    const domainLabel = this.autoDetect ? 'auto' : params.domain;
    this.config = {
      id: `domain-scorer-${domainLabel}`,
      name: `domain-scorer-${domainLabel}`,
      description: this.autoDetect ? 'Auto-detecting domain-specific quality scorer' : baseConfig.description,
      type: 'composite',
      threshold: this.passThreshold,
    };
  }

  /**
   * Score an evaluation input against the domain-specific criteria.
   */
  async score(input: EvalInput): Promise<DomainScorerResult> {
    const startTime = Date.now();

    // If auto-detect mode, resolve the domain dynamically
    const effectiveConfig = this.autoDetect
      ? DOMAIN_CONFIGS[DomainScorer.detectDomain(input)]
      : this.domainConfig;

    const effectiveDomain = effectiveConfig.domain;
    const criterionResults: CriterionResult[] = [];
    const scorerScores: Array<{ criterion: string; score: number; reasoning: string }> = [];

    for (const criterion of effectiveConfig.criteria) {
      const result = await this.scoreCriterion(criterion, input);
      criterionResults.push(result);
      scorerScores.push({
        criterion: result.criterion,
        score: result.score,
        reasoning: result.reasoning,
      });
    }

    // Weighted average
    let totalWeight = 0;
    let weightedSum = 0;
    for (let i = 0; i < effectiveConfig.criteria.length; i++) {
      const criterion = effectiveConfig.criteria[i];
      const criterionResult = criterionResults[i];
      if (criterion && criterionResult) {
        totalWeight += criterion.weight;
        weightedSum += criterionResult.score * criterion.weight;
      }
    }
    const aggregateScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    const durationMs = Date.now() - startTime;

    return {
      scorerId: this.config.id,
      scores: scorerScores,
      aggregateScore,
      passed: aggregateScore >= this.passThreshold,
      durationMs,
      domain: effectiveDomain,
      criterionResults,
    };
  }

  /**
   * Auto-detect the evaluation domain from input content.
   *
   * Examines both input and output text for domain-specific keywords.
   * Returns the first matching domain by specificity, or 'general' as fallback.
   */
  static detectDomain(input: EvalInput): EvalDomain {
    const text = combinedText(input);

    for (const { domain, patterns } of DOMAIN_DETECTION_PATTERNS) {
      const matchCount = countPatterns(text, patterns);
      // Require at least 2 pattern matches for confident detection
      if (matchCount >= 2) {
        return domain;
      }
    }

    // Single-match fallback: if any domain has at least 1 match, use it
    for (const { domain, patterns } of DOMAIN_DETECTION_PATTERNS) {
      if (countPatterns(text, patterns) >= 1) {
        return domain;
      }
    }

    return 'general';
  }

  /**
   * Create a DomainScorer that auto-detects the domain for each input.
   *
   * The domain is detected per-call based on input/output content patterns.
   */
  static createAutoDetect(model: BaseChatModel): DomainScorer {
    return new DomainScorer({ domain: 'general', model, autoDetect: true });
  }

  /**
   * Get the built-in configuration for a specific domain.
   */
  static getConfig(domain: EvalDomain): DomainConfig {
    return { ...DOMAIN_CONFIGS[domain] };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Score a single criterion using deterministic check, LLM judge, or both.
   */
  private async scoreCriterion(
    criterion: DomainCriterion,
    input: EvalInput,
  ): Promise<CriterionResult> {
    const hasDeterministic = criterion.deterministicCheck !== undefined;
    const hasModel = this.model !== undefined;

    // Deterministic only
    if (hasDeterministic && !hasModel) {
      const result = criterion.deterministicCheck!(input);
      return {
        criterion: criterion.name,
        score: result.score,
        reasoning: result.reasoning,
        method: 'deterministic',
      };
    }

    // LLM only (no deterministic check available)
    if (!hasDeterministic && hasModel) {
      const result = await this.llmJudgeCriterion(criterion, input);
      return {
        criterion: criterion.name,
        score: result.score,
        reasoning: result.reasoning,
        method: 'llm-judge',
      };
    }

    // Both available: combined scoring
    if (hasDeterministic && hasModel) {
      const deterResult = criterion.deterministicCheck!(input);
      const llmResult = await this.llmJudgeCriterion(criterion, input);

      // Weighted combination: 40% deterministic, 60% LLM when both available
      const combinedScore = clamp01(deterResult.score * 0.4 + llmResult.score * 0.6);

      return {
        criterion: criterion.name,
        score: combinedScore,
        reasoning: `Deterministic (${deterResult.score.toFixed(2)}): ${deterResult.reasoning} | LLM (${llmResult.score.toFixed(2)}): ${llmResult.reasoning}`,
        method: 'combined',
      };
    }

    // No deterministic check and no model: skip with warning
    return {
      criterion: criterion.name,
      score: 0,
      reasoning: 'No evaluation method available: no deterministic check defined and no LLM model provided',
      method: 'deterministic',
    };
  }

  /**
   * Use LLM-as-judge to evaluate a single criterion.
   */
  private async llmJudgeCriterion(
    criterion: DomainCriterion,
    input: EvalInput,
  ): Promise<{ score: number; reasoning: string }> {
    if (!this.model) {
      return { score: 0, reasoning: 'No LLM model provided for judge-based criterion' };
    }

    const systemPrompt = [
      'You are an expert evaluator. Score the following output on a specific quality criterion.',
      'Return ONLY a JSON object matching this exact schema: { "score": number (0-10), "reasoning": string }',
      '',
      `Criterion: ${criterion.name}`,
      `Description: ${criterion.description}`,
      `Rubric: ${criterion.llmRubric}`,
    ].join('\n');

    const userPrompt = [
      `Input: ${input.input}`,
      `Output: ${input.output}`,
      ...(input.reference ? [`Reference: ${input.reference}`] : []),
      '',
      'Evaluate and return JSON only.',
    ].join('\n');

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.model.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(userPrompt),
        ]);

        const content = typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content
                .filter((c): c is { type: 'text'; text: string } =>
                  typeof c === 'object' && c !== null && 'type' in c && c.type === 'text')
                .map((c) => c.text)
                .join('')
            : String(response.content);

        const parsed = parseCriterionResponse(content);
        if (parsed) {
          return {
            score: clamp01(parsed.score / 10),
            reasoning: parsed.reasoning,
          };
        }
      } catch {
        // LLM call failed; retry
      }
    }

    // All retries exhausted: return a neutral fallback
    return {
      score: 0.5,
      reasoning: `Failed to get valid LLM judge response for "${criterion.name}" after ${this.maxRetries + 1} attempt(s)`,
    };
  }
}
