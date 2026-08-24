import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const checker = fileURLToPath(new URL('../check-circular-deps.mjs', import.meta.url))

test('runtime-contracts production imports remain cycle-free', { timeout: 30_000 }, () => {
  const result = spawnSync(
    process.execPath,
    [checker, '--pkg', 'runtime-contracts', '--concurrency', '1'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  assert.ifError(result.error)
  assert.equal(
    result.status,
    0,
    `runtime-contracts circular-dependency check failed:\n${result.stdout}${result.stderr}`,
  )
})
