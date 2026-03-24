/**
 * Review feedback handler — parse, classify, and consolidate PR review comments.
 *
 * Pure functions: no side effects, no external dependencies.
 */

import type { ReviewComment } from './pr-manager.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewIssue {
  severity: 'critical' | 'major' | 'minor' | 'suggestion'
  description: string
  file?: string
  line?: number
}

export interface ReviewFeedback {
  /** Consolidated feedback from all review comments */
  summary: string
  /** Files that need changes */
  affectedFiles: string[]
  /** Categorized issues */
  issues: ReviewIssue[]
}

// ---------------------------------------------------------------------------
// Severity classification (regex-based)
// ---------------------------------------------------------------------------

const SEVERITY_PATTERNS: Array<{ pattern: RegExp; severity: ReviewIssue['severity'] }> = [
  { pattern: /\b(?:must|critical|security|vulnerability|break(?:s|ing)?|crash(?:es|ing)?)\b/i, severity: 'critical' },
  { pattern: /\b(?:should|important|bug|incorrect|wrong)\b/i, severity: 'major' },
  { pattern: /\b(?:nit|style|suggestion|optional)\b/i, severity: 'suggestion' },
  { pattern: /\b(?:could|consider|minor|small)\b/i, severity: 'minor' },
]

/**
 * Classify review comment severity from text content.
 * Matches against keyword patterns in priority order; defaults to 'minor'.
 */
export function classifyCommentSeverity(comment: string): ReviewIssue['severity'] {
  for (const { pattern, severity } of SEVERITY_PATTERNS) {
    if (pattern.test(comment)) {
      return severity
    }
  }
  return 'minor'
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * Parse and consolidate review comments into actionable feedback.
 */
export function consolidateReviews(comments: ReviewComment[]): ReviewFeedback {
  if (comments.length === 0) {
    return { summary: 'No review comments.', affectedFiles: [], issues: [] }
  }

  const issues: ReviewIssue[] = comments.map((c) => ({
    severity: classifyCommentSeverity(c.body),
    description: c.body,
    file: c.path,
    line: c.line,
  }))

  // Collect unique affected files
  const fileSet = new Set<string>()
  for (const issue of issues) {
    if (issue.file) {
      fileSet.add(issue.file)
    }
  }
  const affectedFiles = [...fileSet].sort()

  // Build summary grouped by severity
  const counts: Record<ReviewIssue['severity'], number> = {
    critical: 0,
    major: 0,
    minor: 0,
    suggestion: 0,
  }
  for (const issue of issues) {
    counts[issue.severity]++
  }

  const parts: string[] = []
  if (counts.critical > 0) parts.push(`${counts.critical} critical`)
  if (counts.major > 0) parts.push(`${counts.major} major`)
  if (counts.minor > 0) parts.push(`${counts.minor} minor`)
  if (counts.suggestion > 0) parts.push(`${counts.suggestion} suggestion${counts.suggestion > 1 ? 's' : ''}`)

  const summary = `${comments.length} review comment${comments.length > 1 ? 's' : ''}: ${parts.join(', ')}. ${affectedFiles.length} file${affectedFiles.length !== 1 ? 's' : ''} affected.`

  return { summary, affectedFiles, issues }
}

// ---------------------------------------------------------------------------
// Fix prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a prompt instructing the agent to address review feedback.
 */
export function buildReviewFixPrompt(feedback: ReviewFeedback, attempt: number): string {
  const lines: string[] = [
    `## Address Review Feedback (attempt ${attempt})`,
    '',
    feedback.summary,
    '',
  ]

  if (feedback.affectedFiles.length > 0) {
    lines.push('### Affected Files', '')
    for (const f of feedback.affectedFiles) {
      lines.push(`- \`${f}\``)
    }
    lines.push('')
  }

  // Group issues by severity, critical first
  const severityOrder: Array<ReviewIssue['severity']> = ['critical', 'major', 'minor', 'suggestion']
  for (const sev of severityOrder) {
    const matching = feedback.issues.filter((i) => i.severity === sev)
    if (matching.length === 0) continue

    lines.push(`### ${sev.charAt(0).toUpperCase() + sev.slice(1)} Issues`, '')
    for (const issue of matching) {
      const loc = issue.file ? ` (\`${issue.file}\`${issue.line != null ? `:${issue.line}` : ''})` : ''
      lines.push(`- ${issue.description}${loc}`)
    }
    lines.push('')
  }

  lines.push('Address all critical and major issues. Fix minor issues where possible. Suggestions are optional.')

  return lines.join('\n')
}
