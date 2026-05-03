#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const auditPath = join(rootDir, 'docs', 'SECURITY-AUDIT.md')
const audit = readFileSync(auditPath, 'utf8')

const allowedStatuses = new Set(['open', 'resolved', 'accepted risk', 'superseded'])
const findingPattern = /^### (SECURITY-\d{3}) - (.+)$/gm
const headingIds = Array.from(audit.matchAll(/^### (SECURITY-\d{3}) - /gm), item => item[1])
const markdownStatuses = new Map()
const findings = []
let match

while ((match = findingPattern.exec(audit)) !== null) {
  const nextHeading = audit.indexOf('\n### SECURITY-', findingPattern.lastIndex)
  const section = audit.slice(match.index, nextHeading === -1 ? undefined : nextHeading)
  const statusMatch = section.match(/\nStatus:\s*([^\n]+)/)
  if (!statusMatch) {
    findings.push({ id: match[1], error: 'missing Status line' })
    continue
  }

  const status = statusMatch[1].trim().toLowerCase()
  if (!allowedStatuses.has(status)) {
    findings.push({
      id: match[1],
      error: `invalid Status "${statusMatch[1].trim()}"`,
    })
  } else {
    markdownStatuses.set(match[1], status)
  }
}

if (headingIds.length === 0) {
  findings.push({ id: 'SECURITY-AUDIT', error: 'no SECURITY findings found' })
}

const jsonMatch = audit.match(/```json\n([\s\S]*?)\n```/)
if (!jsonMatch) {
  findings.push({ id: 'SECURITY-AUDIT', error: 'missing JSON summary block' })
} else {
  try {
    const summary = JSON.parse(jsonMatch[1])
    const entries = Array.isArray(summary.findings) ? summary.findings : []
    const summaryIds = new Set(entries.map(entry => entry?.id).filter(Boolean))

    for (const id of headingIds) {
      if (!summaryIds.has(id)) {
        findings.push({ id, error: 'missing from JSON summary findings' })
      }
    }

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      if (!entry.status) {
        findings.push({ id: String(entry.id ?? 'unknown'), error: 'missing JSON summary status' })
      } else if (!allowedStatuses.has(String(entry.status).trim().toLowerCase())) {
        findings.push({
          id: String(entry.id ?? 'unknown'),
          error: `invalid JSON summary status "${entry.status}"`,
        })
      } else if (
        markdownStatuses.has(entry.id)
        && markdownStatuses.get(entry.id) !== String(entry.status).trim().toLowerCase()
      ) {
        findings.push({
          id: entry.id,
          error: `JSON summary status "${entry.status}" does not match markdown status "${markdownStatuses.get(entry.id)}"`,
        })
      }
    }
  } catch (error) {
    findings.push({
      id: 'SECURITY-AUDIT',
      error: `invalid JSON summary: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

if (findings.length > 0) {
  console.error('Security audit status drift detected:')
  for (const finding of findings) {
    console.error(`- ${finding.id}: ${finding.error}`)
  }
  process.exit(1)
}

console.log('Security audit status check passed')
