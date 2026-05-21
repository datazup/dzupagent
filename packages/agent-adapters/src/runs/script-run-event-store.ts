/**
 * ScriptRunEventStore persists neutral managed-run events and artifact metadata.
 *
 * Layout: <runDir>/
 *   managed-events.jsonl  — one ManagedRunEvent per line
 *   artifact-index.jsonl  — one ManagedArtifactRef per line
 *   summary.json          — ManagedRunSummary
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, relative } from 'node:path'

import { parseJsonl } from '@dzupagent/core'

import { runLogRoot } from './run-log-root.js'

import type {
  ApprovalDecision,
  ApprovalDecisionRecord,
  ManagedArtifactRef,
  ManagedArtifactType,
  ManagedRunEvent,
  ManagedRunEventLevel,
  ManagedRunEventType,
  ManagedRunStatus,
  ManagedRunSummary,
  ReviewDecision,
  ReviewDecisionRecord,
  ValidationRecord,
  ValidationStatus,
} from '@dzupagent/runtime-contracts'

export type {
  ApprovalDecision,
  ApprovalDecisionRecord,
  ManagedArtifactRef,
  ManagedArtifactType,
  ManagedRunEvent,
  ManagedRunEventLevel,
  ManagedRunEventType,
  ManagedRunStatus,
  ManagedRunSummary,
  ReviewDecision,
  ReviewDecisionRecord,
  ValidationRecord,
  ValidationStatus,
} from '@dzupagent/runtime-contracts'

interface BufferedScriptEntry {
  file: 'event' | 'artifact'
  line: string
}

export interface ScriptRunEventStoreOptions {
  runId: string
  projectDir?: string
  runDir?: string
  strict?: boolean
}

export interface AppendManagedRunEventInput {
  type: ManagedRunEventType
  timestamp?: number
  level?: ManagedRunEventLevel
  message?: string
  auditRunId?: string
  planningRunId?: string
  packetId?: string
  executionRunId?: string
  correlationId?: string
  parentEventId?: string
  artifact?: ManagedArtifactRef
  validation?: ManagedRunEvent['validation']
  reviewDecision?: ManagedRunEvent['reviewDecision']
  approvalDecision?: ManagedRunEvent['approvalDecision']
  metadata?: Record<string, unknown>
}

export interface AppendManagedArtifactInput {
  id?: string
  artifactType: ManagedArtifactType
  name: string
  scriptPath: string
  absolutePath?: string
  mimeType?: string
  checksum?: string
  checksumAlgorithm?: ManagedArtifactRef['checksumAlgorithm']
  sizeBytes?: number
  producedBy?: string
  createdAt?: number
  auditRunId?: string
  planningRunId?: string
  packetId?: string
  executionRunId?: string
  correlationId?: string
  metadata?: Record<string, unknown>
}

export interface RecordManagedArtifactFileInput
  extends Omit<
    AppendManagedArtifactInput,
    'name' | 'scriptPath' | 'absolutePath' | 'checksum' | 'checksumAlgorithm' | 'sizeBytes'
  > {
  absolutePath: string
  name?: string
  scriptPath?: string
}

export interface RecordManagedValidationInput extends Omit<ValidationRecord, 'id' | 'runId'> {
  id?: string
}

export interface RecordManagedReviewDecisionInput extends Omit<ReviewDecisionRecord, 'id' | 'runId'> {
  id?: string
}

export interface RecordManagedApprovalDecisionInput extends Omit<ApprovalDecisionRecord, 'id' | 'runId'> {
  id?: string
}

export interface ManagedRunSnapshot {
  events: ManagedRunEvent[]
  artifacts: ManagedArtifactRef[]
  summary?: ManagedRunSummary
}

export type ManagedRunSummaryInput = Partial<ManagedRunSummary> & {
  status?: ManagedRunStatus
}

export class ScriptRunEventStore {
  private readonly runId: string
  private readonly runDir: string
  private readonly strict: boolean
  private isOpen = false
  private startedAt?: number
  private eventCount = 0
  private artifactCount = 0
  private buffer: BufferedScriptEntry[] = []
  private artifacts: ManagedArtifactRef[] = []
  private validationCounts: Partial<Record<ValidationStatus, number>> = {}
  private reviewDecisionCounts: Partial<Record<ReviewDecision, number>> = {}
  private approvalDecisionCounts: Partial<Record<ApprovalDecision, number>> = {}

  constructor({ runId, projectDir, runDir, strict = false }: ScriptRunEventStoreOptions) {
    if (!projectDir && !runDir) {
      throw new Error('ScriptRunEventStore requires either projectDir or runDir')
    }

    this.runId = runId
    this.runDir = runDir ?? runLogRoot(projectDir as string, runId)
    this.strict = strict
  }

  get directory(): string {
    return this.runDir
  }

  async open(): Promise<void> {
    this.startedAt ??= Date.now()

    try {
      await mkdir(this.runDir, { recursive: true })
      this.isOpen = true
    } catch (err: unknown) {
      this.isOpen = true
      this.handleDiskError(`create run directory ${this.runDir}`, err)
    }

    const buffered = this.buffer.splice(0)
    for (const entry of buffered) {
      await this.writeLine(entry.file, entry.line)
    }
  }

  async appendEvent(event: ManagedRunEvent): Promise<void> {
    this.startedAt ??= event.timestamp
    this.eventCount += 1

    const line = JSON.stringify(event)
    if (!this.isOpen) {
      this.buffer.push({ file: 'event', line })
      return
    }

    await this.writeLine('event', line)
  }

  async recordEvent(input: AppendManagedRunEventInput): Promise<ManagedRunEvent> {
    const timestamp = input.timestamp ?? Date.now()
    const event: ManagedRunEvent = {
      id: this.nextId('event', this.eventCount + 1),
      runId: this.runId,
      type: input.type,
      timestamp,
      level: input.level,
      message: input.message,
      auditRunId: input.auditRunId,
      planningRunId: input.planningRunId,
      packetId: input.packetId,
      executionRunId: input.executionRunId,
      correlationId: input.correlationId,
      parentEventId: input.parentEventId,
      artifact: input.artifact,
      validation: input.validation,
      reviewDecision: input.reviewDecision,
      approvalDecision: input.approvalDecision,
      metadata: input.metadata,
    }

    await this.appendEvent(event)
    return event
  }

  async appendArtifact(artifact: ManagedArtifactRef): Promise<void> {
    this.artifactCount += 1
    this.artifacts.push(artifact)

    const line = JSON.stringify(artifact)
    if (!this.isOpen) {
      this.buffer.push({ file: 'artifact', line })
      return
    }

    await this.writeLine('artifact', line)
  }

  async recordArtifact(input: AppendManagedArtifactInput): Promise<ManagedArtifactRef> {
    const artifact: ManagedArtifactRef = {
      id: input.id ?? this.nextId('artifact', this.artifactCount + 1),
      runId: this.runId,
      artifactType: input.artifactType,
      name: input.name,
      scriptPath: input.scriptPath,
      absolutePath: input.absolutePath,
      mimeType: input.mimeType,
      checksum: input.checksum,
      checksumAlgorithm: input.checksumAlgorithm,
      sizeBytes: input.sizeBytes,
      producedBy: input.producedBy,
      createdAt: input.createdAt ?? Date.now(),
      auditRunId: input.auditRunId,
      planningRunId: input.planningRunId,
      packetId: input.packetId,
      executionRunId: input.executionRunId,
      correlationId: input.correlationId,
      metadata: input.metadata,
    }

    await this.appendArtifact(artifact)
    await this.recordEvent({
      type: 'artifact.recorded',
      timestamp: artifact.createdAt,
      artifact,
      auditRunId: artifact.auditRunId,
      planningRunId: artifact.planningRunId,
      packetId: artifact.packetId,
      executionRunId: artifact.executionRunId,
      correlationId: artifact.correlationId,
    })

    return artifact
  }

  async recordArtifactFile(input: RecordManagedArtifactFileInput): Promise<ManagedArtifactRef> {
    const fileMetadata = await this.readArtifactFileMetadata(input.absolutePath)

    return this.recordArtifact({
      ...input,
      name: input.name ?? basename(input.absolutePath),
      scriptPath: input.scriptPath ?? relative(this.runDir, input.absolutePath),
      ...fileMetadata,
    })
  }

  async recordValidation(input: RecordManagedValidationInput): Promise<ValidationRecord> {
    const validation: ValidationRecord = {
      ...input,
      id: input.id ?? this.nextId('validation', this.eventCount + 1),
      runId: this.runId,
    }

    this.incrementCount(this.validationCounts, validation.status)
    await this.recordEvent({
      type: 'validation.recorded',
      timestamp: validation.completedAt ?? validation.startedAt,
      validation,
      auditRunId: validation.auditRunId,
      planningRunId: validation.planningRunId,
      packetId: validation.packetId,
      executionRunId: validation.executionRunId,
      correlationId: validation.correlationId,
    })

    return validation
  }

  async recordReviewDecision(input: RecordManagedReviewDecisionInput): Promise<ReviewDecisionRecord> {
    const reviewDecision: ReviewDecisionRecord = {
      ...input,
      id: input.id ?? this.nextId('review', this.eventCount + 1),
      runId: this.runId,
    }

    this.incrementCount(this.reviewDecisionCounts, reviewDecision.decision)
    await this.recordEvent({
      type: 'review.decision_recorded',
      timestamp: reviewDecision.reviewedAt,
      reviewDecision,
      auditRunId: reviewDecision.auditRunId,
      planningRunId: reviewDecision.planningRunId,
      packetId: reviewDecision.packetId,
      executionRunId: reviewDecision.executionRunId,
      correlationId: reviewDecision.correlationId,
    })

    return reviewDecision
  }

  async recordApprovalDecision(input: RecordManagedApprovalDecisionInput): Promise<ApprovalDecisionRecord> {
    const approvalDecision: ApprovalDecisionRecord = {
      ...input,
      id: input.id ?? this.nextId('approval', this.eventCount + 1),
      runId: this.runId,
    }

    this.incrementCount(this.approvalDecisionCounts, approvalDecision.decision)
    await this.recordEvent({
      type: 'approval.decision_recorded',
      timestamp: approvalDecision.decidedAt,
      approvalDecision,
      auditRunId: approvalDecision.auditRunId,
      planningRunId: approvalDecision.planningRunId,
      packetId: approvalDecision.packetId,
      executionRunId: approvalDecision.executionRunId,
      correlationId: approvalDecision.correlationId,
    })

    return approvalDecision
  }

  async close(summary: ManagedRunSummaryInput = {}): Promise<ManagedRunSummary> {
    const completedAt = summary.completedAt ?? Date.now()
    const startedAt = summary.startedAt ?? this.startedAt ?? completedAt
    const managedSummary: ManagedRunSummary = {
      ...summary,
      runId: this.runId,
      status: summary.status ?? 'completed',
      startedAt,
      completedAt,
      durationMs: summary.durationMs ?? Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount ?? this.eventCount,
      artifactCount: summary.artifactCount ?? this.artifactCount,
      artifacts: summary.artifacts ?? this.artifacts,
      ...(summary.validationCounts
        ? { validationCounts: summary.validationCounts }
        : this.hasCounts(this.validationCounts)
          ? { validationCounts: this.validationCounts }
          : {}),
      ...(summary.reviewDecisionCounts
        ? { reviewDecisionCounts: summary.reviewDecisionCounts }
        : this.hasCounts(this.reviewDecisionCounts)
          ? { reviewDecisionCounts: this.reviewDecisionCounts }
          : {}),
      ...(summary.approvalDecisionCounts
        ? { approvalDecisionCounts: summary.approvalDecisionCounts }
        : this.hasCounts(this.approvalDecisionCounts)
          ? { approvalDecisionCounts: this.approvalDecisionCounts }
          : {}),
    }

    try {
      await writeFile(join(this.runDir, 'summary.json'), JSON.stringify(managedSummary, null, 2), 'utf8')
    } catch (err: unknown) {
      this.handleDiskError(`write summary for run ${this.runId}`, err)
    }

    return managedSummary
  }

  async readSummary(): Promise<ManagedRunSummary | undefined> {
    try {
      const raw = await readFile(join(this.runDir, 'summary.json'), 'utf8')
      return JSON.parse(raw) as ManagedRunSummary
    } catch {
      return undefined
    }
  }

  async readEvents(): Promise<ManagedRunEvent[]> {
    return this.readJsonLines<ManagedRunEvent>('event')
  }

  async readArtifacts(): Promise<ManagedArtifactRef[]> {
    return this.readJsonLines<ManagedArtifactRef>('artifact')
  }

  async readSnapshot(): Promise<ManagedRunSnapshot> {
    const [events, artifacts, summary] = await Promise.all([
      this.readEvents(),
      this.readArtifacts(),
      this.readSummary(),
    ])

    return {
      events,
      artifacts,
      ...(summary ? { summary } : {}),
    }
  }

  private fileNameFor(file: BufferedScriptEntry['file']): string {
    switch (file) {
      case 'event':
        return 'managed-events.jsonl'
      case 'artifact':
        return 'artifact-index.jsonl'
    }
  }

  private async readJsonLines<T>(file: BufferedScriptEntry['file']): Promise<T[]> {
    try {
      const raw = await readFile(join(this.runDir, this.fileNameFor(file)), 'utf8')
      return parseJsonl<T>(raw)
    } catch (err: unknown) {
      this.handleDiskError(`read ${this.fileNameFor(file)} for run ${this.runId}`, err)
      return []
    }
  }

  private async writeLine(file: BufferedScriptEntry['file'], line: string): Promise<void> {
    const filePath = join(this.runDir, this.fileNameFor(file))
    try {
      await appendFile(filePath, line + '\n', 'utf8')
    } catch (err: unknown) {
      this.handleDiskError(`append to ${this.fileNameFor(file)} for run ${this.runId}`, err)
    }
  }

  private async checksumFile(filePath: string): Promise<string> {
    const raw = await readFile(filePath)
    return createHash('sha256').update(raw).digest('hex')
  }

  private async readArtifactFileMetadata(
    filePath: string,
  ): Promise<Pick<ManagedArtifactRef, 'checksum' | 'checksumAlgorithm' | 'sizeBytes'>> {
    try {
      const [fileStat, checksum] = await Promise.all([
        stat(filePath),
        this.checksumFile(filePath),
      ])

      return {
        checksum,
        checksumAlgorithm: 'sha256',
        sizeBytes: fileStat.size,
      }
    } catch (err: unknown) {
      this.handleDiskError(`read artifact metadata from ${filePath}`, err)
      return {}
    }
  }

  private nextId(prefix: string, index: number): string {
    return `${this.runId}:${prefix}:${index}`
  }

  private incrementCount<T extends string>(counts: Partial<Record<T, number>>, key: T): void {
    counts[key] = (counts[key] ?? 0) + 1
  }

  private hasCounts<T extends string>(counts: Partial<Record<T, number>>): boolean {
    return Object.keys(counts).length > 0
  }

  private handleDiskError(action: string, err: unknown): void {
    if (this.strict) {
      throw err
    }

    process.stderr.write(`[ScriptRunEventStore] Failed to ${action}: ${String(err)}\n`)
  }
}
