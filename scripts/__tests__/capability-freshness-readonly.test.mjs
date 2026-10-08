import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { generateCapabilityMatrix } from '../generate-capability-matrix.mjs'
import { checkCapabilityMatrixFreshness } from '../check-capability-matrix-freshness.mjs'
test('green and red freshness checks leave bytes and git status unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'capability-no-write-'))
  try {
    mkdirSync(join(root, 'packages/alpha/src'), { recursive: true })
    writeFileSync(join(root, 'packages/alpha/package.json'), JSON.stringify({ name: '@dzupagent/alpha', exports: { '.': './dist/index.js' } }))
    writeFileSync(join(root, 'packages/alpha/src/index.ts'), 'export function before() {}')
    generateCapabilityMatrix(root)
    execFileSync('git', ['init', '-q', root])
    const status = () => execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
    const matrix = join(root, 'docs/CAPABILITY_MATRIX.md')
    const bytes = readFileSync(matrix)
    const greenStatus = status()
    assert.equal(checkCapabilityMatrixFreshness(root).ok, true)
    assert.deepEqual(readFileSync(matrix), bytes)
    assert.equal(status(), greenStatus)
    writeFileSync(join(root, 'packages/alpha/src/index.ts'), 'export function changed() {}')
    const redStatus = status()
    assert.equal(checkCapabilityMatrixFreshness(root).code, 'MATRIX_STALE')
    assert.deepEqual(readFileSync(matrix), bytes)
    assert.equal(status(), redStatus)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
