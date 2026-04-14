/**
 * Scorecard reporter — renders a ScorecardReport in multiple formats:
 * - Console (human-readable, with ANSI colors)
 * - Markdown (for docs/CI artifacts)
 * - JSON (for programmatic consumption)
 */
import type { ScorecardReport, ScorecardCategory, ScorecardCheck, Recommendation, Grade, CheckStatus } from './integration-scorecard.js'

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const WHITE = '\x1b[37m'

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'pass': return `${GREEN}[PASS]${RESET}`
    case 'warn': return `${YELLOW}[WARN]${RESET}`
    case 'fail': return `${RED}[FAIL]${RESET}`
    case 'skip': return `${DIM}[SKIP]${RESET}`
  }
}

function gradeColor(grade: Grade): string {
  switch (grade) {
    case 'A': return GREEN
    case 'B': return CYAN
    case 'C': return YELLOW
    case 'D': return YELLOW
    case 'F': return RED
  }
}

function priorityColor(priority: string): string {
  switch (priority) {
    case 'critical': return RED
    case 'high': return YELLOW
    case 'medium': return CYAN
    case 'low': return DIM
    default: return WHITE
  }
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 5)
  const empty = 20 - filled
  const color = score >= 80 ? GREEN : score >= 60 ? YELLOW : RED
  return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}${RESET} ${score}`
}

// ---------------------------------------------------------------------------
// Console format
// ---------------------------------------------------------------------------

function renderCheckConsole(check: ScorecardCheck): string {
  return `  ${statusIcon(check.status)} ${check.name}: ${check.message}`
}

function renderCategoryConsole(cat: ScorecardCategory): string {
  const lines: string[] = []
  const weightPct = Math.round(cat.weight * 100)
  lines.push(`${BOLD}${cat.name}${RESET} (weight: ${weightPct}%)  ${scoreBar(cat.score)}`)
  for (const check of cat.checks) {
    lines.push(renderCheckConsole(check))
  }
  return lines.join('\n')
}

function renderRecommendationConsole(rec: Recommendation): string {
  const color = priorityColor(rec.priority)
  return `  ${color}[${rec.priority.toUpperCase()}]${RESET} ${rec.category}: ${rec.action}`
}

export function formatConsole(report: ScorecardReport): string {
  const lines: string[] = []

  lines.push('')
  lines.push(`${BOLD}=== DzupAgent Integration Scorecard ===${RESET}`)
  lines.push(`Generated: ${report.generatedAt.toISOString()}`)
  lines.push('')

  // Overall grade
  const gc = gradeColor(report.grade)
  lines.push(`${BOLD}Overall Score:${RESET} ${gc}${report.overallScore}/100  Grade: ${report.grade}${RESET}`)
  lines.push('')

  // Categories
  for (const cat of report.categories) {
    lines.push(renderCategoryConsole(cat))
    lines.push('')
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push(`${BOLD}Recommendations:${RESET}`)
    for (const rec of report.recommendations) {
      lines.push(renderRecommendationConsole(rec))
    }
    lines.push('')
  } else {
    lines.push(`${GREEN}${BOLD}No recommendations — all checks passed!${RESET}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Markdown format
// ---------------------------------------------------------------------------

function statusEmoji(status: CheckStatus): string {
  switch (status) {
    case 'pass': return 'PASS'
    case 'warn': return 'WARN'
    case 'fail': return 'FAIL'
    case 'skip': return 'SKIP'
  }
}

function renderCheckMarkdown(check: ScorecardCheck): string {
  return `| ${statusEmoji(check.status)} | ${check.name} | ${check.score} | ${check.message} |`
}

function renderCategoryMarkdown(cat: ScorecardCategory): string {
  const lines: string[] = []
  const weightPct = Math.round(cat.weight * 100)
  lines.push(`### ${cat.name} (${cat.score}/100, weight: ${weightPct}%)`)
  lines.push('')
  lines.push('| Status | Check | Score | Message |')
  lines.push('|--------|-------|-------|---------|')
  for (const check of cat.checks) {
    lines.push(renderCheckMarkdown(check))
  }
  return lines.join('\n')
}

export function formatMarkdown(report: ScorecardReport): string {
  const lines: string[] = []

  lines.push('# DzupAgent Integration Scorecard')
  lines.push('')
  lines.push(`**Generated:** ${report.generatedAt.toISOString()}`)
  lines.push('')
  lines.push(`**Overall Score:** ${report.overallScore}/100 | **Grade:** ${report.grade}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const cat of report.categories) {
    lines.push(renderCategoryMarkdown(cat))
    lines.push('')
  }

  if (report.recommendations.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## Recommendations')
    lines.push('')
    lines.push('| Priority | Category | Action |')
    lines.push('|----------|----------|--------|')
    for (const rec of report.recommendations) {
      lines.push(`| ${rec.priority.toUpperCase()} | ${rec.category} | ${rec.action} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

export function formatJSON(report: ScorecardReport): string {
  return JSON.stringify(report, (_key, value: unknown) => {
    if (value instanceof Date) {
      return (value as Date).toISOString()
    }
    return value
  }, 2)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ScorecardFormat = 'console' | 'markdown' | 'json'

export class ScorecardReporter {
  private readonly report: ScorecardReport

  constructor(report: ScorecardReport) {
    this.report = report
  }

  /** Render the report in the specified format. */
  render(format: ScorecardFormat): string {
    switch (format) {
      case 'console':
        return formatConsole(this.report)
      case 'markdown':
        return formatMarkdown(this.report)
      case 'json':
        return formatJSON(this.report)
    }
  }
}
