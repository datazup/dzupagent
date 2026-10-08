import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { checkPublishMetadata } from '../check-publish-metadata.mjs'
test('pinned source metadata survives install normalization without rewriting the working tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-source-'))
  try {
    const folder = join(root, 'packages/alpha')
    mkdirSync(join(folder, 'dist'), { recursive: true })
    writeFileSync(join(folder, 'dist/cli.js'), '')
    const pkg = { name: 'alpha', bin: { alpha: 'dist/cli.js' }, repository: { type: 'git', url: 'git+https://github.com/datazup/dzupagent.git', directory: 'packages/alpha' } }
    const manifest = join(folder, 'package.json')
    writeFileSync(manifest, JSON.stringify(pkg))
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-q', '-m', 'fixture'])
    const pin = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    writeFileSync(manifest, JSON.stringify({ ...pkg, bin: 'dist/cli.js' }))
    const before = readFileSync(manifest)
    assert.equal(checkPublishMetadata(root).failures.length, 1)
    const report = checkPublishMetadata(root, pin)
    assert.deepEqual(report.failures, [])
    assert.deepEqual(report.metadataDrift, ['alpha'])
    assert.deepEqual(readFileSync(manifest), before)
    assert.throws(() => checkPublishMetadata(root, 'missing'), /full commit/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
