import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { verifyBracesRemediation } from './verify-braces-remediation.mjs'

const URL = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'
export function evaluateDependencyAudit({ status, stdout, stderr = '', remediation }) {
  if (!Number.isInteger(status) || ![0, 1].includes(status)) return { ok: false, reason: 'Dependency audit did not complete', stderr }
  let rows
  try { rows = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) }
  catch { return { ok: false, reason: 'Dependency audit returned invalid JSON' } }
  const unresolved = [], mitigated = []
  for (const row of rows) {
    const issue = row?.children
    if (typeof row?.value !== 'string' || !issue || typeof issue.URL !== 'string' || !Array.isArray(issue['Tree Versions'])) {
      return { ok: false, reason: 'Unrecognized dependency audit record', record: row }
    }
    if (row.value === 'braces' && issue.URL === URL && issue.Severity === 'high'
      && issue['Tree Versions'].length === 1 && issue['Tree Versions'][0] === '3.0.3'
      && remediation?.status === 'verified' && remediation.advisory === 'GHSA-vfj7-8cjw-p6xm'
      && remediation.version === '3.0.3' && /^[a-f0-9]{64}$/.test(remediation.patchSha256)) {
      mitigated.push({ ...row, remediation })
    } else unresolved.push(row)
  }
  if (status === 1 && rows.length === 0) return { ok: false, reason: 'Dependency audit failed without advisory evidence', stderr }
  if (status === 0 && rows.length > 0) return { ok: false, reason: 'Dependency audit status contradicts its advisory evidence' }
  return { ok: unresolved.length === 0, unresolved, mitigated }
}

export function main() {
  // Raw registry findings remain visible. Only the exact verified local patch
  // qualifies this one advisory; network/tool errors and all others stay red.
  const audit = spawnSync('yarn', ['npm', 'audit', '--all', '--recursive', '--severity', 'high', '--json'], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 120000,
  })
  let remediation
  try { remediation = verifyBracesRemediation() }
  catch (error) { console.error('Installed braces remediation invalid:', error.message); return 1 }
  const result = evaluateDependencyAudit({ ...audit, remediation })
  console.log(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main()
