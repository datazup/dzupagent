import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeGates, BUILD_GATE_NAME } from '../run-gates.mjs'
const gates = [BUILD_GATE_NAME, 'test', 'check:package-export-artifacts', 'audit:deps'].map(name => ({ name, run: name }))
test('build green/test red still executes artifact and dependency checks', () => {
  const seen = []
  const { results } = executeGates(gates, gate => { seen.push(gate.name); return { status: gate.name === 'test' ? 1 : 0 } })
  assert.equal(results[1].ok, false)
  assert.deepEqual(seen, gates.map(g => g.name))
  assert.equal(results[2].ok, true)
})
test('build failure marks artifact checks incomplete and still measures dependencies', () => {
  const seen = []
  const { results } = executeGates(gates, gate => { seen.push(gate.name); return { status: gate.name === BUILD_GATE_NAME ? 1 : 0 } })
  assert.deepEqual(seen, [BUILD_GATE_NAME, 'audit:deps'])
  assert.equal(results[2].skipped, true)
  assert.equal(results[3].ok, true)
})
