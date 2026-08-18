import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizePublicApiSubpaths } from '../public-api-allowlist.mjs'

test('normalizes legacy strings as stable and preserves explicit lifecycles', () => {
  assert.deepEqual(
    normalizePublicApiSubpaths('@dzupagent/example', {
      './stable': ' stable facade ',
      './compat': {
        purpose: 'compatibility facade',
        lifecycle: 'deprecated-transitional',
      },
      './preview': {
        purpose: 'preview facade',
        lifecycle: 'experimental',
      },
    }),
    [
      {
        subpath: './stable',
        purpose: 'stable facade',
        lifecycle: 'stable',
      },
      {
        subpath: './compat',
        purpose: 'compatibility facade',
        lifecycle: 'deprecated-transitional',
      },
      {
        subpath: './preview',
        purpose: 'preview facade',
        lifecycle: 'experimental',
      },
    ],
  )
})

test('rejects malformed lifecycle objects and unknown fields', () => {
  assert.throws(
    () =>
      normalizePublicApiSubpaths('@dzupagent/example', {
        './compat': { purpose: '', lifecycle: 'deprecated-transitional' },
      }),
    /non-empty purpose/,
  )
  assert.throws(
    () =>
      normalizePublicApiSubpaths('@dzupagent/example', {
        './compat': {
          purpose: 'compatibility facade',
          lifecycle: 'deprecated-transitional',
          status: 'deprecated',
        },
      }),
    /unknown fields: status/,
  )
})
