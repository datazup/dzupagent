#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Aggregate only evidence from one source pin, retaining every execution context. */
export function summarizeAudit(evidence) {
  if (!/^[a-f0-9]{40}$/.test(evidence.source)) throw new Error('A full source commit is required')
  if (!Array.isArray(evidence.requiredGates) || !evidence.requiredGates.length) throw new Error('Required gates must be explicit')
  const keys = new Set()
  const contexts = evidence.contexts.map(context => {
    if (!context.id || context.source !== evidence.source) throw new Error('Context source binding mismatch')
    const gates = context.gates.map(gate => {
      const key = context.id + ':' + gate.name
      if (keys.has(key)) throw new Error('Duplicate context/gate evidence: ' + key)
      keys.add(key)
      if (!['pass', 'fail', 'incomplete', 'skipped'].includes(gate.status)) throw new Error('Invalid gate status')
      if (gate.tests) for (const count of Object.values(gate.tests)) if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid test count')
      if (gate.name === 'coverage' && gate.status === 'pass' && !gate.summaryVerified) return { ...gate, status: 'incomplete', reason: 'Coverage summary artifact missing or unverified' }
      return gate
    })
    return { ...context, gates }
  })
  const required = evidence.requiredGates.map(requirement => {
    const gate = contexts.find(c => c.id === requirement.context)?.gates.find(g => g.name === requirement.name)
    return { ...requirement, status: gate?.status ?? 'incomplete' }
  })
  const qualification = required.every(g => g.status === 'pass') ? 'green' : 'red'
  return { schema: 'dzupagent.localAuditSummary/v1', source: evidence.source, qualification, required, contexts,
    note: 'Test counts are per execution context; reruns and coverage runs are not summed into unique passing tests.' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(summarizeAudit(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
