import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeAudit } from '../summarize-audit.mjs'
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
