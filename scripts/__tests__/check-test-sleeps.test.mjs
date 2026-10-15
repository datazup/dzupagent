import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { countSleepsInContent, findSleepCalls, loadBaseline } from '../check-test-sleeps.mjs'

/**
 * DZUPAGENT-TEST-H-07: check:test-sleeps had no self-test. Its line regex could
 * not see arrow-callback sleeps, a missing baseline meant "no limit", and
 * --update-baseline could raise the ceiling silently.
 */
const SCRIPT = fileURLToPath(new URL('../check-test-sleeps.mjs', import.meta.url))

function fixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'test-sleeps-'))
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return root
}

function run(root, extraArgs = [], baselineFile = join(root, 'baseline.json')) {
  return spawnSync(
    process.execPath,
    [SCRIPT, `--root=${root}`, `--baseline-file=${baselineFile}`, ...extraArgs],
    { encoding: 'utf8' },
  )
}

const SPEC = 'packages/alpha/src/__tests__/alpha.test.ts'

test('an arrow-callback sleep is counted', () => {
  const content = [
    "it('waits', async () => {",
    '  await new Promise<void>((r) => setTimeout(() => r(), 50))',
    '})',
  ].join('\n')
  assert.deepEqual(findSleepCalls(content), [{ line: 1, ms: 50 }])
  assert.equal(countSleepsInContent(content).count, 1)
})

test('the classic resolve form, a multi-line call and numeric separators are counted', () => {
  const content = [
    'await new Promise((resolve) => setTimeout(resolve, 20))',
    'setTimeout(',
    '  () => {',
    "    bus.emit({ type: 'x' })",
    '  },',
    '  1_000,',
    ')',
  ].join('\n')
  assert.deepEqual(findSleepCalls(content), [{ line: 0, ms: 20 }, { line: 1, ms: 1000 }])
})

test('short, non-literal, commented-out and sleep-ok delays are not counted', () => {
  const content = [
    'setTimeout(() => r(), 5)',
    'setTimeout(resolve, delayMs)',
    '// setTimeout(() => r(), 500)',
    "const s = 'setTimeout(() => r(), 500)'",
    'setTimeout(() => r(), 50) // sleep-ok: racing a real timer under test',
  ].join('\n')
  assert.equal(countSleepsInContent(content).count, 0)
})

test('a sleep under vi.useFakeTimers() is reported as fake, not counted', () => {
  const content = [
    "describe('x', () => {",
    '  beforeEach(() => { vi.useFakeTimers() })',
    "  it('y', async () => {",
    '    setTimeout(() => r(), 50)',
    '  })',
    '})',
  ].join('\n')
  assert.deepEqual(countSleepsInContent(content), { count: 0, fake: 1, fakeLines: [3] })
})

test('a missing baseline exits 1 instead of passing with no limit', () => {
  const root = fixtureRoot({ [SPEC]: 'setTimeout(() => r(), 50)\n' })
  try {
    assert.equal(loadBaseline(join(root, 'baseline.json')).ok, false)
    const result = run(root)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /baseline file .* is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the gate passes at or under the baseline and fails above it', () => {
  const root = fixtureRoot({ [SPEC]: 'setTimeout(() => r(), 50)\nsetTimeout(r, 20)\n' })
  try {
    writeFileSync(join(root, 'baseline.json'), JSON.stringify({ maxSleeps: 2 }))
    assert.equal(run(root).status, 0)
    writeFileSync(join(root, 'baseline.json'), JSON.stringify({ maxSleeps: 1 }))
    const over = run(root)
    assert.equal(over.status, 1)
    assert.match(over.stderr, /2 real-time sleeps exceeds baseline of 1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an upward --update-baseline without --allow-raise exits 1 and leaves the file alone', () => {
  const root = fixtureRoot({ [SPEC]: 'setTimeout(() => r(), 50)\nsetTimeout(r, 20)\n' })
  const baselineFile = join(root, 'baseline.json')
  try {
    writeFileSync(baselineFile, JSON.stringify({ maxSleeps: 1 }))
    const refused = run(root, ['--update-baseline'])
    assert.equal(refused.status, 1, refused.stdout + refused.stderr)
    assert.match(refused.stderr, /refusing to raise the baseline \(1 -> 2\) without --allow-raise/)
    assert.equal(JSON.parse(readFileSync(baselineFile, 'utf8')).maxSleeps, 1)

    const raised = run(root, ['--update-baseline', '--allow-raise'])
    assert.equal(raised.status, 0, raised.stdout + raised.stderr)
    assert.equal(JSON.parse(readFileSync(baselineFile, 'utf8')).maxSleeps, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a downward --update-baseline needs no flag, and creating a baseline needs --allow-raise', () => {
  const root = fixtureRoot({ [SPEC]: 'setTimeout(() => r(), 50)\n' })
  const baselineFile = join(root, 'baseline.json')
  try {
    const create = run(root, ['--update-baseline'])
    assert.equal(create.status, 1)
    assert.equal(existsSync(baselineFile), false)

    writeFileSync(baselineFile, JSON.stringify({ maxSleeps: 5 }))
    const lowered = run(root, ['--update-baseline'])
    assert.equal(lowered.status, 0, lowered.stdout + lowered.stderr)
    assert.equal(JSON.parse(readFileSync(baselineFile, 'utf8')).maxSleeps, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the checked-in baseline is present and readable', () => {
  const baseline = loadBaseline(fileURLToPath(new URL('../check-test-sleeps.baseline.json', import.meta.url)))
  assert.equal(baseline.ok, true)
})
