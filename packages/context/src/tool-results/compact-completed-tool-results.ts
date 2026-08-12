import type { BaseMessage, ToolMessage } from '@langchain/core/messages'

import type { TokenMeasurementResult } from '../token-lifecycle.js'
import {
  COMPACTED_CONTENT,
  MAX_TOOL_CALL_ID_LENGTH,
  cloneCompactedToolMessage,
  contentText,
  hasOnlyDataProperties,
  isPlainRecord,
  measureMessages,
  measureText,
  measurementIsProven,
  safeMessageType,
  safeToolCalls,
  type CompactionOptions,
} from './compaction-internals.js'
import type {
  CompletedToolCompactionProfileV1,
  CompletedToolCompactionReasonV1,
  CompletedToolCompactionResultV1,
} from './types.js'

const MAX_MESSAGES = 512

interface CompletedPair {
  callId: string
  messageIndex: number
}

interface PairingResult {
  ok: boolean
  completedPairs: CompletedPair[]
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number.isFinite(value) &&
    (value as number) >= minimum && (value as number) <= maximum
}

function decodeProfile(value: unknown): CompletedToolCompactionProfileV1 | null {
  if (!isPlainRecord(value) || !hasOnlyDataProperties(value)) return null
  const allowed = new Set([
    'schema',
    'preserveRecentCompletedPairs',
    'minimumResultTokens',
    'maxCompactedResults',
    'targetReclaimedTokens',
    'measurement',
  ])
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return null
  }
  if (keys.some(key => !allowed.has(key))) return null
  if (value.schema !== 'datazup.context.completed-tool-compaction-profile/v1') return null
  if (!boundedInteger(value.preserveRecentCompletedPairs, 0, 256)) return null
  if (!boundedInteger(value.minimumResultTokens, 1, 1_000_000)) return null
  if (!boundedInteger(value.maxCompactedResults, 1, 256)) return null
  if (
    value.targetReclaimedTokens !== undefined &&
    !boundedInteger(value.targetReclaimedTokens, 1, 1_000_000)
  ) return null
  if (value.measurement !== 'allow-heuristic' && value.measurement !== 'require-tokenizer') {
    return null
  }
  return {
    schema: value.schema,
    preserveRecentCompletedPairs: value.preserveRecentCompletedPairs,
    minimumResultTokens: value.minimumResultTokens,
    maxCompactedResults: value.maxCompactedResults,
    ...(value.targetReclaimedTokens !== undefined
      ? { targetReclaimedTokens: value.targetReclaimedTokens }
      : {}),
    measurement: value.measurement,
  }
}

function fixedResult(
  messages: BaseMessage[],
  status: CompletedToolCompactionResultV1['status'],
  reason: CompletedToolCompactionReasonV1,
  measurement?: TokenMeasurementResult,
): CompletedToolCompactionResultV1 {
  return {
    schema: 'datazup.context.completed-tool-compaction-result/v1',
    status,
    reason,
    messages,
    beforeTokens: measurement?.tokens ?? 0,
    afterTokens: measurement?.tokens ?? 0,
    reclaimedTokens: 0,
    measurementMethod: measurement?.method ?? 'heuristic',
    ...(measurement?.model ? { model: measurement.model } : {}),
    compactedToolCallIds: [],
  }
}

function analyzePairing(messages: BaseMessage[]): PairingResult {
  const declared = new Map<string, number>()
  const groups: Array<{
    index: number
    callIds: string[]
    resultIndices: number[]
    open: boolean
  }> = []
  let currentGroup: (typeof groups)[number] | undefined

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined || message === null || typeof message !== 'object') {
      return { ok: false, completedPairs: [] }
    }
    const type = safeMessageType(message)
    if (type === null) return { ok: false, completedPairs: [] }

    if (type === 'ai') {
      if (currentGroup) currentGroup.open = false
      const calls = safeToolCalls(message)
      if (calls === null) return { ok: false, completedPairs: [] }
      if (calls.length === 0) {
        currentGroup = undefined
        continue
      }
      const callIds: string[] = []
      for (const call of calls) {
        if (!isPlainRecord(call) || !hasOnlyDataProperties(call)) {
          return { ok: false, completedPairs: [] }
        }
        let id: unknown
        try {
          id = call.id
        } catch {
          return { ok: false, completedPairs: [] }
        }
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TOOL_CALL_ID_LENGTH) {
          return { ok: false, completedPairs: [] }
        }
        if (declared.has(id)) return { ok: false, completedPairs: [] }
        declared.set(id, index)
        callIds.push(id)
      }
      currentGroup = { index, callIds, resultIndices: [], open: true }
      groups.push(currentGroup)
      continue
    }

    if (type === 'tool') {
      let callId: unknown
      try {
        callId = (message as ToolMessage).tool_call_id
      } catch {
        return { ok: false, completedPairs: [] }
      }
      if (
        typeof callId !== 'string' ||
        callId.length === 0 ||
        callId.length > MAX_TOOL_CALL_ID_LENGTH ||
        currentGroup === undefined ||
        !currentGroup.open ||
        declared.get(callId) !== currentGroup.index
      ) return { ok: false, completedPairs: [] }
      const expectedId = currentGroup.callIds[currentGroup.resultIndices.length]
      if (expectedId !== callId) return { ok: false, completedPairs: [] }
      currentGroup.resultIndices.push(index)
      if (currentGroup.resultIndices.length === currentGroup.callIds.length) {
        currentGroup.open = false
      }
      continue
    }

    if (currentGroup) currentGroup.open = false
    currentGroup = undefined
  }

  const completedPairs: CompletedPair[] = []
  for (const group of groups) {
    if (group.resultIndices.length !== group.callIds.length) continue
    for (let offset = 0; offset < group.callIds.length; offset += 1) {
      const callId = group.callIds[offset]
      const messageIndex = group.resultIndices[offset]
      if (callId === undefined || messageIndex === undefined) {
        return { ok: false, completedPairs: [] }
      }
      completedPairs.push({ callId, messageIndex })
    }
  }
  return { ok: true, completedPairs }
}

/**
 * Replace only old, fully paired tool results with a fixed content-free marker.
 * The input transcript is never mutated and any ambiguous pairing fails closed.
 */
export function compactCompletedToolResults(
  messages: BaseMessage[],
  profileInput: CompletedToolCompactionProfileV1,
  options: CompactionOptions = {},
): CompletedToolCompactionResultV1 {
  let validMessageArray = false
  try {
    validMessageArray = Array.isArray(messages) && hasOnlyDataProperties(messages) &&
      messages.length <= MAX_MESSAGES
  } catch {
    // Fall through to the fixed invalid-input result below.
  }
  if (!validMessageArray) {
    return fixedResult(messages, 'rejected', 'invalid-input')
  }
  let profile: CompletedToolCompactionProfileV1 | null
  try {
    profile = decodeProfile(profileInput)
  } catch {
    profile = null
  }
  if (profile === null) return fixedResult(messages, 'rejected', 'invalid-profile')

  let pairing: PairingResult
  try {
    pairing = analyzePairing(messages)
  } catch {
    return fixedResult(messages, 'rejected', 'invalid-tool-pairing')
  }
  if (!pairing.ok) {
    return fixedResult(messages, 'rejected', 'invalid-tool-pairing')
  }

  let beforeMeasurement: TokenMeasurementResult
  try {
    beforeMeasurement = measureMessages(messages, options)
  } catch {
    return fixedResult(messages, 'rejected', 'invalid-input')
  }
  if (profile.measurement === 'require-tokenizer' && !measurementIsProven(beforeMeasurement)) {
    return fixedResult(messages, 'rejected', 'token-measurement-unproven', beforeMeasurement)
  }
  const eligibleCount = Math.max(
    0,
    pairing.completedPairs.length - profile.preserveRecentCompletedPairs,
  )
  if (eligibleCount === 0) {
    return fixedResult(messages, 'unchanged', 'no-eligible-results', beforeMeasurement)
  }

  let output: BaseMessage[]
  try {
    output = messages.slice()
  } catch {
    return fixedResult(messages, 'rejected', 'invalid-input', beforeMeasurement)
  }
  const compactedToolCallIds: string[] = []
  let afterMeasurement = beforeMeasurement
  let cloneRejected = false
  let measurementRejected = false
  for (const pair of pairing.completedPairs.slice(0, eligibleCount)) {
    if (compactedToolCallIds.length >= profile.maxCompactedResults) break
    if (
      profile.targetReclaimedTokens !== undefined &&
      beforeMeasurement.tokens - afterMeasurement.tokens >= profile.targetReclaimedTokens
    ) break
    const message = output[pair.messageIndex]
    if (message === undefined || safeMessageType(message) !== 'tool') {
      return fixedResult(messages, 'rejected', 'invalid-tool-pairing', beforeMeasurement)
    }
    let originalContent: string
    try {
      originalContent = contentText(message)
    } catch {
      return fixedResult(messages, 'rejected', 'invalid-input', beforeMeasurement)
    }
    if (originalContent === COMPACTED_CONTENT) continue
    let contentMeasurement: TokenMeasurementResult
    try {
      contentMeasurement = measureText(originalContent, options)
    } catch {
      return fixedResult(messages, 'rejected', 'token-measurement-unproven', beforeMeasurement)
    }
    if (
      profile.measurement === 'require-tokenizer' &&
      !measurementIsProven(contentMeasurement)
    ) return fixedResult(messages, 'rejected', 'token-measurement-unproven', beforeMeasurement)
    if (contentMeasurement.tokens < profile.minimumResultTokens) continue

    let replacement: ToolMessage
    try {
      replacement = cloneCompactedToolMessage(message as ToolMessage)
    } catch {
      cloneRejected = true
      break
    }
    const tentative = output.slice()
    tentative[pair.messageIndex] = replacement
    let tentativeMeasurement: TokenMeasurementResult
    try {
      tentativeMeasurement = measureMessages(tentative, options)
    } catch {
      measurementRejected = true
      break
    }
    if (
      profile.measurement === 'require-tokenizer' &&
      !measurementIsProven(tentativeMeasurement)
    ) {
      measurementRejected = true
      break
    }
    if (tentativeMeasurement.tokens >= afterMeasurement.tokens) continue
    output = tentative
    afterMeasurement = tentativeMeasurement
    compactedToolCallIds.push(pair.callId)
  }

  if (measurementRejected) {
    return fixedResult(messages, 'rejected', 'token-measurement-unproven', beforeMeasurement)
  }
  if (cloneRejected) return fixedResult(messages, 'rejected', 'clone-rejected', beforeMeasurement)
  if (compactedToolCallIds.length === 0) {
    return fixedResult(messages, 'unchanged', 'no-token-reclamation', beforeMeasurement)
  }
  const reclaimedTokens = Math.max(0, beforeMeasurement.tokens - afterMeasurement.tokens)
  const targetMet = profile.targetReclaimedTokens === undefined ||
    reclaimedTokens >= profile.targetReclaimedTokens
  return {
    schema: 'datazup.context.completed-tool-compaction-result/v1',
    status: targetMet ? 'completed' : 'partial',
    reason: targetMet ? 'compacted' : 'target-not-met',
    messages: output,
    beforeTokens: beforeMeasurement.tokens,
    afterTokens: afterMeasurement.tokens,
    reclaimedTokens,
    measurementMethod: afterMeasurement.method,
    ...(afterMeasurement.model ? { model: afterMeasurement.model } : {}),
    compactedToolCallIds,
  }
}
