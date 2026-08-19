/**
 * Capability inspection over an observed Codex schema corpus.
 *
 * Each `inspect*Protocol` answers one question: is the evidence for this
 * capability present and correctly shaped? A returned string is the denial
 * reason; `undefined` means the capability is observed. Nothing here decides
 * policy or builds a descriptor — that is the entry module's job.
 */

import {
  GOAL_METHODS,
  INTERACTION_REQUESTS,
  type CapabilityReasonMap,
} from './codex-goal-capability-contracts.js'
import {
  array,
  hasRequired,
  isRecord,
  record,
  validAgentMessageDelta,
  validApprovalParams,
  validClearResponse,
  validEmptyObjectResponse,
  validGoalResponse,
  validGoalSetParams,
  validInitializeParams,
  validInitializeResponse,
  validThreadIdParams,
  validThreadResponse,
  validThreadResumeParams,
  validThreadStartParams,
  validThreadStartedNotification,
  validTokenUsageNotification,
  validToolRequestUserInputParams,
  validTurnInterruptParams,
  validTurnNotification,
  validTurnResponse,
  validTurnStartParams,
} from './codex-goal-capability-schema.js'

export function inspectAppServerProtocol(
  documents: Readonly<Record<string, unknown>>,
): CapabilityReasonMap {
  const handshakeReason = inspectHandshakeProtocol(documents)
  const cancelReason = handshakeReason ?? inspectCancelProtocol(documents)
  const interactionShapeReason = handshakeReason ?? inspectInteractionProtocol(documents)
  return {
    execute: handshakeReason ?? inspectExecuteProtocol(documents),
    stream: handshakeReason ?? inspectStreamProtocol(documents),
    resume: handshakeReason ?? inspectResumeProtocol(documents),
    cancel: cancelReason,
    interaction: interactionShapeReason ?? 'interaction-resolution-not-qualified',
    usage: handshakeReason ?? inspectUsageProtocol(documents),
    'interrupt-turn': cancelReason,
    'goal-control': handshakeReason ?? inspectGoalProtocol(documents),
  }
}

function inspectHandshakeProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'ClientNotification.json',
    'v1/InitializeParams.json',
    'v1/InitializeResponse.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  if (!hasRequestMethod(record(documents['ClientRequest.json']), 'initialize', 'InitializeParams')) {
    return 'protocol-method-missing:initialize'
  }
  if (!hasNotificationMethod(record(documents['ClientNotification.json']), 'initialized')) {
    return 'protocol-method-missing:initialized'
  }
  if (!validInitializeParams(record(documents['v1/InitializeParams.json']))) {
    return 'protocol-shape-mismatch:InitializeParams'
  }
  if (!validInitializeResponse(record(documents['v1/InitializeResponse.json']))) {
    return 'protocol-shape-mismatch:InitializeResponse'
  }
  return undefined
}

function inspectExecuteProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'v2/ThreadStartParams.json',
    'v2/ThreadStartResponse.json',
    'v2/TurnStartParams.json',
    'v2/TurnStartResponse.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  const clientRequest = record(documents['ClientRequest.json'])
  for (const [method, paramsName] of [
    ['thread/start', 'ThreadStartParams'],
    ['turn/start', 'TurnStartParams'],
  ] as const) {
    if (!hasRequestMethod(clientRequest, method, paramsName)) {
      return `protocol-method-missing:${method}`
    }
  }
  if (!validThreadStartParams(record(documents['v2/ThreadStartParams.json']))) {
    return 'protocol-shape-mismatch:ThreadStartParams'
  }
  if (!validThreadResponse(record(documents['v2/ThreadStartResponse.json']))) {
    return 'protocol-shape-mismatch:ThreadStartResponse'
  }
  if (!validTurnStartParams(record(documents['v2/TurnStartParams.json']))) {
    return 'protocol-shape-mismatch:TurnStartParams'
  }
  if (!validTurnResponse(record(documents['v2/TurnStartResponse.json']))) {
    return 'protocol-shape-mismatch:TurnStartResponse'
  }
  return undefined
}

function inspectResumeProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'v2/ThreadResumeParams.json',
    'v2/ThreadResumeResponse.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  if (!hasRequestMethod(
    record(documents['ClientRequest.json']),
    'thread/resume',
    'ThreadResumeParams',
  )) {
    return 'protocol-method-missing:thread/resume'
  }
  if (!validThreadResumeParams(record(documents['v2/ThreadResumeParams.json']))) {
    return 'protocol-shape-mismatch:ThreadResumeParams'
  }
  if (!validThreadResponse(record(documents['v2/ThreadResumeResponse.json']))) {
    return 'protocol-shape-mismatch:ThreadResumeResponse'
  }
  return undefined
}

function inspectCancelProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'v2/TurnInterruptParams.json',
    'v2/TurnInterruptResponse.json',
    'v2/TurnCompletedNotification.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  if (!hasRequestMethod(
    record(documents['ClientRequest.json']),
    'turn/interrupt',
    'TurnInterruptParams',
  )) {
    return 'protocol-method-missing:turn/interrupt'
  }
  if (!validTurnInterruptParams(record(documents['v2/TurnInterruptParams.json']))) {
    return 'protocol-shape-mismatch:TurnInterruptParams'
  }
  if (!validEmptyObjectResponse(record(documents['v2/TurnInterruptResponse.json']))) {
    return 'protocol-shape-mismatch:TurnInterruptResponse'
  }
  if (!validTurnNotification(record(documents['v2/TurnCompletedNotification.json']))) {
    return 'protocol-shape-mismatch:TurnCompletedNotification'
  }
  return undefined
}

function inspectStreamProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ServerNotification.json',
    'v2/ThreadStartedNotification.json',
    'v2/TurnStartedNotification.json',
    'v2/AgentMessageDeltaNotification.json',
    'v2/TurnCompletedNotification.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  const serverNotification = record(documents['ServerNotification.json'])
  for (const [method, paramsName] of [
    ['thread/started', 'ThreadStartedNotification'],
    ['turn/started', 'TurnStartedNotification'],
    ['item/agentMessage/delta', 'AgentMessageDeltaNotification'],
    ['turn/completed', 'TurnCompletedNotification'],
  ] as const) {
    if (!hasNotificationMethod(serverNotification, method, paramsName)) {
      return `protocol-method-missing:${method}`
    }
  }
  if (!validThreadStartedNotification(record(documents['v2/ThreadStartedNotification.json']))) {
    return 'protocol-shape-mismatch:ThreadStartedNotification'
  }
  if (!validTurnNotification(record(documents['v2/TurnStartedNotification.json']))) {
    return 'protocol-shape-mismatch:TurnStartedNotification'
  }
  if (!validAgentMessageDelta(record(documents['v2/AgentMessageDeltaNotification.json']))) {
    return 'protocol-shape-mismatch:AgentMessageDeltaNotification'
  }
  if (!validTurnNotification(record(documents['v2/TurnCompletedNotification.json']))) {
    return 'protocol-shape-mismatch:TurnCompletedNotification'
  }
  return undefined
}

function inspectUsageProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ServerNotification.json',
    'v2/ThreadTokenUsageUpdatedNotification.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  if (!hasNotificationMethod(
    record(documents['ServerNotification.json']),
    'thread/tokenUsage/updated',
    'ThreadTokenUsageUpdatedNotification',
  )) {
    return 'protocol-method-missing:thread/tokenUsage/updated'
  }
  if (!validTokenUsageNotification(
    record(documents['v2/ThreadTokenUsageUpdatedNotification.json']),
  )) {
    return 'protocol-shape-mismatch:ThreadTokenUsageUpdatedNotification'
  }
  return undefined
}

function inspectInteractionProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ServerRequest.json',
    'CommandExecutionRequestApprovalParams.json',
    'FileChangeRequestApprovalParams.json',
    'ToolRequestUserInputParams.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }
  const serverRequest = record(documents['ServerRequest.json'])
  for (const [method, paramsName] of INTERACTION_REQUESTS) {
    if (!hasRequestMethod(serverRequest, method, paramsName)) {
      return `protocol-method-missing:${method}`
    }
  }
  if (!validApprovalParams(
    record(documents['CommandExecutionRequestApprovalParams.json']),
  )) {
    return 'protocol-shape-mismatch:CommandExecutionRequestApprovalParams'
  }
  if (!validApprovalParams(record(documents['FileChangeRequestApprovalParams.json']))) {
    return 'protocol-shape-mismatch:FileChangeRequestApprovalParams'
  }
  if (!validToolRequestUserInputParams(record(documents['ToolRequestUserInputParams.json']))) {
    return 'protocol-shape-mismatch:ToolRequestUserInputParams'
  }
  return undefined
}

function inspectGoalProtocol(
  documents: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const path of [
    'ClientRequest.json',
    'v2/ThreadGoalGetParams.json',
    'v2/ThreadGoalGetResponse.json',
    'v2/ThreadGoalSetParams.json',
    'v2/ThreadGoalSetResponse.json',
    'v2/ThreadGoalClearParams.json',
    'v2/ThreadGoalClearResponse.json',
  ] as const) {
    const missing = missingDocument(documents, path)
    if (missing) return missing
  }

  const clientRequest = record(documents['ClientRequest.json'])
  for (const [method, paramsName] of GOAL_METHODS) {
    if (!hasRequestMethod(clientRequest, method, paramsName)) {
      return `protocol-method-missing:${method}`
    }
  }

  if (!validThreadIdParams(record(documents['v2/ThreadGoalGetParams.json']))) {
    return 'protocol-shape-mismatch:ThreadGoalGetParams'
  }
  if (!validGoalSetParams(record(documents['v2/ThreadGoalSetParams.json']))) {
    return 'protocol-shape-mismatch:ThreadGoalSetParams'
  }
  if (!validThreadIdParams(record(documents['v2/ThreadGoalClearParams.json']))) {
    return 'protocol-shape-mismatch:ThreadGoalClearParams'
  }
  if (!validGoalResponse(record(documents['v2/ThreadGoalGetResponse.json']), true)) {
    return 'protocol-shape-mismatch:ThreadGoalGetResponse'
  }
  if (!validGoalResponse(record(documents['v2/ThreadGoalSetResponse.json']), false)) {
    return 'protocol-shape-mismatch:ThreadGoalSetResponse'
  }
  if (!validClearResponse(record(documents['v2/ThreadGoalClearResponse.json']))) {
    return 'protocol-shape-mismatch:ThreadGoalClearResponse'
  }
  return undefined
}

function hasRequestMethod(
  schema: Record<string, unknown>,
  method: string,
  paramsName: string,
): boolean {
  const branches = array(schema['oneOf'])
  return branches.some((candidate) => {
    if (!isRecord(candidate)) return false
    const properties = record(candidate['properties'])
    const methodSchema = record(properties['method'])
    const paramsSchema = record(properties['params'])
    return array(methodSchema['enum']).includes(method)
      && paramsSchema['$ref'] === `#/definitions/${paramsName}`
      && hasRequired(candidate, 'id', 'method', 'params')
      && candidate['type'] === 'object'
  })
}

function hasNotificationMethod(
  schema: Record<string, unknown>,
  method: string,
  paramsName?: string,
): boolean {
  const branches = array(schema['oneOf'])
  return branches.some((candidate) => {
    if (!isRecord(candidate)) return false
    const properties = record(candidate['properties'])
    const methodSchema = record(properties['method'])
    const paramsSchema = record(properties['params'])
    return array(methodSchema['enum']).includes(method)
      && hasRequired(candidate, 'method')
      && candidate['type'] === 'object'
      && (paramsName === undefined
        ? true
        : hasRequired(candidate, 'params')
          && paramsSchema['$ref'] === `#/definitions/${paramsName}`)
  })
}

function missingDocument(
  documents: Readonly<Record<string, unknown>>,
  path: string,
): string | undefined {
  return isRecord(documents[path]) ? undefined : `protocol-document-missing:${path}`
}
