import { BUILTIN_RULES } from './review-rules.js'
import type { ReviewRule, ReviewSeverity, ReviewCategory } from './review-rules.js'

export interface ReviewComment {
  file: string
  line: number
  severity: ReviewSeverity
  category: ReviewCategory
  ruleId: string
  message: string
  suggestion?: string
  codeSnippet?: string
}

export interface ReviewSummary {
  totalIssues: number
  critical: number
  warnings: number
  suggestions: number
  categoryCounts: Record<ReviewCategory, number>
}

export interface ReviewResult {
  comments: ReviewComment[]
  summary: ReviewSummary
}

export interface CodeReviewConfig {
  /** Custom rules to add (merged with built-in) */
  customRules?: ReviewRule[]
  /** Rule IDs to disable */
  disabledRules?: string[]
  /** Only review these file patterns (glob) */
  includePatterns?: string[]
  /** Skip these file patterns */
  excludePatterns?: string[]
  /** Minimum severity to report (default: 'suggestion') */
  minSeverity?: ReviewSeverity
}

const SEVERITY_ORDER: Record<ReviewSeverity, number> = { critical: 0, warning: 1, suggestion: 2 }

function simpleGlobMatch(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(path)
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => simpleGlobMatch(p, path))
}

function resolveRules(config?: CodeReviewConfig): ReviewRule[] {
  const disabled = new Set(config?.disabledRules ?? [])
  const base = BUILTIN_RULES.filter((r) => !disabled.has(r.id))
  const custom = (config?.customRules ?? []).filter((r) => !disabled.has(r.id))
  return [...base, ...custom]
}

function shouldIncludeFile(filePath: string, config?: CodeReviewConfig): boolean {
  if (config?.includePatterns?.length && !matchesAny(filePath, config.includePatterns)) return false
  if (config?.excludePatterns?.length && matchesAny(filePath, config.excludePatterns)) return false
  return true
}

function applyRulesToLines(
  filePath: string,
  lines: string[],
  lineNumbers: number[],
  rules: ReviewRule[],
  minSeverity: number,
): ReviewComment[] {
  const comments: ReviewComment[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const lineNum = lineNumbers[i] as number
    for (const rule of rules) {
      if (SEVERITY_ORDER[rule.severity] > minSeverity) continue
      if (rule.pattern.test(line)) {
        comments.push({
          file: filePath,
          line: lineNum,
          severity: rule.severity,
          category: rule.category,
          ruleId: rule.id,
          message: rule.description,
          suggestion: rule.suggestion,
          codeSnippet: line.trimStart(),
        })
      }
    }
  }
  return comments
}

function buildSummary(comments: ReviewComment[]): ReviewSummary {
  const categoryCounts: Record<ReviewCategory, number> = {
    security: 0, bug: 0, performance: 0, style: 0, 'best-practice': 0,
  }
  let critical = 0, warnings = 0, suggestions = 0
  for (const c of comments) {
    categoryCounts[c.category]++
    if (c.severity === 'critical') critical++
    else if (c.severity === 'warning') warnings++
    else suggestions++
  }
  return { totalIssues: comments.length, critical, warnings, suggestions, categoryCounts }
}

/**
 * Review code files against built-in and custom rules.
 */
export function reviewFiles(
  files: Record<string, string>,
  config?: CodeReviewConfig,
): ReviewResult {
  const rules = resolveRules(config)
  const minSev = SEVERITY_ORDER[config?.minSeverity ?? 'suggestion']
  const allComments: ReviewComment[] = []

  for (const [filePath, content] of Object.entries(files)) {
    if (!shouldIncludeFile(filePath, config)) continue
    const lines = content.split('\n')
    const lineNumbers = lines.map((_, i) => i + 1)
    allComments.push(...applyRulesToLines(filePath, lines, lineNumbers, rules, minSev))
  }

  allComments.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  return { comments: allComments, summary: buildSummary(allComments) }
}

/**
 * Review a single file diff (changed lines only — lines starting with +).
 */
export function reviewDiff(
  filePath: string,
  diffContent: string,
  config?: CodeReviewConfig,
): ReviewComment[] {
  if (!shouldIncludeFile(filePath, config)) return []
  const rules = resolveRules(config)
  const minSev = SEVERITY_ORDER[config?.minSeverity ?? 'suggestion']

  const lines: string[] = []
  const lineNumbers: number[] = []
  let currentLine = 0

  for (const raw of diffContent.split('\n')) {
    const hunkMatch = raw.match(/^@@\s*-\d+(?:,\d+)?\s*\+(\d+)/)
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1] as string, 10) - 1
      continue
    }
    if (raw.startsWith('---') || raw.startsWith('+++')) continue
    if (raw.startsWith('+')) {
      currentLine++
      lines.push(raw.slice(1))
      lineNumbers.push(currentLine)
    } else if (!raw.startsWith('-')) {
      currentLine++
    }
  }

  return applyRulesToLines(filePath, lines, lineNumbers, rules, minSev)
}

/**
 * Format review results as markdown (for PR comments).
 */
export function formatReviewAsMarkdown(result: ReviewResult): string {
  const { summary, comments } = result
  if (comments.length === 0) return '**Code Review:** No issues found.'

  const parts: string[] = [
    `**Code Review Summary:** ${summary.totalIssues} issue(s) found`,
    `- Critical: ${summary.critical} | Warnings: ${summary.warnings} | Suggestions: ${summary.suggestions}`,
    '',
  ]

  const byFile = new Map<string, ReviewComment[]>()
  for (const c of comments) {
    const arr = byFile.get(c.file) ?? []
    arr.push(c)
    byFile.set(c.file, arr)
  }

  const severityIcon: Record<ReviewSeverity, string> = { critical: '[CRITICAL]', warning: '[WARNING]', suggestion: '[SUGGESTION]' }

  for (const [file, fileComments] of byFile) {
    parts.push(`### ${file}`)
    const sorted = [...fileComments].sort((a, b) => a.line - b.line)
    for (const c of sorted) {
      parts.push(`- **L${c.line}** ${severityIcon[c.severity]} \`${c.ruleId}\`: ${c.message}`)
      if (c.codeSnippet) parts.push(`  \`\`\`\n  ${c.codeSnippet}\n  \`\`\``)
      if (c.suggestion) parts.push(`  > ${c.suggestion}`)
    }
    parts.push('')
  }

  return parts.join('\n')
}
