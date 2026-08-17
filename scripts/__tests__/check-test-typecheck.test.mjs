import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  describeScope,
  parseArgs,
  parseBlamePorcelain,
  summarizeBlame,
} from '../check-test-typecheck.mjs'

const SCRIPT = fileURLToPath(new URL('../check-test-typecheck.mjs', import.meta.url))

// Generous relative to a ~30ms import, far below the ~86s a full 18-package
// typecheck takes, so a regressed entry guard is a timeout kill rather than a
// slow pass.
const SPAWN_TIMEOUT_MS = 25_000

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

// --- argument parsing -----------------------------------------------------
//
// These exist because the permissive version of this parser caused real damage.
// `--only <pkg>` reads as a scoping flag and does not exist; unrecognised
// arguments were dropped, so the run measured every package while its operator
// believed it measured one. With --update-baseline that rewrote every package's
// budget from a measurement taken while sibling packages were mid-edit.

test('an unrecognised scoping flag is rejected instead of silently widening the run', () => {
  const { error, options } = parseArgs(['--only', 'core', '--update-baseline'])

  assert.equal(options, undefined, 'a rejected argv yields no options to act on')
  assert.match(error, /unrecognised argument/)
  assert.match(error, /--only core/, 'the error quotes what was actually passed')
  assert.match(error, /--package/, 'and names the flag that does exist')
})

test('--package with no value is rejected rather than falling back to every package', () => {
  // The old parser read args[index + 1] and got undefined, which is falsy and so
  // indistinguishable from "no --package given" — the run widened to all 18.
  const { error } = parseArgs(['--package'])

  assert.match(error, /requires a package name/)
})

test('--package followed by another flag is rejected, not treated as the package name', () => {
  const { error } = parseArgs(['--package', '--report-only'])

  assert.match(error, /requires a package name/)
})

test('a repeated --package is rejected because only the first was ever honoured', () => {
  // indexOf() found the first occurrence, so `--package core --package memory`
  // measured core and silently discarded memory.
  const { error } = parseArgs(['--package', 'core', '--package', 'memory'])

  assert.match(error, /more than once/)
})

test('the documented flags parse to their options', () => {
  const { error, options } = parseArgs([
    '--package',
    'core',
    '--report-only',
    '--no-blame',
    '--update-baseline',
  ])

  assert.equal(error, undefined)
  assert.deepEqual(options, {
    reportOnly: true,
    updateBaseline: true,
    noBlame: true,
    onlyPackage: 'core',
  })
})

test('no arguments means the enforcing whole-workspace run', () => {
  const { error, options } = parseArgs([])

  assert.equal(error, undefined)
  assert.equal(options.onlyPackage, null, 'null, not undefined — scope is explicit')
  assert.deepEqual(
    [options.reportOnly, options.updateBaseline, options.noBlame],
    [false, false, false]
  )
})

test('scope is described by what was measured, not by the baseline file size', () => {
  // --update-baseline used to report Object.keys(merged).length, so a correctly
  // scoped single-package update announced "across 18 packages" — identical to
  // the accident the message should have exposed.
  assert.equal(describeScope(['core'], 'core'), '1 package (core)')
  assert.match(describeScope(['a', 'b', 'c'], null), /all 3 enrolled packages/)
})

// --- process-level behaviour ----------------------------------------------

test('invoking the script directly with a bad flag exits non-zero before any typecheck', () => {
  // Also the positive half of the entry-guard contract: main() must still run
  // when this file IS the entry point. It returns fast because parseArgs
  // rejects before a single tsc is spawned.
  const result = spawnSync(process.execPath, [SCRIPT, '--only', 'core'], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  })

  assert.equal(result.signal, null, 'rejection must not depend on running the typecheck')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unrecognised argument/)
})

test('importing the module does not run the guard', () => {
  // Regression: main() was called at module scope, so loading this file for its
  // unit tests executed the whole 18-package typecheck — 86s for 8 tests whose
  // own durations totalled under 2ms. Worse, main() sets process.exitCode on a
  // real regression, so `yarn test:scripts` would have gone red for a typecheck
  // failure that has nothing to do with any script test.
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT)}); console.log('OK')`],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS }
  )

  assert.equal(result.signal, null, 'a timeout kill here means the guard ran on import')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /OK/)
})
