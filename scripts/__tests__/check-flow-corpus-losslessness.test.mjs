import assert from 'node:assert/strict'
import { test } from 'node:test'

import { evaluateCorpusLosslessness } from '../check-flow-corpus-losslessness.mjs'

/**
 * The `minLossless` floor shipped in c4106906 but nothing passed it, so a
 * fidelity regression stayed silent. This suite pins the verdict logic of the
 * script that arms it.
 *
 * Every fixture below holds all dimensions ACCEPTING except the one under
 * test. Two guards that both reject prove neither, so `passed: true` and a
 * clean summary are held constant while only the round-trip counters move.
 */
function createReport({
  lossless = 26,
  total = 26,
  belowMinLossless = false,
  passed = true,
  items = [],
  summary = {
    total: 26,
    ready: 26,
    changesRequired: 0,
    invalid: 0,
    hashMismatches: 0,
    compileReady: 25,
    compileFailed: 0,
    authoringOnly: 1,
  },
} = {}) {
  return {
    passed,
    summary,
    roundTrip: {
      total,
      lossless,
      lossy: total - lossless,
      notReparsable: 0,
      unparsableSource: 0,
      minLossless: 26,
      belowMinLossless,
    },
    items,
  }
}

test('accepts a corpus that meets the floor', () => {
  const verdict = evaluateCorpusLosslessness(createReport(), 26)

  assert.equal(verdict.ok, true)
  assert.equal(verdict.code, 'OK')
  assert.match(verdict.message, /26\/26 lossless/)
})

test('rejects a round-trip regression below the floor', () => {
  // ONLY the round-trip counters move; admission stays green, so nothing but
  // the ratchet can produce this verdict.
  const verdict = evaluateCorpusLosslessness(
    createReport({
      lossless: 25,
      belowMinLossless: true,
      items: [
        {
          path: '28-sdlc-batch-validation.dzupflow.yaml',
          roundTripStatus: 'lossy',
          roundTripLossPaths: ['document.meta.fragmentExpansions'],
        },
      ],
    }),
    26,
  )

  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'ROUND_TRIP_REGRESSED')
  assert.match(verdict.message, /REGRESSED: 25\/26 lossless, floor is 26/)
  // The offending document must be named — a bare "regressed" is not
  // actionable when the corpus has 26 entries.
  assert.ok(
    verdict.details.some((d) =>
      d.includes('28-sdlc-batch-validation.dzupflow.yaml'),
    ),
    'expected the lossy document to be named in the details',
  )
  assert.ok(
    verdict.details.some((d) =>
      d.includes('document.meta.fragmentExpansions'),
    ),
    'expected the lost field path to be reported',
  )
})

test('reports a non-round-trip admission failure distinctly', () => {
  // Fidelity is fine; admission is not. This must NOT be reported as a
  // round-trip regression, or a hash drift would be misdiagnosed as a
  // formatter defect.
  const verdict = evaluateCorpusLosslessness(
    createReport({
      passed: false,
      summary: {
        total: 26,
        ready: 26,
        changesRequired: 0,
        invalid: 0,
        hashMismatches: 1,
        compileReady: 25,
        compileFailed: 0,
        authoringOnly: 1,
      },
    }),
    26,
  )

  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'QUALIFICATION_FAILED')
  assert.ok(verdict.details.some((d) => d.includes('hashMismatches')))
})

test('round-trip regression outranks a concurrent admission failure', () => {
  // Both are wrong at once. The fidelity verdict must win, because it names
  // the specific documents; QUALIFICATION_FAILED only prints a summary.
  const verdict = evaluateCorpusLosslessness(
    createReport({
      lossless: 20,
      belowMinLossless: true,
      passed: false,
      items: [
        {
          path: 'x.dzupflow.yaml',
          roundTripStatus: 'not-reparsable',
          roundTripLossPaths: [],
        },
      ],
    }),
    26,
  )

  assert.equal(verdict.code, 'ROUND_TRIP_REGRESSED')
})

test('a document with no recorded loss paths still names the file', () => {
  const verdict = evaluateCorpusLosslessness(
    createReport({
      lossless: 25,
      belowMinLossless: true,
      items: [
        {
          path: 'y.dzupflow.yaml',
          roundTripStatus: 'not-reparsable',
          roundTripLossPaths: [],
        },
      ],
    }),
    26,
  )

  assert.ok(verdict.details.some((d) => d.includes('y.dzupflow.yaml')))
  // No trailing "(lost: )" noise when there is nothing to list.
  assert.ok(!verdict.details.some((d) => d.includes('(lost: )')))
})

test('lossless items are omitted from the failure details', () => {
  // Printing all 26 rows on every failure buries the one that matters.
  const verdict = evaluateCorpusLosslessness(
    createReport({
      lossless: 25,
      belowMinLossless: true,
      items: [
        { path: 'good.yaml', roundTripStatus: 'lossless', roundTripLossPaths: [] },
        { path: 'bad.yaml', roundTripStatus: 'lossy', roundTripLossPaths: ['a'] },
      ],
    }),
    26,
  )

  assert.ok(verdict.details.some((d) => d.includes('bad.yaml')))
  assert.ok(!verdict.details.some((d) => d.includes('good.yaml')))
})
