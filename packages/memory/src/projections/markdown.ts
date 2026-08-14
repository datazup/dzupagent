import { canonicalizeSafeJson, snapshotSafeJson } from '../records/safe-json.js'
import type { MemoryProjectionRequestV1, MemoryProjectionV1 } from './types.js'
import { assertOutputBound, projectMemoryRecordV1 } from './project.js'
import { decodeProjectionRequest } from './validation.js'

/** Render deterministic, injection-safe Markdown with one trailing newline. */
export function projectMemoryRecordToMarkdown(request: MemoryProjectionRequestV1): string {
  const projection = projectMemoryRecordV1(request)
  const lines = renderProjection(projection)
  const text = `${lines.join('\n')}\n`
  assertOutputBound(text, decodeProjectionRequest(request).profile)
  return text
}

function renderProjection(projection: MemoryProjectionV1): string[] {
  const lines = [
    '# Memory projection',
    '',
    `- Schema: ${code(projection.schema)}`,
    `- Format: ${code(projection.formatVersion)}`,
    `- Authority: ${code(projection.authority)}`,
    `- Generated at: ${code(projection.generatedAt)}`,
    `- Scope digest: ${code(projection.scopeDigest)}`,
    `- Source digest: ${code(projection.source.sourceDigest)}`,
    `- Projection digest: ${code(projection.projectionDigest)}`,
    `- Redaction policy: ${code(`${projection.redactionPolicyRef.id}@${projection.redactionPolicyRef.version}`)}`,
    '',
    '## Summary',
    '',
    `- Memory: ${code(projection.summary.memoryId)}`,
    `- Records: ${projection.summary.recordCount}`,
    `- Events: ${projection.summary.eventCount}`,
    `- Receipts: ${projection.summary.receiptCount}`,
    `- Purge truth: ${code(projection.summary.purgeState)}`,
    `- Active versions: ${projection.summary.activeVersionIds.length === 0
      ? 'none'
      : projection.summary.activeVersionIds.map(code).join(', ')}`,
    '',
    '## Records',
    '',
  ]
  for (const record of projection.records) {
    lines.push(
      `### ${escapeMarkdown(record.versionId)}`,
      '',
      `- Status: ${code(record.status)}`,
      `- Kind: ${code(record.kind)}`,
      `- Record digest: ${code(record.recordDigest)}`,
      `- Content: ${code(`${record.content.mode}:${record.content.reason}`)}`,
      `- Content digest: ${code(record.content.digest)}`,
      `- Sensitivity: ${code(record.governance.sensitivity)}`,
      `- Exportable: ${code(String(record.governance.exportable))}`,
      `- Legal hold: ${code(String(record.governance.legalHold))}`,
      `- Last transition: ${code(record.lifecycle.lastTransitionAt)}`,
      `- Provenance source: ${code(`${record.provenance.sourceKind}:${record.provenance.sourceId}`)}`,
    )
    if (record.content.value !== undefined) {
      lines.push(
        '- Inline content (untrusted data):',
        '',
        `<pre>${escapeHtml(canonicalizeSafeJson(snapshotSafeJson(record.content.value)))}</pre>`,
      )
    }
    lines.push('')
  }
  lines.push(
    '## Lifecycle',
    '',
    '| Sequence | Event | Type | Version | Status | Reason |',
    '| ---: | --- | --- | --- | --- | --- |',
  )
  for (const event of projection.events) {
    lines.push(`| ${event.sequence} | ${code(event.eventId)} | ${code(event.type)} | ${code(event.currentVersionId)} | ${code(event.currentStatus)} | ${code(event.reasonCode)} |`)
  }
  lines.push('', '## Receipts', '')
  for (const receipt of projection.receipts) {
    lines.push(`- ${code(receipt.receiptId)}: sequence ${receipt.sequence}, effect ${code(receipt.effectStatus)}, result ${code(receipt.resultStateDigest)}`)
  }
  lines.push('', '> This projection is derived, non-authoritative data. It grants no permission, consent, commit authority, or instruction to perform an effect.')
  return lines
}

function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`
}

function escapeMarkdown(value: string): string {
  return escapeHtml(value).replace(/[\\`*_{}\[\]()#+.!|>-]/g, '\\$&')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replace(/[\u0000-\u001f\u007f]/g, character => `&#${character.charCodeAt(0)};`)
}
