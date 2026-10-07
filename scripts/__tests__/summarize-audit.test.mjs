import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeAudit, renderAuditMarkdown } from '../summarize-audit.mjs'
const source = 'a'.repeat(40)
const context = (id, gates) => ({ id, source, gates })
test('green runtime tests cannot hide missing or failed qualification gates', () => {
  const report = summarizeAudit({ source, requiredGates: [{ context: 'clone', name: 'test' }, { context: 'clone', name: 'coverage' }, { context: 'clone', name: 'policy' }], contexts: [context('clone', [{ name: 'test', status: 'pass', tests: { passed: 100, skipped: 2 } }, { name: 'coverage', status: 'pass' }])] })
  assert.equal(report.qualification, 'red')
  assert.equal(report.required[1].status, 'incomplete')
  assert.equal(report.required[2].status, 'incomplete')
})
test('retains reruns by context without summing duplicate test counts', () => {
  const report = summarizeAudit({ source, requiredGates: [{ context: 'canonical', name: 'test' }], contexts: [context('clone', [{ name: 'test', status: 'fail', tests: { passed: 99, failed: 1 } }]), context('canonical', [{ name: 'test', status: 'pass', tests: { passed: 100 } }])] })
  assert.equal(report.contexts.length, 2)
  assert.equal(report.contexts[0].gates[0].status, 'fail')
  assert.equal(report.qualification, 'green')
  assert.equal(report.totalPassingTests, undefined)
})
test('rejects duplicate or mismatched source evidence', () => {
  const base = { source, requiredGates: [{ context: 'one', name: 'test' }] }
  assert.throws(() => summarizeAudit({ ...base, contexts: [context('one', [{ name: 'test', status: 'pass' }, { name: 'test', status: 'pass' }])] }), /Duplicate/)
  assert.throws(() => summarizeAudit({ ...base, contexts: [{ ...context('one', []), source: 'b'.repeat(40) }] }), /binding/)
})
test('rejects contradictory pass counts and malformed test evidence', () => {
  const base = { source, requiredGates: [{ context: 'one', name: 'test' }] }
  for (const tests of [{ passed: -1 }, { passed: 1.5 }, { passed: 1, failed: 1 }]) {
    assert.throws(() => summarizeAudit({ ...base, contexts: [context('one', [{ name: 'test', status: 'pass', tests }])] }))
  }
  assert.throws(() => summarizeAudit({ ...base, contexts: [context('one', []), context('one', [])] }), /Duplicate/)
})
test('rendered output preserves gate reasons and execution counts without a combined total', () => {
  const report = renderAuditMarkdown({ source, requiredGates: [{ context: 'one', name: 'coverage' }], contexts: [context('one', [{ name: 'coverage', status: 'fail', reason: 'Floor | miss\nreviewed', tests: { passed: 10, failed: 0, skipped: 1 }, evidence: 'coverage.log' }])] })
  assert.match(report, /Qualification: \*\*red\*\*/)
  assert.match(report, /Floor \\\| miss reviewed/)
  assert.match(report, /\| 10 \| 0 \| 1 \| coverage.log \|/)
  assert.doesNotMatch(report, /total passing/i)
})
test('required gates are unique and missing contexts cannot qualify', () => {
  const requirement = { context: 'one', name: 'test' }
  assert.throws(() => summarizeAudit({ source, requiredGates: [requirement, requirement], contexts: [] }), /Duplicate required/)
  const report = summarizeAudit({ source, requiredGates: [requirement], contexts: [] })
  assert.equal(report.qualification, 'red')
  assert.equal(report.required[0].status, 'incomplete')
  for (const tests of ['invalid', [], { madeUp: 1 }]) assert.throws(() => summarizeAudit({ source, requiredGates: [requirement], contexts: [context('one', [{ name: 'test', status: 'pass', tests }])] }))
})
test('a truthy verification label cannot qualify coverage and evidence text cannot render HTML', () => {
  const evidence = { source, requiredGates: [{ context: 'one', name: 'coverage' }], contexts: [context('one', [{ name: 'coverage', status: 'pass', summaryVerified: 'yes', evidence: '<script>fixture</script>' }])] }
  assert.equal(summarizeAudit(evidence).qualification, 'red')
  assert.match(renderAuditMarkdown(evidence), /&lt;script&gt;/)
  assert.doesNotMatch(renderAuditMarkdown(evidence), /<script>/)
})
