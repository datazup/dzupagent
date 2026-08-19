import type { RunnableConfig } from '@langchain/core/runnables'

/** Namespaced runnable-config key reserved for built-in human-contact calls. */
export const HUMAN_CONTACT_RUNNABLE_CONFIG_KEY = 'dzupagentHumanContact'

/** Exact identity supplied for one logical human-contact tool invocation. */
export interface HumanContactInvocationContext {
  runId: string
  tenantId: string
  invocationId: string
  profileKey?: string
}

/** Run-scoped context held by generic executors until the tool-call ID exists. */
export type HumanContactRunContext = Omit<
  HumanContactInvocationContext,
  'invocationId'
>

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim().length > 0 ? value : undefined
}

function contextError(): Error {
  return new Error(
    'HUMAN_CONTACT_CONTEXT_REQUIRED: runId, tenantId, and invocationId must be non-empty',
  )
}

/** Validate and copy context so caller mutation cannot alter an active call. */
export function validateHumanContactInvocationContext(
  value: unknown,
): HumanContactInvocationContext {
  if (typeof value !== 'object' || value === null) throw contextError()
  const candidate = value as Record<string, unknown>
  const runId = nonBlankString(candidate['runId'])
  const tenantId = nonBlankString(candidate['tenantId'])
  const invocationId = nonBlankString(candidate['invocationId'])
  if (!runId || !tenantId || !invocationId) throw contextError()
  const profileKey = nonBlankString(candidate['profileKey'])
  return {
    runId,
    tenantId,
    invocationId,
    ...(profileKey !== undefined ? { profileKey } : {}),
  }
}

/** Build the explicit config required by standalone human-contact consumers. */
export function humanContactRunnableConfig(
  context: HumanContactInvocationContext,
  signal?: AbortSignal,
): RunnableConfig {
  const validated = validateHumanContactInvocationContext(context)
  return {
    configurable: { [HUMAN_CONTACT_RUNNABLE_CONFIG_KEY]: validated },
    ...(signal !== undefined ? { signal } : {}),
  }
}

/** Read and validate the Agent-owned context at the tool boundary. */
export function readHumanContactInvocationContext(
  config: RunnableConfig | undefined,
): HumanContactInvocationContext {
  return validateHumanContactInvocationContext(
    config?.configurable?.[HUMAN_CONTACT_RUNNABLE_CONFIG_KEY],
  )
}

/** Add the exact tool-call ID to a run-scoped executor context. */
export function toolInvocationRunnableConfig(
  context: HumanContactRunContext | undefined,
  invocationId: string,
  signal?: AbortSignal,
): RunnableConfig {
  if (context === undefined) {
    return signal !== undefined ? { signal } : {}
  }
  return humanContactRunnableConfig({ ...context, invocationId }, signal)
}

/** Resolve non-empty call precedence without manufacturing an unknown run. */
export function resolveHumanContactRunContext(options: {
  runId?: string | undefined
  fallbackRunId?: string | undefined
  tenantId?: string | undefined
  profileKey?: string | undefined
}): HumanContactRunContext | undefined {
  const runId = nonBlankString(options.runId) ?? nonBlankString(options.fallbackRunId)
  if (runId === undefined) return undefined
  const tenantId = nonBlankString(options.tenantId) ?? 'default'
  const profileKey = nonBlankString(options.profileKey)
  return {
    runId,
    tenantId,
    ...(profileKey !== undefined ? { profileKey } : {}),
  }
}
