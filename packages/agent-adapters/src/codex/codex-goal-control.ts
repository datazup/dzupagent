import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

import type {
  ProviderSessionAdapter,
} from '@dzupagent/adapter-types/provider-session'
import {
  PROVIDER_SESSION_GOAL_STATUSES,
  PROVIDER_SESSION_OPERATION_SCHEMA,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  validateProviderSessionAttemptBinding,
  type ProviderSessionAttemptBinding,
  type ProviderSessionGoalClearRequest,
  type ProviderSessionGoalGetRequest,
  type ProviderSessionGoalSetRequest,
  type ProviderSessionGoalSnapshot,
  type ProviderSessionGoalStatus,
} from '@dzupagent/runtime-contracts/provider-session'

import {
  CodexAppServerStdioClient,
  type CodexAppServerClientDependencies,
  type CodexAppServerClientOptions,
} from './codex-app-server-client.js'
import type { ResolvedProbeExecutable } from '../introspection/index.js'

type GoalControlMethods = Required<
  Pick<ProviderSessionAdapter, 'getGoal' | 'setGoal' | 'clearGoal'>
>

export type CodexGoalControlAdapter = Pick<
  ProviderSessionAdapter,
  'attemptBinding'
> & GoalControlMethods

export interface CodexGoalControlOptions {
  attemptBinding: ProviderSessionAttemptBinding
  executable: ResolvedProbeExecutable
  timeoutMs?: number | undefined
  env?: Readonly<Record<string, string>> | undefined
  dependencies?: CodexAppServerClientDependencies | undefined
}

interface GoalControlContext {
  readonly attemptBindingId: string
  readonly clientOptions: CodexAppServerClientOptions
}

const MAX_THREAD_ID_LENGTH = 512
const MAX_OPERATION_ID_LENGTH = 512
const MAX_OBJECTIVE_LENGTH = 4_000
const CODEX_GOAL_STATUSES = new Set([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
])

/**
 * Creates the Codex App Server companion for thread-level durable-goal state.
 *
 * Goal RPCs update local thread lifecycle state but never start a model turn.
 * The returned projection hashes and omits the raw objective so callers cannot
 * accidentally persist provider/user prompt content as orchestration state.
 */
export function createCodexGoalControlAdapter(
  options: CodexGoalControlOptions,
): CodexGoalControlAdapter {
  const admission = validateProviderSessionAttemptBinding(
    options.attemptBinding,
    ['goal-control'],
  )
  if (!admission.valid) {
    throw new Error('Codex goal control requires an admitted native goal-control binding')
  }
  if (
    !options.executable
    || options.executable.name !== 'codex'
    || !isAbsolute(options.executable.path)
    || !isAbsolute(options.executable.realPath)
  ) {
    throw new Error('Codex goal control requires a resolved qualified executable identity')
  }

  const context: GoalControlContext = {
    attemptBindingId: options.attemptBinding.bindingId,
    clientOptions: {
      executable: options.executable,
      ...(options.env ? { env: options.env } : {}),
      limits: { requestTimeoutMs: finiteTimeout(options.timeoutMs) },
      clientInfo: {
        name: 'dzupagent_goal_control',
        title: 'DzupAgent Goal Control',
        version: '0.2.0',
      },
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    },
  }

  return {
    attemptBinding: options.attemptBinding,
    getGoal: async (request) => {
      assertBaseRequest(request, 'goal-get', context)
      const threadId = assertThreadRef(request.thread)
      const result = await callCodexAppServer(
        context,
        'thread/goal/get',
        { threadId },
      )
      return {
        kind: 'goal-get',
        goal: normalizeGoalEnvelope(result, threadId, true),
      }
    },
    setGoal: async (request) => {
      assertBaseRequest(request, 'goal-set', context)
      const threadId = assertThreadRef(request.thread)
      const params = goalSetParams(request, threadId)
      const result = await callCodexAppServer(
        context,
        'thread/goal/set',
        params,
      )
      const goal = normalizeGoalEnvelope(result, threadId, false)
      if (!goal) throw new Error('Codex app-server returned no goal after goal/set')
      return { kind: 'goal-set', goal }
    },
    clearGoal: async (request) => {
      assertBaseRequest(request, 'goal-clear', context)
      const threadId = assertThreadRef(request.thread)
      const result = objectValue(await callCodexAppServer(
        context,
        'thread/goal/clear',
        { threadId },
      ))
      if (typeof result['cleared'] !== 'boolean') {
        throw new Error('Codex app-server returned an invalid goal/clear response')
      }
      return { kind: 'goal-clear', cleared: result['cleared'] }
    },
  }
}

function assertBaseRequest(
  request:
    | ProviderSessionGoalGetRequest
    | ProviderSessionGoalSetRequest
    | ProviderSessionGoalClearRequest,
  kind: typeof request.kind,
  context: GoalControlContext,
): void {
  if (
    request.schema !== PROVIDER_SESSION_OPERATION_SCHEMA
    || request.kind !== kind
    || request.attemptBindingId !== context.attemptBindingId
    || !boundedText(request.operationId, MAX_OPERATION_ID_LENGTH)
  ) {
    throw new Error(`Invalid provider-session ${kind} request`)
  }
}

function assertThreadRef(
  thread: ProviderSessionGoalGetRequest['thread'],
): string {
  if (
    thread.schema !== PROVIDER_SESSION_REFERENCE_SCHEMA
    || thread.kind !== 'thread'
    || !boundedText(thread.opaqueId, MAX_THREAD_ID_LENGTH)
  ) {
    throw new Error('Invalid provider-session thread reference')
  }
  return thread.opaqueId
}

function goalSetParams(
  request: ProviderSessionGoalSetRequest,
  threadId: string,
): Record<string, unknown> {
  const hasObjective = Object.hasOwn(request, 'objective')
  const hasStatus = Object.hasOwn(request, 'status')
  const hasTokenBudget = Object.hasOwn(request, 'tokenBudget')
  if (!hasObjective && !hasStatus && !hasTokenBudget) {
    throw new Error('Provider-session goal-set requires at least one update')
  }

  const params: Record<string, unknown> = { threadId }
  if (hasObjective) {
    if (!boundedText(request.objective, MAX_OBJECTIVE_LENGTH)) {
      throw new Error('Provider-session goal objective must contain 1 to 4000 characters')
    }
    params['objective'] = request.objective
  }
  if (hasStatus) {
    if (!request.status || !PROVIDER_SESSION_GOAL_STATUSES.includes(request.status)) {
      throw new Error('Provider-session goal status is invalid')
    }
    params['status'] = toCodexStatus(request.status)
  }
  if (hasTokenBudget) {
    if (
      request.tokenBudget !== null
      && (!Number.isSafeInteger(request.tokenBudget) || Number(request.tokenBudget) <= 0)
    ) {
      throw new Error('Provider-session goal token budget must be null or a positive integer')
    }
    params['tokenBudget'] = request.tokenBudget
  }
  return params
}

async function callCodexAppServer(
  context: GoalControlContext,
  method: 'thread/goal/get' | 'thread/goal/set' | 'thread/goal/clear',
  params: Record<string, unknown>,
): Promise<unknown> {
  const client = await CodexAppServerStdioClient.connect(context.clientOptions)
  try {
    return await client.request(method, params)
  } finally {
    await client.close()
  }
}

function normalizeGoalEnvelope(
  value: unknown,
  expectedThreadId: string,
  nullable: boolean,
): ProviderSessionGoalSnapshot | null {
  const envelope = objectValue(value)
  if (envelope['goal'] === null && nullable) return null
  const goal = objectValue(envelope['goal'])
  const threadId = stringValue(goal['threadId'])
  const objective = stringValue(goal['objective'])
  const status = fromCodexStatus(stringValue(goal['status']))
  const tokenBudget = nullablePositiveInteger(goal['tokenBudget'])
  const tokensUsed = nonNegativeInteger(goal['tokensUsed'])
  const timeUsedSeconds = nonNegativeNumber(goal['timeUsedSeconds'])
  if (
    threadId !== expectedThreadId
    || !boundedText(objective, MAX_OBJECTIVE_LENGTH)
    || !status
    || tokenBudget === undefined
    || tokensUsed === undefined
    || timeUsedSeconds === undefined
  ) {
    throw new Error('Codex app-server returned an invalid thread goal')
  }
  return {
    thread: {
      schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
      kind: 'thread',
      opaqueId: threadId,
    },
    objectiveDigest: `sha256:${createHash('sha256').update(objective).digest('hex')}`,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
  }
}

function toCodexStatus(status: ProviderSessionGoalStatus): string {
  if (status === 'usage-limited') return 'usageLimited'
  if (status === 'budget-limited') return 'budgetLimited'
  return status
}

function fromCodexStatus(status: string): ProviderSessionGoalStatus | null {
  if (!CODEX_GOAL_STATUSES.has(status)) return null
  if (status === 'usageLimited') return 'usage-limited'
  if (status === 'budgetLimited') return 'budget-limited'
  return status as ProviderSessionGoalStatus
}

function finiteTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : 30_000
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function nullablePositiveInteger(value: unknown): number | null | undefined {
  if (value === null) return null
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
