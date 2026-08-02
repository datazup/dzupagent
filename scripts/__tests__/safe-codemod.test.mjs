import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  diffErrors,
  findPriorRejects,
  formatRejectEntry,
  normalizeRunKey,
  parseArgs,
  parseRejectLog,
} from '../safe-codemod.mjs'

function err(file, code, message) {
  return { file, code, message, key: `${file}|${code}|${message}` }
}

test('accepts a transform that only removes errors', () => {
  const before = [err('a.ts', 'TS2379', 'x'), err('b.ts', 'TS2375', 'y')]
  const after = [err('b.ts', 'TS2375', 'y')]

  const result = diffErrors(before, after)

  assert.equal(result.introduced.length, 0)
  assert.equal(result.fixed.length, 1)
  assert.equal(result.improved, true)
})

test('rejects the net-zero relocation that a total-only check would miss', () => {
  // The real 2026-07-30 failure: a correct TestOverrides<T> utility moved 40
  // errors from call sites into helper returns. Count unchanged, so a
  // total-based gate reads it as harmless.
  const before = [err('call-site.ts', 'TS2379', 'x'), err('call-site.ts', 'TS2379', 'x')]
  const after = [err('helper.ts', 'TS2322', 'z'), err('helper.ts', 'TS2322', 'z')]

  const result = diffErrors(before, after)

  assert.equal(result.totalBefore, result.totalAfter, 'total is unchanged by design')
  assert.equal(result.introduced.length, 1)
  assert.equal(result.improved, false)
})

test('rejects a transform that lowers the total but introduces a new error', () => {
  // Blanket widening: fixes three exactOptional errors, relaxes a required key
  // and breaks something else. Net -2 looks like progress on a counter.
  const before = [
    err('a.ts', 'TS2379', 'x'),
    err('a.ts', 'TS2379', 'x'),
    err('a.ts', 'TS2379', 'x'),
  ]
  const after = [err('a.ts', 'TS2741', 'missing required property')]

  const result = diffErrors(before, after)

  assert.ok(result.totalAfter < result.totalBefore, 'total dropped')
  assert.equal(result.introduced.length, 1, 'but a new error appeared')
  assert.equal(result.improved, false)
})

test('treats a no-op transform as not improved', () => {
  const before = [err('a.ts', 'TS2379', 'x')]
  const after = [err('a.ts', 'TS2379', 'x')]

  const result = diffErrors(before, after)

  assert.equal(result.introduced.length, 0)
  assert.equal(result.fixed.length, 0)
  assert.equal(result.improved, false)
})

test('counts duplicate identical errors rather than deduplicating them', () => {
  // Three identical errors in one file dropping to two is real progress; a Set
  // would collapse them and report no change at all.
  const before = [
    err('a.ts', 'TS2379', 'x'),
    err('a.ts', 'TS2379', 'x'),
    err('a.ts', 'TS2379', 'x'),
  ]
  const after = [err('a.ts', 'TS2379', 'x'), err('a.ts', 'TS2379', 'x')]

  const result = diffErrors(before, after)

  assert.equal(result.fixed.length, 1)
  assert.equal(result.fixed[0].was, 3)
  assert.equal(result.fixed[0].now, 2)
  assert.equal(result.improved, true)
})

test('flags a growing duplicate count as introduced', () => {
  const before = [err('a.ts', 'TS2379', 'x')]
  const after = [err('a.ts', 'TS2379', 'x'), err('a.ts', 'TS2379', 'x')]

  const result = diffErrors(before, after)

  assert.equal(result.introduced.length, 1)
  assert.equal(result.introduced[0].was, 1)
  assert.equal(result.introduced[0].now, 2)
  assert.equal(result.improved, false)
})

test("parseArgs defaults to the agent package so existing invocations are unchanged", () => {
  const a = parseArgs([])
  assert.equal(a.package, "agent")
  assert.equal(a.target, "packages/agent/src")
})

test("parseArgs derives the revert target from --package", () => {
  assert.equal(parseArgs(["--package", "core"]).target, "packages/core/src")
})

test("parseArgs lets --target narrow the revert scope below the package root", () => {
  // The target is what git checkout reverts, so a narrower target keeps the
  // revert away from unrelated edits elsewhere in the same package.
  const a = parseArgs(["--package", "core", "--target", "packages/core/src/memory"])
  assert.equal(a.target, "packages/core/src/memory")
})

// ---------------------------------------------------------------------------
// Reject log. Added 2026-08-02 after two of five transform attempts in one
// session re-derived failures already recorded in a memory note nobody
// re-read — each retry costing a full ~3 min typecheck cycle.
// ---------------------------------------------------------------------------

test('run keys ignore whitespace so a reformatted command still matches', () => {
  assert.equal(
    normalizeRunKey('node  x.mjs   --flag'),
    normalizeRunKey('node x.mjs --flag')
  )
  assert.equal(normalizeRunKey('  node x.mjs\n'), 'node x.mjs')
})

test('an empty run key never matches, so a blank command recalls nothing', () => {
  // Otherwise every --baseline-only run would collide under the key "".
  const rows = [{ runKey: '', reason: 'x' }]
  assert.deepEqual(findPriorRejects(rows, ''), [])
  assert.deepEqual(findPriorRejects(rows, undefined), [])
})

test('recalls a prior rejection of the same transform', () => {
  const rows = [
    { runKey: 'node a.mjs', reason: 'introduced new errors' },
    { runKey: 'node b.mjs', reason: 'no-op' },
    { runKey: 'node a.mjs', reason: 'no-op' },
  ]

  const hits = findPriorRejects(rows, 'node   a.mjs')

  assert.equal(hits.length, 2, 'both prior attempts recalled, whitespace-insensitively')
})

test('a truncated final line does not blind recall to the entries above it', () => {
  // An interrupted run can leave a half-written line; the earlier lessons must
  // still be readable.
  const contents = '{"runKey":"node a.mjs","reason":"introduced new errors"}\n{"runKey":"node b'

  const rows = parseRejectLog(contents)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].runKey, 'node a.mjs')
})

test('parseRejectLog tolerates blank lines and empty input', () => {
  assert.deepEqual(parseRejectLog(''), [])
  assert.deepEqual(parseRejectLog('\n\n'), [])
})

test('a reject entry records the counts and a bounded sample of new errors', () => {
  const result = {
    totalBefore: 205,
    totalAfter: 203,
    fixed: [{ key: 'a.ts|TS2379|x' }],
    introduced: Array.from({ length: 40 }, (_, i) => ({
      key: `f${i}.ts|TS2322|boom ${i}`,
      was: 0,
      now: 1,
    })),
  }

  const entry = formatRejectEntry({
    run: 'node t.mjs',
    pkg: 'agent',
    target: 'packages/agent/src',
    reason: 'introduced new errors',
    result,
    timestamp: '2026-08-02T00:00:00.000Z',
  })

  assert.equal(entry.totalBefore, 205)
  assert.equal(entry.totalAfter, 203, 'a LOWER total is still a rejection — recorded as such')
  assert.equal(entry.fixed, 1)
  assert.equal(entry.introducedTotal, 40, 'the true count is kept')
  assert.equal(entry.introduced.length, 5, 'but the sample is bounded for readability')
  assert.equal(entry.introduced[0].file, 'f0.ts')
  assert.equal(entry.introduced[0].code, 'TS2322')
})

test('a crashed codemod is recorded even though there is no error diff', () => {
  const entry = formatRejectEntry({
    run: 'node broken.mjs',
    pkg: 'agent',
    target: 'packages/agent/src',
    reason: 'codemod exited 1',
    result: null,
    timestamp: '2026-08-02T00:00:00.000Z',
  })

  assert.equal(entry.reason, 'codemod exited 1')
  assert.equal(entry.introducedTotal, 0)
  assert.deepEqual(entry.introduced, [])
  assert.equal(entry.totalBefore, null)
})

test('entries serialize to a single JSONL line and round-trip', () => {
  // Multi-line JSON would corrupt the append-only format under concurrent runs.
  const entry = formatRejectEntry({
    run: 'node t.mjs',
    pkg: 'agent',
    target: 'packages/agent/src',
    reason: 'no-op',
    result: { totalBefore: 1, totalAfter: 1, fixed: [], introduced: [] },
    timestamp: '2026-08-02T00:00:00.000Z',
  })

  const line = JSON.stringify(entry)

  assert.equal(line.includes('\n'), false)
  assert.deepEqual(parseRejectLog(`${line}\n`)[0], entry)
})
