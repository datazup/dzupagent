import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import {
  collectTerminalToolEventGuardViolations,
  formatTerminalToolEventGuardReport,
} from '../check-terminal-tool-event-guards.mjs'

function createTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-tool-guard-'))
  mkdirSync(join(dir, 'packages', 'demo', 'src'), { recursive: true })
  return dir
}

test('passes when tool:result emission is guarded and includes executionRunId', () => {
  const dir = createTempRepo()
  try {
    writeFileSync(
      join(dir, 'packages', 'demo', 'src', 'valid.ts'),
      `
import { requireTerminalToolExecutionRunId } from '@dzupagent/core'

const executionRunId = requireTerminalToolExecutionRunId({
  eventType: 'tool:result',
  toolName: 'read_file',
  executionRunId: runId,
})

bus.emit({
  type: 'tool:result',
  toolName: 'read_file',
  durationMs: 1,
  executionRunId,
})
      `.trim(),
      'utf8',
    )

    const violations = collectTerminalToolEventGuardViolations({
      repoRoot: dir,
      searchRoot: 'packages',
      ignoredFiles: new Set(),
    })

    assert.equal(violations.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails when tool:error emission skips guard and executionRunId', () => {
  const dir = createTempRepo()
  try {
    writeFileSync(
      join(dir, 'packages', 'demo', 'src', 'invalid.ts'),
      `
bus.emit({
  type: 'tool:error',
  toolName: 'write_file',
  errorCode: 'TOOL_EXECUTION_FAILED',
  message: 'denied',
})
      `.trim(),
      'utf8',
    )

    const violations = collectTerminalToolEventGuardViolations({
      repoRoot: dir,
      searchRoot: 'packages',
      ignoredFiles: new Set(),
    })

    assert.equal(violations.length, 1)
    assert.equal(violations[0].eventType, 'tool:error')
    assert.equal(
      violations[0].reasons.includes('missing requireTerminalToolExecutionRunId guard for tool:error'),
      true,
    )
    assert.equal(
      violations[0].reasons.includes('missing executionRunId on emitted tool:error payload'),
      true,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('report formatter includes violation details', () => {
  const report = formatTerminalToolEventGuardReport([
    {
      file: 'packages/demo/src/invalid.ts',
      line: 12,
      eventType: 'tool:result',
      reasons: ['missing requireTerminalToolExecutionRunId guard for tool:result'],
    },
  ])

  assert.match(report, /TERMINAL TOOL-EVENT GUARD VIOLATIONS DETECTED/)
  assert.match(report, /packages\/demo\/src\/invalid\.ts:12/)
  assert.match(report, /tool:result/)
})
