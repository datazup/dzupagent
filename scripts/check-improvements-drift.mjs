import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

function getAllowlistPath(root) {
  return join(root, 'scripts', 'check-improvements-drift.allowlist.json')
}

function readText(root, pathname) {
  return readFileSync(join(root, pathname), 'utf8')
}

function readAllowlist(root) {
  const allowlistPath = getAllowlistPath(root)
  if (!existsSync(allowlistPath)) {
    return { ignoredFindings: [] }
  }

  try {
    const raw = JSON.parse(readFileSync(allowlistPath, 'utf8'))
    if (!raw || typeof raw !== 'object') {
      return { ignoredFindings: [] }
    }
    const ignoredFindings = Array.isArray(raw.ignoredFindings) ? raw.ignoredFindings : []
    return { ignoredFindings }
  } catch (error) {
    throw new Error(`Failed to parse allowlist at ${relative(root, allowlistPath)}: ${error.message}`)
  }
}

function normalizeClaim(text) {
  return String(text ?? '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function parseTableRow(line) {
  const match = line.match(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|?$/)
  if (!match) return null
  return {
    label: normalizeClaim(match[1]),
    status: String(match[2] ?? '').trim(),
    evidence: String(match[3] ?? '').trim(),
    raw: line,
  }
}

function findLastTableRow(markdown, label) {
  const target = normalizeClaim(label)
  const lines = markdown.split(/\r?\n/)
  let last = null

  for (let index = 0; index < lines.length; index++) {
    const row = parseTableRow(lines[index])
    if (!row) continue
    if (row.label === target) {
      last = { ...row, line: index + 1 }
    }
  }

  return last
}

function findHeadingStatus(markdown, heading) {
  const headingIndex = markdown.lastIndexOf(heading)
  if (headingIndex === -1) return null

  const slice = markdown.slice(headingIndex, headingIndex + 1200)
  const statusMatch = slice.match(/Status:\s*`([^`]+)`/)
  return {
    heading,
    status: statusMatch ? statusMatch[1].trim() : null,
    excerpt: slice,
  }
}

function hasMarkersInFile(root, file, pattern) {
  const text = readText(root, file)
  return pattern.test(text)
}

function runStrictInventoryGate() {
  try {
    const output = execFileSync(
      process.execPath,
      [join('scripts', 'check-runtime-test-inventory.mjs'), '--strict-integration'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    return {
      passed: true,
      output,
    }
  } catch (error) {
    return {
      passed: false,
      output: String(error?.stdout ?? '') + String(error?.stderr ?? ''),
      error,
    }
  }
}

function statusImpliesMarkers(status) {
  const normalized = normalizeClaim(status)
  if (normalized === 'done' || normalized === 'ready' || normalized === 'pass') {
    return { expectedMarkers: false, unknown: false, normalized }
  }
  if (normalized === 'partially done' || normalized === 'partially ready' || normalized === 'not done' || normalized === 'action required') {
    return { expectedMarkers: true, unknown: false, normalized }
  }
  return { expectedMarkers: null, unknown: true, normalized }
}

function isSuppressed(finding, ignoredFindings) {
  return ignoredFindings.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    if (entry.id !== finding.id) return false
    if (entry.path && entry.path !== finding.path) return false
    if (entry.label && normalizeClaim(entry.label) !== normalizeClaim(finding.label)) return false
    return true
  })
}

function pushMarkerFinding(findings, {
  id,
  label,
  path,
  row,
  sourceFile,
  sourceHasMarkers,
}) {
  const expectation = statusImpliesMarkers(row.status)
  const sourceState = `${sourceFile}:${sourceHasMarkers ? 'markers-present' : 'markers-absent'}`

  if (expectation.unknown) {
    findings.push({
      id,
      label,
      path,
      message: `${label} has unrecognized status "${row.status ?? 'unknown'}".`,
      evidence: row.raw,
      sourceState,
    })
    return
  }

  if (expectation.expectedMarkers !== sourceHasMarkers) {
    findings.push({
      id,
      label,
      path,
      message: `${label} says "${row.status}" but source markers are ${sourceHasMarkers ? 'present' : 'absent'}.`,
      evidence: row.raw,
      sourceState,
    })
  }
}

export function evaluateImprovementDrift({
  root = repoRoot,
  runStrictInventoryGateImpl = runStrictInventoryGate,
} = {}) {
  const allowlist = readAllowlist(root)
  const findings = []

  // Check 1: runtime adapter maturity claims vs source markers.
  {
    const docs = [
      '.docs/improvements/CORE_AGENT_ADAPTERS_IMPROVEMENTS.md',
      '.docs/improvements/CORE_AGENT_ADAPTERS_IMPLEMENTATION_PLAN.md',
    ]
    const sourceFiles = [
      'packages/agent-adapters/src/qwen/qwen-adapter.ts',
      'packages/agent-adapters/src/crush/crush-adapter.ts',
    ]
    const markerPattern = /\bstub\b|\bTODO\b/i

    const qwenDoc = readText(root, docs[0])
    const qwenRow = findLastTableRow(qwenDoc, 'Qwen adapter maturity')
    if (qwenRow) {
      pushMarkerFinding(findings, {
        id: 'adapter-maturity-qwen',
        label: 'Qwen adapter maturity',
        path: docs[0],
        row: qwenRow,
        sourceFile: sourceFiles[0],
        sourceHasMarkers: hasMarkersInFile(root, sourceFiles[0], markerPattern),
      })
    }

    const crushRow = findLastTableRow(qwenDoc, 'Crush adapter maturity')
    if (crushRow) {
      pushMarkerFinding(findings, {
        id: 'adapter-maturity-crush',
        label: 'Crush adapter maturity',
        path: docs[0],
        row: crushRow,
        sourceFile: sourceFiles[1],
        sourceHasMarkers: hasMarkersInFile(root, sourceFiles[1], markerPattern),
      })
    }

    const planDoc = readText(root, docs[1])
    const planRow = findLastTableRow(planDoc, 'Phase 2.2 migrate Gemini/Qwen/Crush')
    if (planRow) {
      pushMarkerFinding(findings, {
        id: 'adapter-maturity-plan-phase-2-2-qwen',
        label: 'Phase 2.2 migrate Gemini/Qwen/Crush',
        path: docs[1],
        row: planRow,
        sourceFile: sourceFiles[0],
        sourceHasMarkers: hasMarkersInFile(root, sourceFiles[0], markerPattern),
      })
      pushMarkerFinding(findings, {
        id: 'adapter-maturity-plan-phase-2-2-crush',
        label: 'Phase 2.2 migrate Gemini/Qwen/Crush',
        path: docs[1],
        row: planRow,
        sourceFile: sourceFiles[1],
        sourceHasMarkers: hasMarkersInFile(root, sourceFiles[1], markerPattern),
      })
    }
  }

  // Check 2: strict gate claims vs current inventory status.
  {
    const inventory = runStrictInventoryGateImpl()
    const strictPass = inventory.passed

    const testDoc = readText(root, '.docs/improvements/TEST.md')
    const testRow = findLastTableRow(testDoc, 'Strict verification gate (`verify:strict`)')
    if (testRow) {
      const expectedPass = statusImpliesMarkers(testRow.status)
      const docSaysPass = !expectedPass.expectedMarkers
      if (expectedPass.unknown || docSaysPass !== strictPass) {
        findings.push({
          id: 'strict-gate-verify-claim',
          label: 'Strict verification gate (`verify:strict`)',
          path: '.docs/improvements/TEST.md',
          message: `TEST.md says "${testRow.status}" but runtime inventory strict gate is ${strictPass ? 'passing' : 'failing'}.`,
          evidence: testRow.raw,
          sourceState: strictPass ? 'strict-pass' : 'strict-fail',
        })
      }
    }

    const trackerDoc = readText(root, '.docs/improvements/CONSOLIDATED_IMPLEMENTATION_TRACKER.md')
    const trackerRow = findHeadingStatus(trackerDoc, '### P2-04: Improvement-doc drift CI check')
    if (trackerRow) {
      const docSaysDone = normalizeClaim(trackerRow.status) === 'done'
      const scriptExists = existsSync(join(root, 'scripts', 'check-improvements-drift.mjs'))
      if (docSaysDone !== scriptExists) {
        findings.push({
          id: 'p2-04-tracker-claim',
          label: 'P2-04: Improvement-doc drift CI check',
          path: '.docs/improvements/CONSOLIDATED_IMPLEMENTATION_TRACKER.md',
          message: `Tracker says "${trackerRow.status}" but the drift script file is ${scriptExists ? 'present' : 'absent'}.`,
          evidence: `### P2-04: Improvement-doc drift CI check / Status: \`${trackerRow.status ?? 'unknown'}\``,
          sourceState: scriptExists ? 'script-present' : 'script-absent',
        })
      }
    }
  }

  const ignored = allowlist.ignoredFindings ?? []
  const activeFindings = findings.filter((finding) => !isSuppressed(finding, ignored))

  return {
    allowlist,
    findings,
    ignored,
    activeFindings,
    repoRoot: root,
  }
}

function printReport(report) {
  const allowlistPath = getAllowlistPath(report.repoRoot)
  console.log('Improvement doc drift check:')
  console.log(`- Allowlist: ${relative(report.repoRoot, allowlistPath)} (${report.ignored.length} suppressed finding rule${report.ignored.length === 1 ? '' : 's'})`)
  console.log(`- Findings: ${report.activeFindings.length}`)

  for (const finding of report.activeFindings) {
    console.log(`\n[${finding.id}] ${finding.message}`)
    console.log(`  doc: ${finding.path}`)
    console.log(`  evidence: ${finding.evidence}`)
    console.log(`  source: ${finding.sourceState}`)
  }

  if (report.activeFindings.length > 0) {
    process.exitCode = 1
  } else {
    console.log('\nNo actionable improvement-doc drift detected.')
  }
}

async function main() {
  const report = evaluateImprovementDrift()
  printReport(report)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export { findLastTableRow, findHeadingStatus, normalizeClaim, statusImpliesMarkers }
