import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { ScriptRunEventStore } from '../runs/script-run-event-store.js'

const cleanup: string[] = []

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'script-run-event-store-test-'))
  cleanup.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('ScriptRunEventStore', () => {
  it('writes managed events and a summary into an explicit run directory', async () => {
    const runDir = await makeTmpDir()
    const store = new ScriptRunEventStore({ runId: 'script-run-1', runDir })

    await store.open()
    await store.recordEvent({
      type: 'audit.prepared',
      timestamp: 1_000,
      level: 'info',
      message: 'Audit prompt pack prepared',
      auditRunId: 'audit-1',
      correlationId: 'corr-1',
    })
    const summary = await store.close({ status: 'completed', startedAt: 1_000, completedAt: 1_250 })

    const rawEvents = await readFile(join(runDir, 'managed-events.jsonl'), 'utf8')
    const event = JSON.parse(rawEvents.trim())

    expect(event.type).toBe('audit.prepared')
    expect(event.auditRunId).toBe('audit-1')
    expect(summary.eventCount).toBe(1)
    expect(summary.artifactCount).toBe(0)
  })

  it('buffers events and artifacts before open', async () => {
    const runDir = await makeTmpDir()
    const store = new ScriptRunEventStore({ runId: 'script-run-buffered', runDir })

    await store.recordArtifact({
      artifactType: 'manifest',
      name: 'implementation-task-manifest.json',
      scriptPath: 'implementation-task-manifest.json',
      sizeBytes: 64,
      checksum: 'checksum-1',
      checksumAlgorithm: 'sha256',
      packetId: 'P001',
      createdAt: 2_000,
    })
    await store.open()

    const artifactIndex = await readFile(join(runDir, 'artifact-index.jsonl'), 'utf8')
    const managedEvents = await readFile(join(runDir, 'managed-events.jsonl'), 'utf8')

    expect(JSON.parse(artifactIndex.trim()).artifactType).toBe('manifest')
    expect(JSON.parse(managedEvents.trim()).type).toBe('artifact.recorded')
  })

  it('computes checksum and size metadata for file artifacts', async () => {
    const runDir = await makeTmpDir()
    const artifactPath = join(runDir, 'VALIDATION.md')
    const content = '# Validation\n\npass\n'
    await writeFile(artifactPath, content, 'utf8')

    const store = new ScriptRunEventStore({ runId: 'script-run-artifact-file', runDir })
    await store.open()
    const artifact = await store.recordArtifactFile({
      artifactType: 'validation',
      absolutePath: artifactPath,
      producedBy: 'yarn workspace @dzupagent/agent-adapters test',
      packetId: 'P001',
      createdAt: 3_000,
    })
    await store.close({ status: 'completed' })

    const expectedChecksum = createHash('sha256').update(content).digest('hex')
    const artifactIndex = await readFile(join(runDir, 'artifact-index.jsonl'), 'utf8')
    const indexedArtifact = JSON.parse(artifactIndex.trim())

    expect(artifact.checksum).toBe(expectedChecksum)
    expect(artifact.sizeBytes).toBe(Buffer.byteLength(content))
    expect(artifact.scriptPath).toBe('VALIDATION.md')
    expect(indexedArtifact.producedBy).toBe('yarn workspace @dzupagent/agent-adapters test')
  })

  it('returns undefined when no summary has been written yet', async () => {
    const runDir = await makeTmpDir()
    const store = new ScriptRunEventStore({ runId: 'script-run-no-summary', runDir })

    await store.open()

    await expect(store.readSummary()).resolves.toBeUndefined()
  })

  it('returns empty managed event and artifact arrays when logs have not been written yet', async () => {
    const runDir = await makeTmpDir()
    const store = new ScriptRunEventStore({ runId: 'script-run-empty-logs', runDir })

    await store.open()

    await expect(store.readEvents()).resolves.toEqual([])
    await expect(store.readArtifacts()).resolves.toEqual([])
  })

  it('does not throw on missing artifact file metadata by default', async () => {
    const runDir = await makeTmpDir()
    const store = new ScriptRunEventStore({ runId: 'script-run-missing-artifact', runDir })

    await store.open()
    const artifact = await store.recordArtifactFile({
      artifactType: 'validation',
      absolutePath: join(runDir, 'missing-validation.md'),
      packetId: 'P001',
      createdAt: 4_000,
    })

    expect(artifact.name).toBe('missing-validation.md')
    expect(artifact.sizeBytes).toBeUndefined()
    expect(artifact.checksum).toBeUndefined()
  })

  it('records typed validation, review, and approval events with summary counts', async () => {
    const runDir = await makeTmpDir()
    const store = new ScriptRunEventStore({ runId: 'script-run-governance', runDir })

    await store.open()
    const validation = await store.recordValidation({
      command: 'yarn test',
      status: 'passed',
      exitCode: 0,
      startedAt: 5_000,
      completedAt: 5_100,
      durationMs: 100,
      packetId: 'P001',
    })
    const review = await store.recordReviewDecision({
      decision: 'needs_human',
      reviewer: 'policy',
      reviewedAt: 5_200,
      reason: 'public API change',
      packetId: 'P001',
    })
    const approval = await store.recordApprovalDecision({
      decision: 'approved',
      approver: 'human',
      decidedAt: 5_300,
      requestedBy: 'policy',
      packetId: 'P001',
    })
    const summary = await store.close({ status: 'completed', startedAt: 5_000, completedAt: 5_400 })

    const rawEvents = await readFile(join(runDir, 'managed-events.jsonl'), 'utf8')
    const events = rawEvents.trim().split('\n').map((line) => JSON.parse(line))

    expect(validation.id).toBe('script-run-governance:validation:1')
    expect(review.id).toBe('script-run-governance:review:2')
    expect(approval.id).toBe('script-run-governance:approval:3')
    expect(events.map((event) => event.type)).toEqual([
      'validation.recorded',
      'review.decision_recorded',
      'approval.decision_recorded',
    ])
    expect(events[0]?.validation?.status).toBe('passed')
    expect(events[1]?.reviewDecision?.decision).toBe('needs_human')
    expect(events[2]?.approvalDecision?.decision).toBe('approved')
    expect(summary.eventCount).toBe(3)
    expect(summary.validationCounts?.passed).toBe(1)
    expect(summary.reviewDecisionCounts?.needs_human).toBe(1)
    expect(summary.approvalDecisionCounts?.approved).toBe(1)
  })

  it('reads managed events, artifact index, and summary as a snapshot', async () => {
    const runDir = await makeTmpDir()
    const store = new ScriptRunEventStore({ runId: 'script-run-snapshot', runDir })

    await store.open()
    const artifact = await store.recordArtifact({
      artifactType: 'event-log',
      name: 'events.jsonl',
      scriptPath: 'events.jsonl',
      createdAt: 6_000,
      correlationId: 'corr-1',
    })
    await store.recordValidation({
      command: 'yarn test',
      status: 'failed',
      exitCode: 1,
      startedAt: 6_100,
      completedAt: 6_200,
      artifacts: [artifact],
      correlationId: 'corr-1',
    })
    await store.close({ status: 'failed', startedAt: 6_000, completedAt: 6_300 })

    const snapshot = await store.readSnapshot()

    expect(snapshot.artifacts).toHaveLength(1)
    expect(snapshot.artifacts[0]?.artifactType).toBe('event-log')
    expect(snapshot.events.map((event) => event.type)).toEqual([
      'artifact.recorded',
      'validation.recorded',
    ])
    expect(snapshot.events[1]?.validation?.status).toBe('failed')
    expect(snapshot.summary?.status).toBe('failed')
    expect(snapshot.summary?.validationCounts?.failed).toBe(1)
  })

  it('persists flow compile evidence as neutral managed artifact metadata', async () => {
    const runDir = await makeTmpDir()
    const store = new ScriptRunEventStore({ runId: 'script-run-compile-evidence', runDir })
    const compileEvidence = {
      schema: 'dzupagent.flowCompileEvidence/v1',
      sourceKind: 'dzupflow-dsl',
      sourceHash: 'sha256:abc123',
      compileId: 'compile-1',
      canonicalNodeIds: ['root', 'done'],
      canonicalNodePaths: {
        root: { type: 'sequence', id: 'root' },
        done: { type: 'complete', id: 'done' },
      },
      loweredTarget: 'skill-chain',
      correlationIds: {
        compileId: 'compile-1',
        eventCorrelationId: 'run-compile-1',
        runId: 'run-compile-1',
      },
    }

    await store.open()
    const artifact = await store.recordArtifact({
      artifactType: 'compile-evidence',
      name: 'compile-evidence.json',
      scriptPath: 'compile-evidence.json',
      createdAt: 7_000,
      correlationId: 'run-compile-1',
      metadata: {
        evidence: compileEvidence,
      },
    })
    await store.recordEvent({
      type: 'compile.evidence_recorded',
      timestamp: 7_001,
      artifact,
      correlationId: 'run-compile-1',
      metadata: {
        compileId: compileEvidence.compileId,
        sourceHash: compileEvidence.sourceHash,
      },
    })
    await store.close({ status: 'completed', startedAt: 7_000, completedAt: 7_100 })

    const snapshot = await store.readSnapshot()

    expect(snapshot.artifacts[0]?.artifactType).toBe('compile-evidence')
    expect(snapshot.artifacts[0]?.metadata?.evidence).toEqual(compileEvidence)
    expect(snapshot.events.map((event) => event.type)).toEqual([
      'artifact.recorded',
      'compile.evidence_recorded',
    ])
    expect(snapshot.events[1]?.metadata?.compileId).toBe('compile-1')
    expect(snapshot.summary?.artifactCount).toBe(1)
  })
})
