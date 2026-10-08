import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(root, 'package.json'))
const YAML = require('yaml')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function installedBracesLocations(state, patch) {
  const entries = Object.entries(state).filter(([locator]) => locator.startsWith('braces@'))
  assert.ok(entries.length > 0, 'installed braces inventory missing')
  const expected = `braces@patch:braces@npm%3A3.0.3#~/${patch}::version=3.0.3&hash=`
  const locations = new Set()
  for (const [locator, entry] of entries) {
    assert.ok(locator.startsWith(expected), 'an unpatched braces installation remains')
    assert.ok(Array.isArray(entry.locations) && entry.locations.length > 0, 'installed braces locations missing')
    for (const location of entry.locations) {
      assert.ok(typeof location === 'string' && !path.isAbsolute(location), 'invalid braces installation location')
      const relative = path.relative(root, path.resolve(root, location))
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'braces installation escapes checkout')
      locations.add(location)
    }
  }
  return [...locations]
}
export function verifyBracesRemediation() {
  const record = JSON.parse(readFileSync(path.join(root, 'scripts/braces-remediation.json')))
  assert.equal(record.advisory, 'GHSA-vfj7-8cjw-p6xm')
  assert.equal(record.version, '3.0.3')
  assert.equal(sha(readFileSync(path.join(root, record.patch))), record.patchSha256, 'patch fingerprint changed')
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json')))
  assert.equal(manifest.resolutions['braces@npm:^3.0.3'], `patch:braces@npm%3A3.0.3#~/${record.patch}`, 'patch resolution removed')
  const consumer = createRequire(require.resolve('micromatch'))
  const location = path.dirname(consumer.resolve('braces/package.json'))
  const state = YAML.parse(readFileSync(path.join(root, 'node_modules/.yarn-state.yml'), 'utf8'))
  const locations = installedBracesLocations(state, record.patch)
  assert.ok(locations.some(entry => realpathSync(path.join(root, entry)) === realpathSync(location)), 'consumer missing from installed inventory')
  for (const entry of locations) {
    const directory = path.join(root, entry)
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'package.json'))).version, record.version)
    for (const [file, digest] of Object.entries(record.files)) {
      assert.equal(sha(readFileSync(path.join(directory, file))), digest, `installed consumer file changed: ${file}`)
    }
  }
  const braces = consumer('braces')
  const rejection = error => error instanceof RangeError && error.code === 'BRACES_AST_LIMIT'
  assert.deepEqual(braces.expand('src/{a,b}/{1..3}.ts'), ['src/a/1.ts', 'src/a/2.ts', 'src/a/3.ts', 'src/b/1.ts', 'src/b/2.ts', 'src/b/3.ts'])
  assert.equal(braces.compile('src/{a,b}.ts'), 'src/(a|b).ts')
  const deep = '{'.repeat(4096) + 'a,b' + '}'.repeat(4096)
  const parens = '('.repeat(4096) + 'x' + ')'.repeat(4096)
  for (const pattern of [deep, parens, '{'.repeat(4096) + 'x']) {
    for (const operation of ['parse', 'compile', 'expand', 'stringify']) assert.throws(() => braces[operation](pattern), rejection)
  }
  for (const operation of ['compile', 'expand', 'stringify']) {
    let ast = { type: 'text', value: 'x' }
    for (let i = 0; i < 4096; i++) ast = { type: 'root', nodes: [ast] }
    assert.throws(() => braces[operation](ast), rejection)
    const cycle = { type: 'root', nodes: [] }
    cycle.nodes.push(cycle)
    assert.throws(() => braces[operation](cycle), rejection)
    const parentCycle = { type: 'text' }
    parentCycle.parent = parentCycle
    assert.throws(() => braces[operation](parentCycle), rejection)
    assert.throws(() => braces[operation]({ type: 'root', nodes: Array(262145).fill({ type: 'text', value: 'x' }) }), rejection)
  }
  const micromatch = require('micromatch')
  assert.deepEqual(micromatch(['a.ts', 'b.js', 'c.ts'], '*.{ts,js}'), ['a.ts', 'b.js', 'c.ts'])
  assert.throws(() => micromatch.braces(deep), rejection)
  return { advisory: record.advisory, version: record.version, patchSha256: record.patchSha256, installedCopies: locations.length, status: 'verified' }
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try { console.log(JSON.stringify(verifyBracesRemediation())) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
