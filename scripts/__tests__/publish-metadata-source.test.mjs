import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
    rmSync(join(folder, 'dist'), { recursive: true, force: true })
    assert.deepEqual(checkPublishMetadata(root, pin).failures, ['alpha: bin[alpha] target is missing after build: dist/cli.js'])
    assert.deepEqual(checkPublishMetadata(root, pin, { preBuild: true }).failures, [])
    assert.equal(checkPublishMetadata(root, undefined, { preBuild: true }).failures.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the real package manifests pass the publish metadata check (build-independent failures)', () => {
  // DZUPAGENT-ARCH-H-12: a normalizing sync flattened create-dzupagent's bin to a
  // string and the Publish job stopped before any release. The fixture test above
  // proves the checker; this one runs it against the committed manifests so the
  // same regression fails test:scripts. It reads HEAD, not the working tree,
  // because `yarn install` rewrites a single bin named after its package to a
  // string. Missing bin targets depend on a build and are left to the Publish
  // job, which runs after `yarn build`.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const report = checkPublishMetadata(undefined, head, { preBuild: true })
  assert.ok(report.checkedPackages > 0)
  assert.deepEqual(report.failures, [])
})
