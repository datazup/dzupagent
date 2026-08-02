import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseBlamePorcelain, summarizeBlame } from '../check-test-typecheck.mjs'

function porcelain(sha, line, author, summary, code = '  const x = 1') {
  return [
    `${sha} ${line} ${line} 1`,
    `author ${author}`,
    'author-mail <someone@example.com>',
    'author-time 1785650000',
    'committer someone',
    `summary ${summary}`,
    'filename src/__tests__/a.test.ts',
    `\t${code}`,
  ].join('\n')
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

test('parses author and summary from line-porcelain blame', () => {
  const records = parseBlamePorcelain(porcelain(SHA_A, 12, 'ninel.hodzic', 'fix(agent): thing'))

  assert.equal(records.length, 1)
  assert.equal(records[0].sha, 'aaaaaaaa', 'sha is abbreviated to 8 chars')
  assert.equal(records[0].line, 12)
  assert.equal(records[0].author, 'ninel.hodzic')
  assert.equal(records[0].summary, 'fix(agent): thing')
})

test('a code line containing a blame-header-like prefix does not start a new record', () => {
  // The reason porcelain is used at all. The default blame format interleaves
  // the source line with metadata; a test fixture whose CONTENT looks like a
  // 40-hex header would be parsed as a second commit. Porcelain prefixes
  // content with a tab, so the header regex must not match it.
  const hostile = porcelain(SHA_A, 3, 'someone', 'subject', `${'f'.repeat(40)} 9 9`)

  const records = parseBlamePorcelain(hostile)

  assert.equal(records.length, 1, 'content that mimics a header is still content')
  assert.equal(records[0].sha, 'aaaaaaaa')
})

test('an author name containing brackets survives the parse', () => {
  const records = parseBlamePorcelain(porcelain(SHA_A, 1, 'Bot [automated] (ci)', 'chore: x'))

  assert.equal(records[0].author, 'Bot [automated] (ci)')
})

test('groups erroring lines by commit and sorts the heaviest contributor first', () => {
  const lines = [
    { sha: 'aaaaaaaa', author: 'daemon', summary: 'feat: big change' },
    { sha: 'bbbbbbbb', author: 'human', summary: 'chore: rename' },
    { sha: 'aaaaaaaa', author: 'daemon', summary: 'feat: big change' },
    { sha: 'aaaaaaaa', author: 'daemon', summary: 'feat: big change' },
  ]

  const summary = summarizeBlame(lines)

  assert.equal(summary.length, 2)
  assert.equal(summary[0].sha, 'aaaaaaaa')
  assert.equal(summary[0].lines, 3, 'the commit owning most erroring lines ranks first')
  assert.equal(summary[1].sha, 'bbbbbbbb')
  assert.equal(summary[1].lines, 1)
})

test('ties break deterministically so CI output is stable across runs', () => {
  const summary = summarizeBlame([
    { sha: 'bbbbbbbb', author: 'x', summary: 's' },
    { sha: 'aaaaaaaa', author: 'y', summary: 't' },
  ])

  assert.deepEqual(
    summary.map((c) => c.sha),
    ['aaaaaaaa', 'bbbbbbbb']
  )
})

test('entries without a sha are dropped rather than reported as "unknown commit"', () => {
  // blameFile() returns [] for untracked/new files; a partially parsed record
  // must not produce a blame line naming nobody, which reads as a real finding.
  const summary = summarizeBlame([null, {}, { sha: 'aaaaaaaa', author: 'a', summary: 's' }])

  assert.equal(summary.length, 1)
  assert.equal(summary[0].sha, 'aaaaaaaa')
})

test('a missing author or summary degrades to a placeholder, not undefined', () => {
  const summary = summarizeBlame([{ sha: 'aaaaaaaa' }])

  assert.equal(summary[0].author, 'unknown')
  assert.equal(summary[0].summary, '')
})

test('no blame input yields no attribution lines', () => {
  assert.deepEqual(summarizeBlame([]), [])
})
