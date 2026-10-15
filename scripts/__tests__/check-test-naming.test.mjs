import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isAuditProvenanceTestName, isWorkItemTestName } from '../check-test-naming.mjs'

/**
 * DZUPAGENT-TEST-L-22: check:test-naming refuses audit-provenance spec names
 * (the per-package audit-coverage-regressions omnibus files) while leaving
 * modules that are genuinely about auditing alone.
 */
test('audit-provenance spec names are refused', () => {
  for (const name of [
    'audit-coverage-regressions.test.ts',
    'audit-regression.test.ts',
    'audit-fixes.spec.ts',
    'memory-audit-findings.test.ts',
    'server_audit_remediation.test.ts',
  ]) {
    assert.equal(isAuditProvenanceTestName(name), true, name)
  }
})

test('module names that merely contain "audit" are not refused', () => {
  for (const name of [
    'audit-trail.test.ts',
    'audit-trail-prune-failure.test.ts',
    'audit-cost-integration.test.ts',
    'compliance-audit.test.ts',
    'postgres-audit-store.test.ts',
    'tool-loop-canonical-audit.test.ts',
    'llm-audit-event.test.ts',
  ]) {
    assert.equal(isAuditProvenanceTestName(name), false, name)
  }
})

test('work-item names keep their existing rule', () => {
  assert.equal(isWorkItemTestName('w15-h4-branch-coverage.test.ts'), true)
  assert.equal(isWorkItemTestName('workflow-builder.test.ts'), false)
})
