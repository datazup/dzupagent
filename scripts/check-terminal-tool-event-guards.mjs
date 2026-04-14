/**
 * check-terminal-tool-event-guards.mjs
 *
 * Enforces that terminal tool lifecycle emissions (`tool:result`, `tool:error`)
 * are guarded by `requireTerminalToolExecutionRunId` and include
 * `executionRunId` on the emitted event payload.
 *
 * Usage:
 *   node scripts/check-terminal-tool-event-guards.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const DEFAULT_SEARCH_ROOT = 'packages'
const DEFAULT_IGNORED_FILES = new Set([
  'packages/core/src/events/event-types.ts',
])

const EVENT_MATCH_REGEX = /type:\s*['"]tool:(result|error)['"]/

function rg(args, cwd) {
  try {
    return execFileSync('rg', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return ''
    }
    throw error
  }
}

function parseRgLines(output) {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const first = line.indexOf(':')
      const second = line.indexOf(':', first + 1)
      if (first <= 0 || second <= first) return null

      const file = line.slice(0, first)
      const lineNum = Number(line.slice(first + 1, second))
      if (!Number.isFinite(lineNum) || lineNum <= 0) return null

      return {
        file,
        line: lineNum,
        text: line.slice(second + 1),
      }
    })
    .filter(Boolean)
}

function inferEventType(lineText) {
  const match = EVENT_MATCH_REGEX.exec(lineText)
  if (!match) return null
  return `tool:${match[1]}`
}

function hasGuardForEvent(windowText, eventType) {
  const guardRegex = new RegExp(
    `requireTerminalToolExecutionRunId\\s*\\(\\s*\\{[\\s\\S]*?eventType:\\s*['"]${eventType}['"]`,
    'm',
  )
  return guardRegex.test(windowText)
}

function hasExecutionRunIdProperty(lines, lineIndex) {
  const postWindow = lines.slice(lineIndex, lineIndex + 24).join('\n')
  return /executionRunId\s*[:,]/.test(postWindow)
}

export function collectTerminalToolEventGuardViolations(options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd()
  const searchRoot = options.searchRoot ?? DEFAULT_SEARCH_ROOT
  const ignoredFiles = options.ignoredFiles ?? DEFAULT_IGNORED_FILES

  const rgOutput = rg([
    '--line-number',
    '--no-heading',
    '--glob', '!**/__tests__/**',
    '--glob', '!**/*.test.*',
    '--glob', '!**/dist/**',
    '-e', "type:\\s*['\"]tool:(result|error)['\"]",
    searchRoot,
  ], repoRoot)

  const occurrences = parseRgLines(rgOutput)
  const violations = []
  const fileCache = new Map()

  for (const occurrence of occurrences) {
    const relFile = occurrence.file.replace(/\\/g, '/')
    if (ignoredFiles.has(relFile)) continue

    if (!fileCache.has(relFile)) {
      const abs = join(repoRoot, relFile)
      const content = readFileSync(abs, 'utf8')
      fileCache.set(relFile, content.split('\n'))
    }

    const lines = fileCache.get(relFile)
    const eventType = inferEventType(occurrence.text)
    if (!eventType) continue

    const lineIndex = occurrence.line - 1
    const windowStart = Math.max(0, lineIndex - 25)
    const windowEnd = Math.min(lines.length, lineIndex + 25)
    const windowText = lines.slice(windowStart, windowEnd).join('\n')

    const reasons = []
    if (!hasGuardForEvent(windowText, eventType)) {
      reasons.push(`missing requireTerminalToolExecutionRunId guard for ${eventType}`)
    }
    if (!hasExecutionRunIdProperty(lines, lineIndex)) {
      reasons.push(`missing executionRunId on emitted ${eventType} payload`)
    }

    if (reasons.length > 0) {
      violations.push({
        file: relFile,
        line: occurrence.line,
        eventType,
        reasons,
      })
    }
  }

  return violations
}

export function formatTerminalToolEventGuardReport(violations, repoRoot = process.cwd()) {
  if (violations.length === 0) {
    return 'Terminal tool-event guard check passed — all tool:result/tool:error emissions are guarded.'
  }

  const lines = []
  lines.push('TERMINAL TOOL-EVENT GUARD VIOLATIONS DETECTED')
  lines.push('=============================================')
  lines.push(
    'All runtime tool:result/tool:error emissions must use requireTerminalToolExecutionRunId and include executionRunId.',
  )
  lines.push('')

  for (const violation of violations) {
    lines.push(`  FILE:  ${relative(repoRoot, join(repoRoot, violation.file))}:${violation.line}`)
    lines.push(`  EVENT: ${violation.eventType}`)
    for (const reason of violation.reasons) {
      lines.push(`  - ${reason}`)
    }
    lines.push('')
  }

  lines.push('How to fix:')
  lines.push('  1. Resolve run id with requireTerminalToolExecutionRunId({...}).')
  lines.push('  2. Emit tool:result/tool:error with executionRunId set to the resolved value.')
  lines.push('  3. Add/adjust regression tests for missing-run-id failure path.')
  return lines.join('\n')
}

function main() {
  const violations = collectTerminalToolEventGuardViolations()
  if (violations.length === 0) {
    console.log(formatTerminalToolEventGuardReport(violations))
    process.exit(0)
  }

  console.error(formatTerminalToolEventGuardReport(violations))
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
