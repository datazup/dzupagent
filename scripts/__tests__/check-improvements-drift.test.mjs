import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import { evaluateImprovementDrift } from '../check-improvements-drift.mjs'

function writeText(root, pathname, content) {
  const filePath = join(root, pathname)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content)
}

function writeBaseDocs(root, {
  qwenStatus,
  crushStatus,
  planStatus,
  qwenSource = '',
  crushSource = '',
  strictStatus = 'done',
  trackerStatus = 'done',
} = {}) {
  writeText(root, 'improvements/CORE_AGENT_ADAPTERS_IMPROVEMENTS.md', `
# Adapter maturity

| Finding | Status | Evidence |
|---|---|---|
| Qwen adapter maturity | ${qwenStatus} | qwen evidence |
| Crush adapter maturity | ${crushStatus} | crush evidence |
`.trimStart())

  writeText(root, 'improvements/CORE_AGENT_ADAPTERS_IMPLEMENTATION_PLAN.md', `
# Implementation plan

| Planned Work | Status | Notes |
|---|---|---|
| Phase 2.2 migrate Gemini/Qwen/Crush | ${planStatus} | plan evidence |
`.trimStart())

  writeText(root, 'improvements/TEST.md', `
# TEST

| Check | Status | Evidence |
|---|---|---|
| Strict verification gate (\`verify:strict\`) | ${strictStatus} | strict evidence |
`.trimStart())

  writeText(root, 'improvements/CONSOLIDATED_IMPLEMENTATION_TRACKER.md', `
# Tracker

### P2-04: Improvement-doc drift CI check

Status: \`${trackerStatus}\`
`.trimStart())

  writeText(root, 'packages/agent-adapters/src/qwen/qwen-adapter.ts', qwenSource)
  writeText(root, 'packages/agent-adapters/src/crush/crush-adapter.ts', crushSource)
  writeText(root, 'scripts/check-improvements-drift.mjs', '// present for tracker validation\n')
}

test('evaluates Qwen and Crush markers independently', () => {
  const root = mkdtempSync(join(tmpdir(), 'dzupagent-drift-test-'))
  try {
    writeBaseDocs(root, {
      qwenStatus: 'partially done',
      crushStatus: 'partially done',
      planStatus: 'partially done',
      qwenSource: '// TODO: qwen marker still present\n',
      crushSource: '// crush adapter is clean\n',
    })

    const report = evaluateImprovementDrift({
      root,
      runStrictInventoryGateImpl: () => ({ passed: true, output: '' }),
    })

    const findingIds = report.activeFindings.map((finding) => finding.id)
    assert.ok(findingIds.includes('adapter-maturity-crush'))
    assert.ok(findingIds.includes('adapter-maturity-plan-phase-2-2-crush'))
    assert.ok(!findingIds.includes('adapter-maturity-qwen'))
    assert.ok(!findingIds.includes('adapter-maturity-plan-phase-2-2-qwen'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('treats unknown maturity statuses as actionable findings', () => {
  const root = mkdtempSync(join(tmpdir(), 'dzupagent-drift-test-'))
  try {
    writeBaseDocs(root, {
      qwenStatus: 'under review',
      crushStatus: 'done',
      planStatus: 'done',
      qwenSource: '// clean qwen source\n',
      crushSource: '// clean crush source\n',
    })

    const report = evaluateImprovementDrift({
      root,
      runStrictInventoryGateImpl: () => ({ passed: true, output: '' }),
    })

    assert.equal(report.activeFindings.length, 1)
    assert.equal(report.activeFindings[0].id, 'adapter-maturity-qwen')
    assert.match(report.activeFindings[0].message, /unrecognized status/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
