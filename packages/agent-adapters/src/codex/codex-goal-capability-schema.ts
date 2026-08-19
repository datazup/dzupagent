/**
 * Structural predicates over the JSON Schema documents Codex generates.
 *
 * Two layers live here on purpose: the generic reader primitives (`record`,
 * `array`, `hasRequired`, ...) and the per-document `valid*` shape checks built
 * from them. Nothing here reads the filesystem, inspects capabilities, or
 * reaches back into the protocol layer, so the dependency arrow points one way:
 * contracts -> schema -> protocol.
 */

import { GOAL_STATUSES } from './codex-goal-capability-contracts.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function hasRequired(schema: Record<string, unknown>, ...keys: string[]): boolean {
  const required = array(schema['required'])
  return keys.every((key) => required.includes(key))
}

export function hasTypes(schema: Record<string, unknown>, ...types: string[]): boolean {
  const actual = array(schema['type'])
  return actual.length === types.length && types.every((type) => actual.includes(type))
}

export function hasNullableReference(
  schema: Record<string, unknown>,
  reference: string,
): boolean {
  const choices = array(schema['anyOf'])
  return choices.length === 2
    && choices.some((choice) => isRecord(choice) && choice['$ref'] === reference)
    && choices.some((choice) => isRecord(choice) && choice['type'] === 'null')
}

export function hasAllOfReference(
  schema: Record<string, unknown>,
  reference: string,
): boolean {
  const choices = array(schema['allOf'])
  return choices.length === 1
    && isRecord(choices[0])
    && choices[0]['$ref'] === reference
}

export function exactEnum(schema: Record<string, unknown>, ...values: string[]): boolean {
  const actual = array(schema['enum'])
  return schema['type'] === 'string'
    && actual.length === values.length
    && values.every((value) => actual.includes(value))
}

export function integer64(value: unknown): boolean {
  const schema = record(value)
  return schema['type'] === 'integer' && schema['format'] === 'int64'
}

export function validInitializeParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  const definitions = record(schema['definitions'])
  const clientInfo = record(definitions['ClientInfo'])
  const clientProperties = record(clientInfo['properties'])
  const capabilities = record(definitions['InitializeCapabilities'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'clientInfo')
    && record(properties['clientInfo'])['$ref'] === '#/definitions/ClientInfo'
    && clientInfo['type'] === 'object'
    && hasRequired(clientInfo, 'name', 'version')
    && record(clientProperties['name'])['type'] === 'string'
    && record(clientProperties['version'])['type'] === 'string'
    && capabilities['type'] === 'object'
    && record(record(capabilities['properties'])['experimentalApi'])['type'] === 'boolean'
}

export function validInitializeResponse(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'codexHome', 'platformFamily', 'platformOs', 'userAgent')
    && hasAllOfReference(record(properties['codexHome']), '#/definitions/AbsolutePathBuf')
    && record(properties['platformFamily'])['type'] === 'string'
    && record(properties['platformOs'])['type'] === 'string'
    && record(properties['userAgent'])['type'] === 'string'
}

export function validThreadStartParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  const sandboxMode = record(record(schema['definitions'])['SandboxMode'])
  return schema['type'] === 'object'
    && hasTypes(record(properties['cwd']), 'string', 'null')
    && hasTypes(record(properties['model']), 'string', 'null')
    && hasTypes(record(properties['developerInstructions']), 'string', 'null')
    && hasNullableReference(record(properties['sandbox']), '#/definitions/SandboxMode')
    && exactEnum(sandboxMode, 'read-only', 'workspace-write', 'danger-full-access')
}

export function validThreadResumeParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return validThreadIdParams(schema)
    && hasTypes(record(properties['cwd']), 'string', 'null')
    && hasTypes(record(properties['model']), 'string', 'null')
}

export function validThreadResponse(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(
      schema,
      'approvalPolicy',
      'approvalsReviewer',
      'cwd',
      'model',
      'modelProvider',
      'sandbox',
      'thread',
    )
    && record(properties['thread'])['$ref'] === '#/definitions/Thread'
    && validThread(record(record(schema['definitions'])['Thread']))
}

export function validThreadStartedNotification(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'thread')
    && record(properties['thread'])['$ref'] === '#/definitions/Thread'
    && validThread(record(record(schema['definitions'])['Thread']))
}

function validThread(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(
      schema,
      'cliVersion',
      'createdAt',
      'cwd',
      'ephemeral',
      'id',
      'modelProvider',
      'preview',
      'sessionId',
      'source',
      'status',
      'turns',
      'updatedAt',
    )
    && record(properties['cliVersion'])['type'] === 'string'
    && integer64(properties['createdAt'])
    && record(properties['ephemeral'])['type'] === 'boolean'
    && record(properties['id'])['type'] === 'string'
    && record(properties['modelProvider'])['type'] === 'string'
    && record(properties['preview'])['type'] === 'string'
    && record(properties['sessionId'])['type'] === 'string'
    && record(properties['turns'])['type'] === 'array'
    && integer64(properties['updatedAt'])
}

export function validTurnStartParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  const input = record(properties['input'])
  const userInput = record(record(schema['definitions'])['UserInput'])
  return validThreadIdParams(schema)
    && hasRequired(schema, 'input')
    && input['type'] === 'array'
    && record(input['items'])['$ref'] === '#/definitions/UserInput'
    && array(userInput['oneOf']).some((candidate) => validTextUserInput(record(candidate)))
}

function validTextUserInput(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'text', 'type')
    && record(properties['text'])['type'] === 'string'
    && exactEnum(record(properties['type']), 'text')
}

export function validTurnResponse(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'turn')
    && record(properties['turn'])['$ref'] === '#/definitions/Turn'
    && validTurn(
      record(record(schema['definitions'])['Turn']),
      record(record(schema['definitions'])['TurnStatus']),
    )
}

export function validTurnNotification(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'threadId', 'turn')
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turn'])['$ref'] === '#/definitions/Turn'
    && validTurn(
      record(record(schema['definitions'])['Turn']),
      record(record(schema['definitions'])['TurnStatus']),
    )
}

function validTurn(
  schema: Record<string, unknown>,
  statusSchema: Record<string, unknown>,
): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'id', 'items', 'status')
    && record(properties['id'])['type'] === 'string'
    && record(properties['items'])['type'] === 'array'
    && record(properties['status'])['$ref'] === '#/definitions/TurnStatus'
    && exactEnum(statusSchema, 'completed', 'interrupted', 'failed', 'inProgress')
}

export function validTurnInterruptParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'threadId', 'turnId')
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turnId'])['type'] === 'string'
}

export function validEmptyObjectResponse(schema: Record<string, unknown>): boolean {
  return schema['type'] === 'object' && array(schema['required']).length === 0
}

export function validAgentMessageDelta(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'delta', 'itemId', 'threadId', 'turnId')
    && ['delta', 'itemId', 'threadId', 'turnId']
      .every((key) => record(properties[key])['type'] === 'string')
}

export function validTokenUsageNotification(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  const definitions = record(schema['definitions'])
  const usage = record(definitions['ThreadTokenUsage'])
  const usageProperties = record(usage['properties'])
  const breakdown = record(definitions['TokenUsageBreakdown'])
  const breakdownProperties = record(breakdown['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'threadId', 'tokenUsage', 'turnId')
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turnId'])['type'] === 'string'
    && record(properties['tokenUsage'])['$ref'] === '#/definitions/ThreadTokenUsage'
    && usage['type'] === 'object'
    && hasRequired(usage, 'last', 'total')
    && record(usageProperties['last'])['$ref'] === '#/definitions/TokenUsageBreakdown'
    && record(usageProperties['total'])['$ref'] === '#/definitions/TokenUsageBreakdown'
    && breakdown['type'] === 'object'
    && hasRequired(
      breakdown,
      'cachedInputTokens',
      'inputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'totalTokens',
    )
    && [
      'cachedInputTokens',
      'inputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'totalTokens',
    ].every((key) => integer64(breakdownProperties[key]))
}

export function validApprovalParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'itemId', 'startedAtMs', 'threadId', 'turnId')
    && record(properties['itemId'])['type'] === 'string'
    && record(properties['startedAtMs'])['type'] === 'integer'
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turnId'])['type'] === 'string'
}

export function validToolRequestUserInputParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'isBlocking', 'itemId', 'questions', 'threadId', 'turnId')
    && record(properties['isBlocking'])['type'] === 'boolean'
    && record(properties['itemId'])['type'] === 'string'
    && record(properties['questions'])['type'] === 'array'
    && record(properties['threadId'])['type'] === 'string'
    && record(properties['turnId'])['type'] === 'string'
}

export function validThreadIdParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'threadId')
    && record(properties['threadId'])['type'] === 'string'
}

export function validGoalSetParams(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return validThreadIdParams(schema)
    && hasTypes(record(properties['objective']), 'string', 'null')
    && hasNullableReference(record(properties['status']), '#/definitions/ThreadGoalStatus')
    && hasTypes(record(properties['tokenBudget']), 'integer', 'null')
    && record(properties['tokenBudget'])['format'] === 'int64'
    && validGoalStatus(record(record(schema['definitions'])['ThreadGoalStatus']))
}

export function validGoalResponse(
  schema: Record<string, unknown>,
  nullable: boolean,
): boolean {
  const properties = record(schema['properties'])
  const goal = record(properties['goal'])
  const reference = '#/definitions/ThreadGoal'
  const goalShapeValid = nullable
    ? hasNullableReference(goal, reference)
    : goal['$ref'] === reference && hasRequired(schema, 'goal')
  return schema['type'] === 'object'
    && goalShapeValid
    && validThreadGoal(record(record(schema['definitions'])['ThreadGoal']))
    && validGoalStatus(record(record(schema['definitions'])['ThreadGoalStatus']))
}

function validThreadGoal(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(
      schema,
      'createdAt',
      'objective',
      'status',
      'threadId',
      'timeUsedSeconds',
      'tokensUsed',
      'updatedAt',
    )
    && integer64(properties['createdAt'])
    && record(properties['objective'])['type'] === 'string'
    && record(properties['status'])['$ref'] === '#/definitions/ThreadGoalStatus'
    && record(properties['threadId'])['type'] === 'string'
    && integer64(properties['timeUsedSeconds'])
    && hasTypes(record(properties['tokenBudget']), 'integer', 'null')
    && record(properties['tokenBudget'])['format'] === 'int64'
    && integer64(properties['tokensUsed'])
    && integer64(properties['updatedAt'])
}

function validGoalStatus(schema: Record<string, unknown>): boolean {
  const statuses = array(schema['enum'])
  return schema['type'] === 'string'
    && statuses.length === GOAL_STATUSES.length
    && GOAL_STATUSES.every((status) => statuses.includes(status))
}

export function validClearResponse(schema: Record<string, unknown>): boolean {
  const properties = record(schema['properties'])
  return schema['type'] === 'object'
    && hasRequired(schema, 'cleared')
    && record(properties['cleared'])['type'] === 'boolean'
}
