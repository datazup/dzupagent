import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isRipgrepAvailable, runRipgrep, runRipgrepLines } from '../lib/ripgrep.mjs'

/**
 * DZUPAGENT-ARCH-L-08: the ripgrep probe and spawn used to be copy-pasted into
 * three gate scripts. scripts/lib/ripgrep.mjs is now the single owner.
 */
const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url))
const HELPER = fileURLToPath(new URL('../lib/ripgrep.mjs', import.meta.url))
const RG_SPAWN = /\b(?:execFileSync|execSync|spawnSync|spawn|execFile)\(\s*['"`]rg['"`]/

test('only the shared helper spawns rg among the gate scripts', () => {
  const offenders = readdirSync(SCRIPTS_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => RG_SPAWN.test(readFileSync(join(SCRIPTS_DIR, name), 'utf8')))
  assert.deepEqual(offenders, [])
  assert.match(readFileSync(HELPER, 'utf8'), RG_SPAWN)
})

test('the three ripgrep gates import the shared helper', () => {
  for (const gate of [
    'check-domain-boundaries.mjs',
    'check-terminal-tool-event-guards.mjs',
    'check-runtime-test-inventory.mjs',
  ]) {
    const source = readFileSync(join(SCRIPTS_DIR, gate), 'utf8')
    assert.match(source, /from '\.\/lib\/ripgrep\.mjs'/, gate)
  }
})

test('isRipgrepAvailable caches its probe and returns a boolean', () => {
  const first = isRipgrepAvailable({ refresh: true })
  assert.equal(typeof first, 'boolean')
  assert.equal(isRipgrepAvailable(), first)
})

test('isRipgrepAvailable reports false when rg cannot be resolved on PATH', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { isRipgrepAvailable } from ${JSON.stringify(HELPER)}; process.stdout.write(String(isRipgrepAvailable()))`,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: dirname(process.execPath) } },
  )
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(probe.stdout, 'false')
})

test('runRipgrep treats no matches as empty output and returns matches otherwise', (t) => {
  if (!isRipgrepAvailable()) {
    t.skip('rg is not installed on this host')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'ripgrep-helper-'))
  try {
    writeFileSync(join(root, 'a.txt'), 'needle\n')
    writeFileSync(join(root, 'b.txt'), 'hay\n')
    assert.equal(runRipgrep(['-l', '-e', 'absent-token', '.'], { cwd: root }), '')
    assert.deepEqual(runRipgrepLines(['-l', '-e', 'needle', '.'], { cwd: root }), ['./a.txt'])
    assert.throws(() => runRipgrep(['--definitely-not-a-flag'], { cwd: root }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
