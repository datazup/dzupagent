import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { compareToBaseline, findDeadExports } from '../check-dead-exports.mjs'

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dead-exports-'))
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

test('flags a runtime export referenced only by its own file', () => {
  const root = fixture({
    'packages/a/package.json': JSON.stringify({ exports: { '.': { import: './dist/index.js' } } }),
    'packages/a/src/index.ts': "export { used } from './used.js'\n",
    'packages/a/src/used.ts': 'export function used() { return 1 }\n',
    'packages/a/src/internal.ts': 'export function lonely() { return 2 }\nexport class Orphan {}\nexport interface OnlyType { a: 1 }\n',
  })
  try {
    assert.deepEqual(findDeadExports({ root }), [
      'packages/a/src/internal.ts#Orphan',
      'packages/a/src/internal.ts#lonely',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('treats files reached through export * from a package entry as published', () => {
  const root = fixture({
    'packages/a/package.json': JSON.stringify({ exports: { './sub': { import: './dist/sub.js' } } }),
    'packages/a/src/sub.ts': "export * from './deep/barrel.js'\n",
    'packages/a/src/deep/barrel.ts': "export * from './leaf.js'\n",
    'packages/a/src/deep/leaf.ts': 'export const publicOnly = 1\n',
  })
  try {
    assert.deepEqual(findDeadExports({ root }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ignores test files and counts test references as use', () => {
  const root = fixture({
    'packages/a/package.json': '{}',
    'packages/a/src/thing.ts': 'export function covered() {}\n',
    'packages/a/src/__tests__/thing.test.ts': "import { covered } from '../thing.js'\nexport const helper = covered\n",
  })
  try {
    assert.deepEqual(findDeadExports({ root }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('compareToBaseline separates new dead exports from stale entries', () => {
  assert.deepEqual(compareToBaseline(['a#x', 'b#y'], ['b#y', 'c#z']), {
    added: ['a#x'],
    stale: ['c#z'],
  })
})
