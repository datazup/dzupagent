import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classify, extractUndefinedProps, parseArgs } from '../triage-exact-optional.mjs'

const DELEGATION_TIMEOUT =
  "Argument of type '{ timeoutMs: undefined; }' is not assignable to parameter of type " +
  "'Partial<DelegationRequest>' with 'exactOptionalPropertyTypes: true'."

const SPREAD_TOKEN_USAGE =
  "Argument of type '{ status: \"completed\"; output: unknown; completedAt: Date; " +
  "tokenUsage: { input: number; output: number; } | undefined; }' is not assignable to " +
  "parameter of type 'Partial<Run>' with 'exactOptionalPropertyTypes: true'."

test('extractUndefinedProps separates literal undefined from merely-optional', () => {
  const { explicit } = extractUndefinedProps(DELEGATION_TIMEOUT)
  assert.deepEqual(explicit, ['timeoutMs'])

  // `T | undefined` is NOT a literal undefined. Conflating the two is exactly
  // what made a blanket widening pass relax genuinely-required keys (211 -> 246).
  const spread = extractUndefinedProps(SPREAD_TOKEN_USAGE)
  assert.deepEqual(spread.explicit, [])
})

test('extractUndefinedProps does not split on semicolons inside nested types', () => {
  // The nested object literal contains ';' only at depth > 0, so tokenUsage
  // must survive as one property rather than being torn into fragments.
  const { all } = extractUndefinedProps(SPREAD_TOKEN_USAGE)
  assert.ok(
    all.some((p) => p.startsWith('tokenUsage')),
    `expected an intact tokenUsage property, got: ${JSON.stringify(all)}`
  )
})

test('classify returns WIDEN_PARAM when the site writes the literal undefined', () => {
  const r = classify({
    message: DELEGATION_TIMEOUT,
    sourceLine: 'makeRequest({ timeoutMs: undefined }),',
  })
  assert.equal(r.verdict, 'WIDEN_PARAM')
  assert.equal(r.confidence, 'high')
  assert.deepEqual(r.props, ['timeoutMs'])
})

test('classify downgrades confidence when the literal is not on the reported line', () => {
  // Multi-line object literals report the call site, not the property line.
  const r = classify({ message: DELEGATION_TIMEOUT, sourceLine: 'const result = await run(' })
  assert.equal(r.verdict, 'WIDEN_PARAM')
  assert.equal(r.confidence, 'medium')
})

test('classify returns OMIT_KEY for an incidental T | undefined from a spread', () => {
  const r = classify({ message: SPREAD_TOKEN_USAGE, sourceLine: 'await store.update(id, {' })
  assert.equal(r.verdict, 'OMIT_KEY')
  assert.deepEqual(r.props, ['tokenUsage'])
})

test('classify declines rather than guessing when no property is attributable', () => {
  // The two fixes are opposite, so a confident wrong verdict is worse than none.
  const r = classify({
    message: "Type 'NodeResult' is not assignable with 'exactOptionalPropertyTypes: true'.",
    sourceLine: 'return {',
  })
  assert.equal(r.verdict, 'UNCLEAR')
  assert.equal(r.confidence, 'low')
})

test('parseArgs defaults to the agent package', () => {
  assert.equal(parseArgs([]).package, 'agent')
  assert.equal(parseArgs(['--package', 'core']).package, 'core')
  assert.equal(parseArgs(['--json']).json, true)
})
