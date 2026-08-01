import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  selectPartialRestoreArtifacts,
  turboCacheArguments,
} from '../qualify-build-cache-artifacts.mjs'

test('uses write-only cold cache admission and read/write restore admission', () => {
  assert.deepEqual(
    turboCacheArguments({ cacheDir: '/tmp/cache', mode: 'local', writeOnly: true }),
    [
      'turbo',
      'run',
      'build',
      '--output-logs=hash-only',
      '--cache=local:w',
      '--cache-dir=/tmp/cache',
    ],
  )
  assert.equal(
    turboCacheArguments({ mode: 'remote', writeOnly: false })
      .includes('--cache=remote:rw'),
    true,
  )
})

test('partial restore removes JavaScript, declarations, and the manifest together', () => {
  assert.deepEqual(
    selectPartialRestoreArtifacts([
      { path: 'index.js' },
      { path: 'index.js.map' },
      { path: 'index.d.ts' },
    ]),
    ['index.js', 'index.d.ts', '.dzup-build-artifacts.json'],
  )
  assert.throws(
    () => selectPartialRestoreArtifacts([{ path: 'index.js' }]),
    /must produce JavaScript and declarations/,
  )
})
