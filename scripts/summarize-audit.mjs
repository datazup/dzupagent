#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Aggregate only evidence from one source pin, retaining every execution context. */
export function summarizeAudit(evidence) {
  if (!/^[a-f0-9]{40}$/.test(evidence.source)) throw new Error('A full source commit is required')
  if (!Array.isArray(evidence.requiredGates) || !evidence.requiredGates.length) throw new Error('Required gates must be explicit')
  if (!Array.isArray(evidence.contexts)) throw new Error('Execution contexts must be explicit')
  const ids = new Set()
  const requirements = new Set()
  for (const requirement of evidence.requiredGates) {
    if (typeof requirement.context !== 'string' || !requirement.context || typeof requirement.name !== 'string' || !requirement.name) throw new Error('Required gate context and name are required')
    const key = JSON.stringify([requirement.context, requirement.name])
    if (requirements.has(key)) throw new Error('Duplicate required gate')
    requirements.add(key)
  }
  const keys = new Set()
  const contexts = evidence.contexts.map(context => {
    if (typeof context.id !== 'string' || !context.id || context.source !== evidence.source) throw new Error('Context source binding mismatch')
    if (!Array.isArray(context.gates)) throw new Error('Context gates must be explicit')
    if (ids.has(context.id)) throw new Error('Duplicate execution context')
    ids.add(context.id)
    const gates = context.gates.map(gate => {
      if (typeof gate.name !== 'string' || !gate.name) throw new Error('Gate name is required')
      if (gate.status === 'pass' && gate.tests?.failed > 0) throw new Error('Passing gate contains failed tests')
      const key = JSON.stringify([context.id, gate.name])
      if (keys.has(key)) throw new Error('Duplicate context/gate evidence: ' + key)
      keys.add(key)
      if (!['pass', 'fail', 'incomplete', 'skipped'].includes(gate.status)) throw new Error('Invalid gate status')
      if (gate.tests) {
        if (typeof gate.tests !== 'object' || Array.isArray(gate.tests)) throw new Error('Invalid test evidence')
        for (const [name, count] of Object.entries(gate.tests)) if (!['passed', 'failed', 'skipped'].includes(name) || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid test count')
      }
      if (gate.name === 'coverage' && gate.status === 'pass' && !gate.summaryVerified) return { ...gate, status: 'incomplete', reason: 'Coverage summary artifact missing or unverified' }
      return gate
    })
    return { ...context, gates }
  })
  const required = evidence.requiredGates.map(requirement => {
    const gate = contexts.find(c => c.id === requirement.context)?.gates.find(g => g.name === requirement.name)
    return { ...requirement, status: gate?.status ?? 'incomplete', ...(gate?.reason ? { reason: gate.reason } : {}) }
  })
  const qualification = required.every(g => g.status === 'pass') ? 'green' : 'red'
  return { schema: 'dzupagent.localAuditSummary/v1', source: evidence.source, qualification, required, contexts,
    note: 'Test counts are per execution context; reruns and coverage runs are not summed into unique passing tests.' }
}

/** Render the same validated qualification used by machines, without inventing totals. */
export function renderAuditMarkdown(evidence) {
  const summary = summarizeAudit(evidence)
  const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ')
  const lines = [`# DzupAgent audit`, '', `Source: \`${summary.source}\``, '', `Qualification: **${summary.qualification}**`, '', summary.note, '', '| Context | Required gate | Result | Reason |', '| --- | --- | --- | --- |']
  for (const gate of summary.required) lines.push(`| ${cell(gate.context)} | ${cell(gate.name)} | ${gate.status} | ${cell(gate.reason)} |`)
  lines.push('', '| Context | Gate | Passed | Failed | Skipped | Evidence |', '| --- | --- | ---: | ---: | ---: | --- |')
  for (const context of summary.contexts) for (const gate of context.gates) {
    lines.push(`| ${cell(context.id)} | ${cell(gate.name)} | ${gate.tests?.passed ?? '—'} | ${gate.tests?.failed ?? '—'} | ${gate.tests?.skipped ?? '—'} | ${cell(gate.evidence)} |`)
  }
  return lines.join('\n') + '\n'
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    console.log(process.argv.includes('--markdown') ? renderAuditMarkdown(evidence).trimEnd() : JSON.stringify(summarizeAudit(evidence), null, 2))
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
