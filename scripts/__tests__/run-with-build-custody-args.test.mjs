/**
 * Argument parsing for run-with-build-custody.mjs.
 *
 * Regression cover for a break that made `yarn workspace <pkg> run build <flag>`
 * fail across every package whose `build` script uses `--shell` (40+ of them):
 * yarn appends user flags to the script it runs, so the wrapper received a third
 * argument and rejected it outright with "--shell requires exactly one command
 * string". A build that never ran reported a parse error instead — and the
 * obvious workaround for a misbehaving build (adding a flag) was the very thing
 * that triggered it.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

import { parseCommand } from '../run-with-build-custody.mjs'

const execFileAsync = promisify(execFile)
const wrapper = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../run-with-build-custody.mjs',
)

test('passes a bare command through without a shell', () => {
  const parsed = parseCommand(['turbo', 'run', 'build:verify'])
  assert.equal(parsed.shell, false)
  assert.equal(parsed.command, 'turbo')
  assert.deepEqual(parsed.args, ['run', 'build:verify'])
})

test('runs a lone --shell string through a shell unchanged', () => {
  const parsed = parseCommand(['--shell', 'tsup && echo done'])
  assert.equal(parsed.shell, true)
  assert.equal(parsed.command, 'tsup && echo done')
  assert.deepEqual(parsed.args, [])
})

test('appends yarn-forwarded flags to the --shell command instead of rejecting them', () => {
  // The actual failing invocation: `yarn workspace @dzupagent/evals run build --silent`.
  const parsed = parseCommand(['--shell', 'tsup', '--silent'])
  assert.equal(parsed.shell, true)
  assert.match(parsed.command, /^tsup /)
  assert.match(parsed.command, /--silent/)
})

test('quotes appended arguments so spaces cannot split them into two words', () => {
  const parsed = parseCommand(['--shell', 'tsup', '--out dir'])
  // A bare interpolation would yield `tsup --out dir` — two arguments, not one.
  assert.equal(parsed.command.includes(`'--out dir'`), true)
})

test('quotes appended arguments so they cannot inject a second shell command', async () => {
  const parsed = parseCommand(['--shell', 'echo safe', '; echo INJECTED'])
  assert.equal(parsed.shell, true)
  // Verify against a real shell rather than trusting the quoting by inspection.
  const { stdout } = await execFileAsync('sh', ['-c', parsed.command])
  // The payload must arrive as literal text on the SINGLE echo's line, not run
  // as a second command. Asserting merely that "INJECTED" is absent would fail
  // even when quoting works correctly, since the safe outcome still echoes it.
  assert.equal(stdout.trim(), 'safe ; echo INJECTED')
  assert.equal(stdout.trim().split('\n').length, 1)
})

test('escapes embedded single quotes rather than terminating the quoted argument', async () => {
  const parsed = parseCommand(['--shell', 'echo', `it's`])
  const { stdout } = await execFileAsync('sh', ['-c', parsed.command])
  assert.equal(stdout.trim(), `it's`)
})

test('still rejects --shell with no command string', () => {
  assert.throws(
    () => parseCommand(['--shell']),
    /--shell requires exactly one command string/,
  )
})

test('rejects an empty argument list', () => {
  assert.throws(
    () => parseCommand([]),
    /a command is required/,
  )
})

test('end-to-end: a --shell build with an appended flag exits 0 and runs the command', async () => {
  // Guards the wrapper as actually invoked, not just parseCommand in isolation:
  // the earlier failure surfaced only through the CLI entrypoint.
  const { stdout } = await execFileAsync('node', [
    wrapper,
    '--shell',
    'echo BUILD_RAN',
    '--silent',
  ])
  assert.equal(stdout.includes('BUILD_RAN'), true)
})
