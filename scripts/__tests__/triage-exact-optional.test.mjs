import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classify,
  detectIndexedAccessCast,
  extractTypeBody,
  extractUndefinedProps,
  parseArgs,
} from '../triage-exact-optional.mjs'

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

// ---------------------------------------------------------------------------
// Parser bugs found 2026-08-02. Together these made 14 of 19 UNCLEAR agent
// rows unclassifiable — every one of them a TS2375.
// ---------------------------------------------------------------------------

const TS2375_NESTED_EMPTY_OBJECT =
  "Type '{ nodeId: string; output: {}; durationMs: number; error: string | undefined; }' " +
  "is not assignable to type 'NodeResult' with 'exactOptionalPropertyTypes: true'."

test('extractTypeBody matches the capital-T form TS2375 uses', () => {
  // TS2379 says "Argument of type '{...}'" (lowercase, mid-sentence); TS2375
  // says "Type '{...}' is not assignable" — sentence-initial capital. A
  // case-sensitive /type '\{/ matched none of the TS2375 corpus.
  const body = extractTypeBody(TS2375_NESTED_EMPTY_OBJECT)

  assert.ok(body !== null, 'capital-T messages must parse')
  assert.match(body, /error: string \| undefined/)
})

test('extractTypeBody brace-matches instead of stopping at the first close', () => {
  // A non-greedy (.+?)\} truncates at `output: {}`, dropping the `error` prop
  // that actually caused the error.
  const body = extractTypeBody(TS2375_NESTED_EMPTY_OBJECT)

  assert.match(body, /durationMs/, 'props after a nested {} must survive')
  assert.match(body, /error/)
})

test('extractTypeBody returns null for a truncated (unbalanced) type', () => {
  // tsc elides very long types. Half a type would misclassify the row, so it
  // must read as unparseable rather than as a short one.
  assert.equal(extractTypeBody("Type '{ a: string; b: { c: number; ' is not assignable"), null)
})

test('extractTypeBody returns null when the message carries no object literal', () => {
  assert.equal(
    extractTypeBody("Type 'PipelineStuckDetector | undefined' is not assignable"),
    null
  )
})

test('a multi-line return whose props are optional classifies as OMIT_KEY', () => {
  // The row reads `return {` on its own line, so the source-line heuristic sees
  // nothing; the verdict has to come from the message.
  const verdict = classify({ message: TS2375_NESTED_EMPTY_OBJECT, sourceLine: 'return {' })

  assert.equal(verdict.verdict, 'OMIT_KEY')
  assert.deepEqual(verdict.props, ['error'])
})

// ---------------------------------------------------------------------------
// NARROW_CAST — the third fix, added 2026-08-02.
// ---------------------------------------------------------------------------

test('detects an indexed-access cast into an optional property', () => {
  const hit = detectIndexedAccessCast(
    'pipelineConfig.stuckDetector = d as unknown as PipelineRuntimeConfig[\'stuckDetector\']'
  )

  assert.deepEqual(hit, { type: 'PipelineRuntimeConfig', prop: 'stuckDetector' })
})

test('detects the double-quoted form too', () => {
  const hit = detectIndexedAccessCast('store as unknown as TeamRuntimeMemoryService["store"]')

  assert.deepEqual(hit, { type: 'TeamRuntimeMemoryService', prop: 'store' })
})

test('an already-wrapped NonNullable cast is not re-flagged', () => {
  // Otherwise the fix would be re-proposed on every subsequent run.
  assert.equal(
    detectIndexedAccessCast('store as unknown as NonNullable<TeamRuntimeMemoryService["store"]>'),
    null
  )
})

test('an ordinary cast without an indexed access is not flagged', () => {
  assert.equal(detectIndexedAccessCast('value as unknown as SomeType'), null)
  assert.equal(detectIndexedAccessCast('const x = arr[0]'), null)
})

test('NARROW_CAST outranks the property heuristics for a cast row', () => {
  // The message names the indexed access as the source type, which the prop
  // heuristics would otherwise read as an ordinary widening.
  const verdict = classify({
    message:
      "Type 'PipelineStuckDetector | undefined' is not assignable to type " +
      "'PipelineStuckDetector' with 'exactOptionalPropertyTypes: true'.",
    sourceLine: "pipelineConfig.stuckDetector = d as unknown as PipelineRuntimeConfig['stuckDetector']",
  })

  assert.equal(verdict.verdict, 'NARROW_CAST')
  assert.equal(verdict.confidence, 'high')
  assert.deepEqual(verdict.props, ['stuckDetector'])
})
