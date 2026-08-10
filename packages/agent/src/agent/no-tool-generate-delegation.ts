import type { AgentMessageItem } from '@dzupagent/agent-types/run'

import type { DzupAgentConfig, GenerateOptions, GenerateResult } from './agent-types.js'
import type { PreparedRunState } from './run-engine/types.js'
import { estimateConversationTokensForMessages } from './message-utils.js'
import {
  buildRunnerProviderFreeExecutionProfile,
  evaluateRunnerProviderFreeExecutionProfile,
} from '../runner/legacy-runner-execution-profile.js'
import {
  captureLegacyNoToolResultEnvelope,
  projectLegacyNoToolGenerateResult,
} from '../runner/legacy-runner-no-tool-result-envelope.js'
import {
  captureMessageEnvelopeEntry,
  createLegacyRunnerMessageItem,
  reconstructLegacyMessage,
  type LegacyMessageEnvelopeEntry,
} from '../runner/legacy-runner-message-envelope-codec.js'
import { RunControl } from '../runner/run-control.js'
import type { AgentRunnerInput } from '../runner/runner-ports.js'
import {
  AGENT_RUNNER_NO_TOOL_DELEGATION_ADMISSION_SCHEMA,
  AGENT_RUNNER_NO_TOOL_DELEGATION_SOURCE_SCHEMA,
  AgentRunnerNoToolDelegationError,
  validateAgentRunnerNoToolDelegationAdmission,
  validateAgentRunnerNoToolDelegationSource,
  type AgentRunnerNoToolDelegationAdmission,
  type AgentRunnerNoToolDelegationOutcome,
  type AgentRunnerNoToolDelegationRequest,
  type AgentRunnerNoToolDelegationSource,
  type AgentRunnerNoToolPreDispatchPolicy,
} from '../runner/no-tool-generate-delegation.js'
import { digestRunnerJson } from '../runner/runner-values.js'

const R5N_BEHAVIOR_SCHEMA = 'dzupagent.experimentalNoToolGenerateBehavior/v1' as const
const MAX_TOOL_ATTEMPTS = 2

const DISABLED_CONFIG_FIELDS = [
  'structuredOutputCapabilities', 'messageConfig', 'hardBudget', 'messagePhase',
  'eventBus', 'hooks', 'agentsDir', 'selfLearning', 'onReflectionComplete',
  'onReflectionError', 'reflectionAnalyzerConfig', 'mailbox', 'tokenLifecyclePlugin',
  'toolExecution', 'providerFailover', 'rateLimiter', 'security', 'runStateStore',
  'memory', 'memoryClient', 'memoryScope', 'memoryNamespace', 'memoryContextMode',
  'memoryQueryMaxChars', 'ttlMs', 'arrowMemory', 'loadArrowRuntime', 'memoryProfile',
  'frozenSnapshot', 'memoryDecayThreshold', 'memoryPolicy', 'memoryContextLimits',
  'auditStore', 'auditRedaction', 'onFallback', 'onFallbackDetail',
  'toolStatsTracker', 'tokenizer',
] as const

const ALLOWED_GENERATE_OPTION_FIELDS = new Set([
  'runId',
  'signal',
  'maxIterations',
  'experimentalNoToolGenerateDelegation',
])

function normalizedIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u.test(value)
}

function normalizedCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...expected].sort().join('|')
}

function effectiveOptionKeys(options: GenerateOptions): string[] {
  return Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
}

function configurationIneligibility(
  config: DzupAgentConfig,
  options: GenerateOptions,
  runState: PreparedRunState,
): string | undefined {
  if (effectiveOptionKeys(options).some((key) => !ALLOWED_GENERATE_OPTION_FIELDS.has(key))) {
    return 'generate-options-unsupported'
  }
  if (config.instructionsMode !== undefined && config.instructionsMode !== 'static') {
    return 'dynamic-instructions-enabled'
  }
  if (config.permissionTier !== undefined && config.permissionTier !== 'read-only') {
    return 'permission-tier-unsupported'
  }
  if ((config.tools?.length ?? 0) !== 0 || runState.tools.length !== 0) {
    return 'tools-enabled'
  }
  if ((config.middleware?.length ?? 0) !== 0) return 'middleware-enabled'
  if ((config.outputFilters?.length ?? 0) !== 0) return 'output-filter-enabled'
  if (config.memoryWriteBack !== undefined && config.memoryWriteBack !== false) {
    return 'memory-write-back-enabled'
  }
  if (DISABLED_CONFIG_FIELDS.some((field) => config[field] !== undefined)) {
    return 'configuration-extension-enabled'
  }
  if (runState.memoryFrame !== undefined) return 'memory-frame-present'
  if (config.maxIterations !== undefined) return 'legacy-max-iterations-ambiguous'
  const guardrails = config.guardrails
  if (guardrails === undefined
      || !exactKeys(guardrails, ['maxIterations', 'stuckDetector'])
      || guardrails.stuckDetector !== false
      || !Number.isSafeInteger(guardrails.maxIterations)
      || Number(guardrails.maxIterations) < 1) {
    return 'guardrail-profile-ineligible'
  }
  if (options.maxIterations !== undefined
      && (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1)) {
    return 'max-model-turns-invalid'
  }
  return undefined
}

function delegationError(input: {
  readonly code: string
  readonly phase: 'admission' | 'before-dispatch' | 'after-dispatch' | 'outcome-unknown'
  readonly replay: 'not-dispatched' | 'forbidden-after-dispatch' | 'forbidden-unknown-outcome'
  readonly admission?: AgentRunnerNoToolDelegationAdmission
}): AgentRunnerNoToolDelegationError {
  return new AgentRunnerNoToolDelegationError(input)
}

function failClosedOrFallback(
  policy: AgentRunnerNoToolPreDispatchPolicy,
  code: string,
  phase: 'admission' | 'before-dispatch',
  admission?: AgentRunnerNoToolDelegationAdmission,
): undefined {
  if (policy === 'fallback-to-legacy') return undefined
  throw delegationError({ code, phase, replay: 'not-dispatched', ...(admission ? { admission } : {}) })
}

function createInputItem(
  message: PreparedRunState['preparedMessages'][number],
  runId: string,
  index: number,
): AgentMessageItem | string {
  const identityDigest = digestRunnerJson({ runId, index })
  const itemId = `r5n-input-${index + 1}-${identityDigest.slice('sha256:'.length, 23)}`
  return createLegacyRunnerMessageItem(message, itemId)
}

function createAdmission(input: {
  readonly config: DzupAgentConfig
  readonly policy: AgentRunnerNoToolPreDispatchPolicy
  readonly runId: string
  readonly bridgeId: string
  readonly runState: PreparedRunState
}): {
  readonly admission: AgentRunnerNoToolDelegationAdmission
  readonly requestInput: AgentRunnerInput
  readonly preparedMessages: PreparedRunState['preparedMessages']
  readonly profile: ReturnType<typeof buildRunnerProviderFreeExecutionProfile>
} | string {
  const items: AgentMessageItem[] = []
  const preparedEntries: LegacyMessageEnvelopeEntry[] = []
  for (const [index, message] of input.runState.preparedMessages.entries()) {
    const item = createInputItem(message, input.runId, index)
    if (typeof item === 'string') return item
    const captured = captureMessageEnvelopeEntry(message, item, index)
    if (typeof captured === 'string') return captured
    items.push(item)
    preparedEntries.push(captured)
  }

  const preparedMessages: PreparedRunState['preparedMessages'] = preparedEntries.map(
    (entry) => reconstructLegacyMessage(entry),
  )
  Object.freeze(preparedMessages)
  const observedMessageTokens = estimateConversationTokensForMessages(preparedMessages)
  const behaviorDigest = digestRunnerJson({
    schema: R5N_BEHAVIOR_SCHEMA,
    agentId: input.config.id,
    instructions: input.config.instructions,
    bridgeId: input.bridgeId,
    maxModelTurns: input.runState.maxIterations,
    maxToolAttempts: MAX_TOOL_ATTEMPTS,
  })
  let profile: ReturnType<typeof buildRunnerProviderFreeExecutionProfile>
  try {
    profile = buildRunnerProviderFreeExecutionProfile({
      behaviorDigest,
      maxModelTurns: input.runState.maxIterations,
      maxToolAttempts: MAX_TOOL_ATTEMPTS,
      observedMessageCount: preparedMessages.length,
      observedMessageTokens,
      structuredOutputRequested: false,
      legacyResultProjection: 'no-tool-generate-delegation/v1',
    })
  } catch {
    return 'prepared-input-outside-profile-bounds'
  }
  if (evaluateRunnerProviderFreeExecutionProfile(profile, behaviorDigest).status !== 'eligible') {
    return 'execution-profile-ineligible'
  }

  const requestInput: AgentRunnerInput = {
    agentId: input.config.id,
    behaviorDigest,
    items,
  }
  const sourceBody = {
    schema: AGENT_RUNNER_NO_TOOL_DELEGATION_SOURCE_SCHEMA,
    bridgeId: input.bridgeId,
    runId: input.runId,
    agentId: input.config.id,
    behaviorDigest,
    profileDigest: profile.profileDigest,
    inputDigest: digestRunnerJson(requestInput),
    preparedMessageDigest: digestRunnerJson(preparedEntries),
  } as const
  const source: AgentRunnerNoToolDelegationSource = {
    ...sourceBody,
    sourceDigest: digestRunnerJson(sourceBody),
  }
  const admissionBody = {
    schema: AGENT_RUNNER_NO_TOOL_DELEGATION_ADMISSION_SCHEMA,
    decision: 'delegate',
    policy: input.policy,
    source,
    observedMessageCount: preparedMessages.length,
    observedMessageTokens,
    maxModelTurns: input.runState.maxIterations,
    maxToolAttempts: MAX_TOOL_ATTEMPTS,
  } as const
  const admission: AgentRunnerNoToolDelegationAdmission = {
    ...admissionBody,
    admissionDigest: digestRunnerJson(admissionBody),
  }
  if (!validateAgentRunnerNoToolDelegationAdmission(admission)) {
    return 'admission-record-invalid'
  }
  return { admission, requestInput, preparedMessages, profile }
}

function sameSource(
  expected: AgentRunnerNoToolDelegationSource,
  actual: unknown,
): actual is AgentRunnerNoToolDelegationSource {
  return validateAgentRunnerNoToolDelegationSource(actual)
    && actual.sourceDigest === expected.sourceDigest
    && digestRunnerJson(actual) === digestRunnerJson(expected)
}

async function dispatchOnce(
  request: AgentRunnerNoToolDelegationRequest,
  dispatch: (request: AgentRunnerNoToolDelegationRequest) => Promise<AgentRunnerNoToolDelegationOutcome>,
): Promise<AgentRunnerNoToolDelegationOutcome> {
  const cancel = (): void => {
    request.control.requestCancel()
  }
  request.signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await dispatch(request)
  } catch {
    throw delegationError({
      code: 'bridge-threw-with-unknown-outcome',
      phase: 'outcome-unknown',
      replay: 'forbidden-unknown-outcome',
      admission: request.admission,
    })
  } finally {
    request.signal?.removeEventListener('abort', cancel)
  }
}

/**
 * Attempt the exact R5N direct-call subset. `undefined` means the explicitly
 * selected legacy path remains responsible for the already-prepared run state.
 */
export async function maybeDelegateNoToolGenerate(input: {
  readonly agentId: string
  readonly config: DzupAgentConfig
  readonly options: GenerateOptions | undefined
  readonly runState: PreparedRunState
}): Promise<GenerateResult | undefined> {
  const optIn = input.options?.experimentalNoToolGenerateDelegation
  if (optIn === undefined) return undefined
  if (!exactKeys(optIn, ['enabled', 'preDispatchPolicy'])
      || optIn.enabled !== true
      || !['fail-closed', 'fallback-to-legacy'].includes(String(optIn.preDispatchPolicy))) {
    throw delegationError({
      code: 'delegation-opt-in-malformed',
      phase: 'admission',
      replay: 'not-dispatched',
    })
  }
  const policy = optIn.preDispatchPolicy
  const options = input.options ?? {}
  if (options.signal?.aborted) {
    throw delegationError({
      code: 'cancelled-before-dispatch',
      phase: 'before-dispatch',
      replay: 'not-dispatched',
    })
  }
  const bridge = input.config.experimentalNoToolGenerateBridge
  if (bridge === undefined || !normalizedIdentity(bridge.bridgeId)
      || typeof bridge.dispatch !== 'function') {
    return failClosedOrFallback(policy, 'bridge-unavailable', 'admission')
  }
  const ineligible = configurationIneligibility(input.config, options, input.runState)
  if (ineligible !== undefined) {
    return failClosedOrFallback(policy, ineligible, 'admission')
  }
  const runId = options.runId
  if (!normalizedIdentity(runId)) {
    return failClosedOrFallback(policy, 'run-id-required', 'admission')
  }

  const created = createAdmission({
    config: input.config,
    policy,
    runId,
    bridgeId: bridge.bridgeId,
    runState: input.runState,
  })
  if (typeof created === 'string') {
    return failClosedOrFallback(policy, created, 'admission')
  }

  const control = new RunControl()
  const request: AgentRunnerNoToolDelegationRequest = {
    admission: created.admission,
    input: created.requestInput,
    preparedMessages: created.preparedMessages,
    profile: created.profile,
    control,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const outcome = await dispatchOnce(request, (value) => bridge.dispatch(value))
  if (outcome === null || typeof outcome !== 'object'
      || !sameSource(created.admission.source, outcome.source)) {
    throw delegationError({
      code: 'bridge-source-binding-unknown',
      phase: 'outcome-unknown',
      replay: 'forbidden-unknown-outcome',
      admission: created.admission,
    })
  }
  if (outcome.status === 'rejected-before-dispatch') {
    if (!normalizedCode(outcome.code)) {
      throw delegationError({
        code: 'bridge-rejection-malformed',
        phase: 'outcome-unknown',
        replay: 'forbidden-unknown-outcome',
        admission: created.admission,
      })
    }
    return failClosedOrFallback(
      policy,
      `bridge-rejected-${outcome.code}`,
      'before-dispatch',
      created.admission,
    )
  }
  if (outcome.status === 'failed-after-dispatch') {
    throw delegationError({
      code: normalizedCode(outcome.code) ? `bridge-failed-${outcome.code}` : 'bridge-failure-malformed',
      phase: 'after-dispatch',
      replay: 'forbidden-after-dispatch',
      admission: created.admission,
    })
  }
  if (outcome.status === 'outcome-unknown') {
    throw delegationError({
      code: normalizedCode(outcome.code) ? `bridge-unknown-${outcome.code}` : 'bridge-unknown-malformed',
      phase: 'outcome-unknown',
      replay: 'forbidden-unknown-outcome',
      admission: created.admission,
    })
  }
  if (outcome.status !== 'completed') {
    throw delegationError({
      code: 'bridge-outcome-malformed',
      phase: 'outcome-unknown',
      replay: 'forbidden-unknown-outcome',
      admission: created.admission,
    })
  }

  if (outcome.result.state.runId !== runId
      || outcome.result.state.agent.initialAgentId !== input.agentId
      || outcome.result.state.agent.currentAgentId !== input.agentId
      || outcome.result.state.agent.behaviorDigest !== created.requestInput.behaviorDigest) {
    throw delegationError({
      code: 'post-dispatch-runner-source-mismatch',
      phase: 'after-dispatch',
      replay: 'forbidden-after-dispatch',
      admission: created.admission,
    })
  }
  let captured: ReturnType<typeof captureLegacyNoToolResultEnvelope>
  try {
    captured = captureLegacyNoToolResultEnvelope({
      profile: created.profile,
      preparedInput: created.preparedMessages,
      finalAssistant: outcome.finalAssistant,
      result: outcome.result,
    })
  } catch {
    throw delegationError({
      code: 'post-dispatch-envelope-capture-threw',
      phase: 'after-dispatch',
      replay: 'forbidden-after-dispatch',
      admission: created.admission,
    })
  }
  if (captured.status !== 'captured') {
    throw delegationError({
      code: `post-dispatch-envelope-${captured.reasons[0] ?? 'rejected'}`,
      phase: 'after-dispatch',
      replay: 'forbidden-after-dispatch',
      admission: created.admission,
    })
  }
  let projected: ReturnType<typeof projectLegacyNoToolGenerateResult>
  try {
    projected = projectLegacyNoToolGenerateResult({
      profile: created.profile,
      expectedProfileDigest: created.profile.profileDigest,
      expectedBehaviorDigest: created.requestInput.behaviorDigest,
      expectedEnvelopeDigest: captured.envelope.envelopeDigest,
      envelope: captured.envelope,
      result: outcome.result,
    })
  } catch {
    throw delegationError({
      code: 'post-dispatch-result-projection-threw',
      phase: 'after-dispatch',
      replay: 'forbidden-after-dispatch',
      admission: created.admission,
    })
  }
  if (projected.status !== 'projected') {
    throw delegationError({
      code: `post-dispatch-projection-${projected.reasons[0] ?? 'rejected'}`,
      phase: 'after-dispatch',
      replay: 'forbidden-after-dispatch',
      admission: created.admission,
    })
  }
  return projected.result
}
