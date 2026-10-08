import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyBracesRemediation, installedBracesLocations } from '../verify-braces-remediation.mjs'
import { evaluateDependencyAudit } from '../audit-dependencies.mjs'

const issue = { value: 'braces', children: { URL: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', Severity: 'high', 'Tree Versions': ['3.0.3'] } }
const remediation = { status: 'verified', advisory: 'GHSA-vfj7-8cjw-p6xm', version: '3.0.3', patchSha256: 'a'.repeat(64) }
const audit = (rows = [issue], proof = remediation) => evaluateDependencyAudit({ status: 1, stdout: rows.map(x => JSON.stringify(x)).join('\n'), remediation: proof })

test('installed transitive consumer uses the exact guarded patch and rejects deep patterns and ASTs', () => {
  assert.equal(verifyBracesRemediation().status, 'verified')
})
test('every linked installation must use the patch and stay in the checkout', () => {
  const patch = '.yarn/patches/braces-npm-3.0.3-582c14023c.patch'
  const locator = `braces@patch:braces@npm%3A3.0.3#~/${patch}::version=3.0.3&hash=abcdef`
  const valid = { [locator]: { locations: ['node_modules/braces', 'node_modules/other/node_modules/braces'] } }
  assert.equal(installedBracesLocations(valid, patch).length, 2)
  for (const state of [{}, { ...valid, 'braces@npm:3.0.3': { locations: ['node_modules/unsafe/node_modules/braces'] } }, { [locator]: { locations: [] } }, { [locator]: { locations: ['../escape'] } }]) assert.throws(() => installedBracesLocations(state, patch))
})
test('registry advisory remains reported alongside its verified remediation', () => {
  const result = audit()
  assert.equal(result.ok, true)
  assert.equal(result.mitigated.length, 1)
  assert.equal(result.mitigated[0].children.URL, issue.children.URL)
})
test('missing, unverified, or different patch proofs cannot qualify the finding', () => {
  for (const proof of [null, {}, { ...remediation, status: 'missing' }, { ...remediation, version: '3.0.2' }, { ...remediation, patchSha256: '' }]) assert.equal(audit([issue], proof).ok, false)
})
test('new advisories or unexpected vulnerable versions remain red', () => {
  for (const next of [{ ...issue, value: 'other' }, { ...issue, children: { ...issue.children, URL: 'https://example.test/new-advisory' } }, { ...issue, children: { ...issue.children, 'Tree Versions': ['3.0.3', '3.0.2'] } }]) assert.equal(audit([issue, next]).ok, false)
})
test('tool/network failures and malformed or contradictory reports fail closed', () => {
  for (const report of [{ status: 2, stdout: '' }, { status: null, stdout: '' }, { status: 1, stdout: '' }, { status: 1, stdout: 'network failed' }, { status: 1, stdout: '{}' }, { status: 0, stdout: JSON.stringify(issue), remediation }]) assert.equal(evaluateDependencyAudit(report).ok, false)
  assert.equal(evaluateDependencyAudit({ status: 0, stdout: '' }).ok, true)
})
