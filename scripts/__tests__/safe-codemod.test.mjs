import assert from 'node:assert/strict'
import { test } from 'node:test'

import { diffErrors, parseArgs } from '../safe-codemod.mjs'

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
