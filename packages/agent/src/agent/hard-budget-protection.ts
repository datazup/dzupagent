import {
  SystemMessage,
  type AIMessage,
  type BaseMessage,
  type ToolMessage,
} from '@langchain/core/messages'
import type { TokenMeasurementResult } from '@dzupagent/context'

export const PROTECTED_TRANSCRIPT_MARKER =
  '...[older unprotected transcript removed to fit host budget]...'

/** Messages that a host treats as non-destructible at its provider boundary. */
export interface ProtectedTranscriptPolicy {
  /** Preserve every system message byte-for-byte and by object identity. */
  preserveSystemMessages: boolean
  /** Preserve this many most-recent human messages. */
  preserveLatestUserMessages: number
  /** Preserve this many most-recent AI tool-call/result groups. */
  preserveRecentToolCallGroups: number
}

/** Sanitized proof about the protected subset and deterministic removals. */
export interface ProtectedTranscriptEvidence {
  protectedMessageCount: number
  protectedToolGroupCount: number
  droppedMessageCount: number
}

export interface ProtectedTranscriptFitResult {
  /** Original messages on unsafe results; fitted messages otherwise. */
  messages: BaseMessage[]
  tokenMeasurement: TokenMeasurementResult
  adoptionSafe: boolean
  truncated: boolean
  markerIncluded: boolean
  evidence: ProtectedTranscriptEvidence
  reason?: string
}

interface ToolGroup {
  indices: Set<number>
  start: number
}

interface RemovalCandidate {
  indices: Set<number>
  start: number
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

export function validateProtectedTranscriptPolicy(
  policy: ProtectedTranscriptPolicy,
): void {
  if (typeof policy.preserveSystemMessages !== 'boolean') {
    throw new TypeError('preserveSystemMessages must be a boolean')
  }
  assertNonNegativeInteger(
    'preserveLatestUserMessages',
    policy.preserveLatestUserMessages,
  )
  assertNonNegativeInteger(
    'preserveRecentToolCallGroups',
    policy.preserveRecentToolCallGroups,
  )
}

function isProven(measurement: TokenMeasurementResult): boolean {
  return measurement.method === 'exact'
    || measurement.method === 'encoding-fallback'
}

function toolCallIds(message: BaseMessage): string[] {
  if (message._getType() !== 'ai') return []
  const calls = (message as AIMessage).tool_calls
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call) => call.id ? [call.id] : [])
}

function toolResultId(message: BaseMessage): string | undefined {
  if (message._getType() !== 'tool') return undefined
  return (message as ToolMessage).tool_call_id
}

function buildToolGroups(messages: BaseMessage[]): ToolGroup[] {
  const groups: ToolGroup[] = []
  const byCallId = new Map<string, ToolGroup>()

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    const ids = toolCallIds(message)
    if (ids.length === 0) continue
    const existingGroups = [...new Set(ids.flatMap((id) => {
      const group = byCallId.get(id)
      return group ? [group] : []
    }))]
    const group = existingGroups[0]
      ?? { indices: new Set<number>(), start: index }
    if (existingGroups.length === 0) groups.push(group)
    for (const merged of existingGroups.slice(1)) {
      for (const mergedIndex of merged.indices) group.indices.add(mergedIndex)
      group.start = Math.min(group.start, merged.start)
      groups.splice(groups.indexOf(merged), 1)
      for (const [id, mapped] of byCallId) {
        if (mapped === merged) byCallId.set(id, group)
      }
    }
    group.indices.add(index)
    group.start = Math.min(group.start, index)
    for (const id of ids) byCallId.set(id, group)
  }

  const orphanGroups = new Map<string, ToolGroup>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    const callId = toolResultId(message)
    if (!callId) continue
    let group = byCallId.get(callId)
    if (!group) {
      group = orphanGroups.get(callId)
      if (!group) {
        group = { indices: new Set(), start: index }
        orphanGroups.set(callId, group)
        groups.push(group)
      }
    }
    group.indices.add(index)
    group.start = Math.min(group.start, index)
  }

  return groups.sort((left, right) => left.start - right.start)
}

function insertMarker(
  messages: BaseMessage[],
  removed: ReadonlySet<number>,
): BaseMessage[] {
  const firstRemoved = Math.min(...removed)
  const result: BaseMessage[] = []
  let inserted = false
  for (let index = 0; index < messages.length; index++) {
    if (!inserted && index >= firstRemoved && !removed.has(index)) {
      result.push(new SystemMessage(PROTECTED_TRANSCRIPT_MARKER))
      inserted = true
    }
    if (!removed.has(index)) result.push(messages[index]!)
  }
  if (!inserted) result.push(new SystemMessage(PROTECTED_TRANSCRIPT_MARKER))
  return result
}

function buildProtectionSets(
  messages: BaseMessage[],
  policy: ProtectedTranscriptPolicy,
): {
  protectedIndices: Set<number>
  protectedGroups: Set<ToolGroup>
  groups: ToolGroup[]
} {
  const protectedIndices = new Set<number>()
  if (policy.preserveSystemMessages) {
    messages.forEach((message, index) => {
      if (message._getType() === 'system') protectedIndices.add(index)
    })
  }

  const humanIndices = messages.flatMap((message, index) =>
    message._getType() === 'human' ? [index] : [],
  )
  for (const index of humanIndices.slice(-policy.preserveLatestUserMessages)) {
    protectedIndices.add(index)
  }

  const groups = buildToolGroups(messages)
  const protectedGroups = new Set(
    groups.slice(-policy.preserveRecentToolCallGroups),
  )
  for (const group of protectedGroups) {
    for (const index of group.indices) protectedIndices.add(index)
  }
  return { protectedIndices, protectedGroups, groups }
}

function buildRemovalCandidates(
  messages: BaseMessage[],
  groups: ToolGroup[],
  protectedIndices: ReadonlySet<number>,
): RemovalCandidate[] {
  const groupedIndices = new Set<number>()
  const candidates: RemovalCandidate[] = []
  for (const group of groups) {
    for (const index of group.indices) groupedIndices.add(index)
    if ([...group.indices].some((index) => protectedIndices.has(index))) continue
    candidates.push({ indices: group.indices, start: group.start })
  }
  messages.forEach((_message, index) => {
    if (!groupedIndices.has(index) && !protectedIndices.has(index)) {
      candidates.push({ indices: new Set([index]), start: index })
    }
  })
  return candidates.sort((left, right) => left.start - right.start)
}

/**
 * Fit a transcript without rewriting protected content. Tool call/result
 * groups are retained or removed atomically, and the complete removal marker
 * is part of every successful destructive fit.
 */
export function fitProtectedTranscript(args: {
  messages: BaseMessage[]
  tokenBudget: number
  policy: ProtectedTranscriptPolicy
  measure: (messages: BaseMessage[]) => TokenMeasurementResult
}): ProtectedTranscriptFitResult {
  assertNonNegativeInteger('tokenBudget', args.tokenBudget)
  validateProtectedTranscriptPolicy(args.policy)
  const originalMeasurement = args.measure(args.messages)
  const { protectedIndices, protectedGroups, groups } = buildProtectionSets(
    args.messages,
    args.policy,
  )
  const baseEvidence = {
    protectedMessageCount: protectedIndices.size,
    protectedToolGroupCount: protectedGroups.size,
    droppedMessageCount: 0,
  }
  if (!isProven(originalMeasurement)) {
    return {
      messages: [...args.messages],
      tokenMeasurement: originalMeasurement,
      adoptionSafe: false,
      truncated: false,
      markerIncluded: false,
      evidence: baseEvidence,
      reason: originalMeasurement.reason ?? 'protected transcript measurement is unproven',
    }
  }
  if (originalMeasurement.tokens <= args.tokenBudget) {
    return {
      messages: [...args.messages],
      tokenMeasurement: originalMeasurement,
      adoptionSafe: true,
      truncated: false,
      markerIncluded: false,
      evidence: baseEvidence,
    }
  }

  const removed = new Set<number>()
  for (const candidate of buildRemovalCandidates(
    args.messages,
    groups,
    protectedIndices,
  )) {
    for (const index of candidate.indices) removed.add(index)
    const messages = insertMarker(args.messages, removed)
    const measurement = args.measure(messages)
    if (!isProven(measurement)) {
      return {
        messages: [...args.messages],
        tokenMeasurement: measurement,
        adoptionSafe: false,
        truncated: false,
        markerIncluded: false,
        evidence: baseEvidence,
        reason: measurement.reason ?? 'protected transcript measurement is unproven',
      }
    }
    if (measurement.tokens <= args.tokenBudget) {
      return {
        messages,
        tokenMeasurement: measurement,
        adoptionSafe: true,
        truncated: true,
        markerIncluded: true,
        evidence: {
          ...baseEvidence,
          droppedMessageCount: removed.size,
        },
      }
    }
  }

  const finalMessages = removed.size > 0
    ? insertMarker(args.messages, removed)
    : [...args.messages]
  const finalMeasurement = args.measure(finalMessages)
  return {
    messages: [...args.messages],
    tokenMeasurement: finalMeasurement,
    adoptionSafe: false,
    truncated: false,
    markerIncluded: false,
    evidence: baseEvidence,
    reason: 'protected transcript and complete marker exceed the host budget',
  }
}
