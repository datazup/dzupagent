import type { AgentMessageItem } from '@dzupagent/agent-types/run'
import type { DzupAgentConfig, GenerateOptions, GenerateResult } from './agent-types.js'
import type { PreparedRunState } from './run-engine/types.js'
import { estimateConversationTokensForMessages } from './message-utils.js'
import { buildRunnerProviderFreeExecutionProfile } from '../runner/legacy-runner-execution-profile.js'
import { createLegacyRunnerMessageItem, captureMessageEnvelopeEntry, reconstructLegacyMessage } from '../runner/legacy-runner-message-envelope-codec.js'
import { boundedMessageShape, exactMessage, captureLegacyReadToolResultEnvelope,
  projectLegacyReadToolGenerateResult, type LegacyReadToolTiming } from '../runner/legacy-runner-read-tool-result-envelope.js'
import { assertDurableJson, cloneDurableJson } from '../runner/runner-durable-json.js'
import { digestRunnerJson } from '../runner/runner-values.js'
import { RunControl } from '../runner/run-control.js'
import {
  AgentRunnerReadToolDelegationError, readToolDataRecord, readToolIdentity,
  validateAgentRunnerReadToolBinding, validateAgentRunnerReadToolDelegationAdmission,
  validateAgentRunnerReadToolDelegationSource, type AgentRunnerReadToolDelegationAdmission,
  type AgentRunnerReadToolDelegationRequest, type AgentRunnerReadToolDelegationOutcome,
  type AgentRunnerReadToolPreDispatchPolicy,
} from '../runner/read-tool-generate-delegation.js'

const fields = new Set(['id', 'name', 'description', 'instructions', 'model', 'tools', 'guardrails',
  'middleware', 'outputFilters', 'memoryWriteBack', 'permissionTier', 'instructionsMode',
  'toolExecution', 'experimentalReadToolGenerateBridge'])
const optionFields = new Set(['runId', 'signal', 'maxIterations', 'experimentalReadToolGenerateDelegation'])
const error = (code: string, phase: ConstructorParameters<typeof AgentRunnerReadToolDelegationError>[1],
  admission?: AgentRunnerReadToolDelegationAdmission) =>
  new AgentRunnerReadToolDelegationError(code, phase, phase === 'admission' || phase === 'before-dispatch'
    ? 'not-dispatched' : phase === 'outcome-unknown' ? 'forbidden-unknown-outcome' : 'forbidden-after-dispatch', admission)

function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.getOwnPropertyNames(value).length === value.length + 1
    && Object.getOwnPropertyNames(value).every((key) => key === 'length' ||
      (/^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length
        && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
        && 'value' in Object.getOwnPropertyDescriptor(value, key)!))
}

function json(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') { assertDurableJson(value); return }
  if (seen.has(value) || !(dense(value) || readToolDataRecord(value))) throw new Error('invalid-json-shape')
  seen.add(value)
  for (const child of Object.values(value)) json(child, seen)
  seen.delete(value)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function selection(options?: GenerateOptions) {
  if (options === undefined) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(options, 'experimentalReadToolGenerateDelegation')
  if (descriptor === undefined && !('experimentalReadToolGenerateDelegation' in options)) return undefined
  if (descriptor !== undefined && 'value' in descriptor && descriptor.value === undefined) return undefined
  if (!readToolDataRecord(options) || descriptor === undefined
      || !readToolDataRecord(descriptor.value, ['enabled', 'preDispatchPolicy'])
      || descriptor.value.enabled !== true
      || (descriptor.value.preDispatchPolicy !== 'fail-closed' && descriptor.value.preDispatchPolicy !== 'fallback-to-legacy')
      || options.experimentalNoToolGenerateDelegation !== undefined) throw error('generate-options-malformed', 'admission')
  return descriptor.value as NonNullable<GenerateOptions['experimentalReadToolGenerateDelegation']>
}

function eligibility(config: DzupAgentConfig, options: GenerateOptions, state?: PreparedRunState): string | undefined {
  if (!readToolDataRecord(config) || Object.keys(config).some((key) => config[key] !== undefined && !fields.has(key))) return 'configuration-unsupported'
  if (Object.keys(options).some((key) => options[key] !== undefined && !optionFields.has(key))) return 'options-unsupported'
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return 'signal-invalid'
  if (typeof config.instructions !== 'string' || !readToolIdentity(config.id)
      || (config.instructionsMode !== undefined && config.instructionsMode !== 'static')
      || (config.permissionTier !== undefined && config.permissionTier !== 'read-only')
      || (config.memoryWriteBack !== undefined && config.memoryWriteBack !== false)
      || state?.memoryFrame !== undefined) return 'dynamic-policy-unsupported'
  if ([config.middleware, config.outputFilters].some((value) => value !== undefined && (!dense(value) || value.length !== 0))) return 'middleware-or-filter-enabled'
  if (!readToolDataRecord(config.guardrails, ['maxIterations', 'stuckDetector']) || config.guardrails.stuckDetector !== false
      || !Number.isSafeInteger(config.guardrails.maxIterations) || Number(config.guardrails.maxIterations) < 2
      || (options.maxIterations !== undefined && (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 2))) return 'guardrail-profile-ineligible'
  if (!readToolDataRecord(config.toolExecution, ['wrapToolResults']) || config.toolExecution.wrapToolResults !== false) return 'tool-result-policy-unsupported'
  if (!dense(config.tools) || config.tools.length !== 1) return 'one-tool-required'
  const bridge = config.experimentalReadToolGenerateBridge
  if (!readToolDataRecord(bridge, ['bridgeId', 'binding', 'dispatch']) || !readToolIdentity(bridge.bridgeId)
      || typeof bridge.dispatch !== 'function' || !validateAgentRunnerReadToolBinding(bridge.binding)) return 'read-bridge-unavailable'
  const tool = config.tools[0]!
  const name = Object.getOwnPropertyDescriptor(tool, 'name')
  if (name === undefined || !('value' in name) || name.value !== bridge.binding.toolId || typeof tool.invoke !== 'function') return 'tool-binding-mismatch'
  if (state !== undefined && (!dense(state.tools) || state.tools.length !== 1 || state.tools[0] !== tool)) return 'prepared-tools-mismatch'
  if (!readToolIdentity(options.runId)) return 'run-id-required'
  return undefined
}

function fallback(policy: AgentRunnerReadToolPreDispatchPolicy, code: string,
  phase: 'admission' | 'before-dispatch', admission?: AgentRunnerReadToolDelegationAdmission): undefined {
  if (policy === 'fail-closed') throw error(code, phase, admission)
  return undefined
}

export function preflightReadToolGenerateDelegation(config: DzupAgentConfig, options?: GenerateOptions): boolean {
  const optIn = selection(options)
  if (optIn === undefined) return false
  // Signal shape is checked before reading its native aborted accessor.
  if (options?.signal instanceof AbortSignal && options.signal.aborted) throw error('cancelled-before-dispatch', 'before-dispatch')
  const reason = eligibility(config, options ?? {})
  if (reason !== undefined) { fallback(optIn.preDispatchPolicy, reason, 'admission'); return false }
  return true
}

export async function maybeDelegateReadToolGenerate(input: {
  readonly agentId: string; readonly config: DzupAgentConfig; readonly options: GenerateOptions | undefined
  readonly runState: PreparedRunState
}): Promise<GenerateResult | undefined> {
  const optIn = selection(input.options)
  if (optIn === undefined) return undefined
  const options = input.options ?? {}
  const reason = eligibility(input.config, options, input.runState)
  if (reason !== undefined) return fallback(optIn.preDispatchPolicy, reason, 'admission')
  if (options.signal?.aborted) throw error('cancelled-before-dispatch', 'before-dispatch')
  const bridge = input.config.experimentalReadToolGenerateBridge!
  const binding = freeze(cloneDurableJson(bridge.binding))
  const runId = options.runId!
  const tool = input.runState.tools[0]!
  const invokeTool = tool.invoke.bind(tool)
  const dispatch = bridge.dispatch.bind(bridge)
  const items: AgentMessageItem[] = []
  const entries = []
  try {
    for (const [index, message] of input.runState.preparedMessages.entries()) {
      if (!boundedMessageShape(message)) throw new Error('message-shape')
      const item = createLegacyRunnerMessageItem(message, `r5p-input-${index + 1}`)
      if (typeof item === 'string') throw new Error('message-item')
      const entry = captureMessageEnvelopeEntry(message, item, index)
      if (typeof entry === 'string' || !exactMessage(message, reconstructLegacyMessage(entry))) throw new Error('message-envelope')
      items.push(item); entries.push(entry)
    }
  } catch { return fallback(optIn.preDispatchPolicy, 'prepared-input-ineligible', 'admission') }
  const preparedMessages = freeze(entries.map(reconstructLegacyMessage))
  const maxModelTurns = input.runState.maxIterations
  const behaviorDigest = digestRunnerJson({ schema: 'dzupagent.singleReadGenerateBehavior/v1',
    agentId: input.agentId, instructions: input.config.instructions, bridgeId: bridge.bridgeId,
    readTool: binding, maxModelTurns, maxToolAttempts: 1 })
  let profile
  try {
    profile = freeze(buildRunnerProviderFreeExecutionProfile({ behaviorDigest, maxModelTurns, maxToolAttempts: 1,
      observedMessageCount: preparedMessages.length, observedMessageTokens: estimateConversationTokensForMessages(preparedMessages),
      structuredOutputRequested: false, legacyResultProjection: 'single-read-generate-delegation/v1' }))
  } catch { return fallback(optIn.preDispatchPolicy, 'prepared-input-outside-profile-bounds', 'admission') }
  const requestInput = freeze({ agentId: input.agentId, behaviorDigest, items })
  const sourceBody = { schema: 'dzupagent.agentRunnerReadToolDelegationSource/v1' as const,
    bridgeId: bridge.bridgeId, runId, agentId: input.agentId, behaviorDigest,
    profileDigest: profile.profileDigest, inputDigest: digestRunnerJson(requestInput),
    preparedMessageDigest: digestRunnerJson(entries), readTool: binding }
  const source = freeze({ ...sourceBody, sourceDigest: digestRunnerJson(sourceBody) })
  const admissionBody = { schema: 'dzupagent.agentRunnerReadToolDelegationAdmission/v1' as const,
    decision: 'delegate' as const, policy: optIn.preDispatchPolicy, source,
    observedMessageCount: preparedMessages.length, observedMessageTokens: estimateConversationTokensForMessages(preparedMessages),
    maxModelTurns, maxToolAttempts: 1 }
  const admission = freeze({ ...admissionBody, admissionDigest: digestRunnerJson(admissionBody) })
  if (!validateAgentRunnerReadToolDelegationAdmission(admission)) return fallback(optIn.preDispatchPolicy, 'admission-invalid', 'admission')

  const control = new RunControl()
  let closed = false, attempted = false, violated = false
  let observed: { timing: LegacyReadToolTiming; inputDigest: string; resultDigest: string } | undefined
  const readTool = Object.freeze({
    ...binding,
    async execute(value: Parameters<AgentRunnerReadToolDelegationRequest['readTool']['execute']>[0]) {
      if (closed || attempted) { violated = true; throw error('read-port-single-use-violation', 'after-dispatch', admission) }
      attempted = true
      try {
        if (!readToolDataRecord(value, ['runId', 'invocationId', 'callId', 'attempt', 'input'])
            || value.runId !== runId || !readToolIdentity(value.invocationId) || !readToolIdentity(value.callId)
            || value.attempt !== 1 || !readToolDataRecord(value.input)) throw new Error('request-binding')
        json(value.input)
        if (options.signal?.aborted || control.observeAtSafePoint('before-tool-dispatch').action !== 'continue') throw new Error('cancelled')
        const args = cloneDurableJson(value.input)
        const inputDigest = digestRunnerJson(args)
        const startedMs = Date.now()
        const output: unknown = await invokeTool(args, options.signal === undefined ? undefined : { signal: options.signal })
        const completedMs = Date.now()
        if (typeof output !== 'string') throw new Error('output-profile')
        observed = { timing: { policy: 'host-elapsed-ms/v1', runId, invocationId: value.invocationId,
          callId: value.callId, attempt: 1, startedMs, completedMs }, inputDigest, resultDigest: digestRunnerJson(output) }
        if (closed || options.signal?.aborted) throw new Error('cancelled-or-closed')
        return { status: 'completed' as const, output }
      } catch { violated = true; throw error('read-port-failed-or-cancelled', 'after-dispatch', admission) }
    },
  })
  const request = Object.freeze({ admission, input: requestInput, preparedMessages, profile, control, readTool,
    ...(options.signal === undefined ? {} : { signal: options.signal }) })
  const cancel = () => { control.requestCancel() }
  options.signal?.addEventListener('abort', cancel, { once: true })
  let outcome: AgentRunnerReadToolDelegationOutcome
  try {
    if (options.signal?.aborted) throw error('cancelled-before-dispatch', 'before-dispatch', admission)
    try { outcome = await dispatch(request) }
    catch { throw error('bridge-threw-with-unknown-outcome', 'outcome-unknown', admission) }
  } finally { closed = true; options.signal?.removeEventListener('abort', cancel) }
  if (!readToolDataRecord(outcome) || !validateAgentRunnerReadToolDelegationSource(outcome.source)
      || digestRunnerJson(outcome.source) !== digestRunnerJson(source)) throw error('bridge-source-binding-unknown', 'outcome-unknown', admission)
  if (outcome.status === 'rejected-before-dispatch') {
    if (attempted || violated || options.signal?.aborted) throw error('bridge-refusal-after-read-or-cancel', 'after-dispatch', admission)
    if (!readToolDataRecord(outcome, ['status', 'source', 'code']) || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(outcome.code)) throw error('bridge-refusal-malformed', 'outcome-unknown', admission)
    return fallback(optIn.preDispatchPolicy, 'bridge-rejected-before-dispatch', 'before-dispatch', admission)
  }
  if (outcome.status !== 'completed') throw error('bridge-failed-or-outcome-unknown',
    outcome.status === 'failed-after-dispatch' ? 'after-dispatch' : 'outcome-unknown', admission)
  if (!readToolDataRecord(outcome, ['status', 'source', 'result', 'assistantCall', 'toolMessage', 'finalAssistant'])
      || options.signal?.aborted || violated || observed === undefined) throw error('post-dispatch-completion-invalid', 'after-dispatch', admission)
  try {
    json(outcome.result)
    const state = outcome.result.state
    const invocation = state.invocations[0]
    if (digestRunnerJson({ ...requestInput, items: state.input }) !== source.inputDigest
        || state.runId !== runId || state.agent.initialAgentId !== input.agentId
        || state.agent.currentAgentId !== input.agentId || state.agent.behaviorDigest !== behaviorDigest
        || invocation?.toolId !== binding.toolId || invocation.toolRevision !== binding.toolRevision
        || invocation.inputDigest !== observed.inputDigest || invocation.resultDigest !== observed.resultDigest
        || invocation.callId !== observed.timing.callId || invocation.invocationId !== observed.timing.invocationId) throw new Error('result-binding')
    const captured = captureLegacyReadToolResultEnvelope({ profile, result: outcome.result, preparedInput: preparedMessages,
      assistantCall: outcome.assistantCall, toolMessage: outcome.toolMessage, finalAssistant: outcome.finalAssistant, timing: observed.timing })
    if (captured.status !== 'captured' || digestRunnerJson(captured.envelope.preparedInput) !== source.preparedMessageDigest) throw new Error('capture')
    const projected = projectLegacyReadToolGenerateResult({ profile, result: outcome.result, envelope: captured.envelope,
      expectedEnvelopeDigest: captured.envelope.envelopeDigest })
    if (projected.status !== 'projected') throw new Error('projection')
    return projected.result
  } catch { throw error('post-dispatch-result-evidence-invalid', 'after-dispatch', admission) }
}

