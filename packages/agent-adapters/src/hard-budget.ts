import { createHash } from 'node:crypto'
import { fetchWithOutboundUrlPolicy } from '@dzupagent/core/security'
import type { AgentInput, AdapterProviderId } from './types.js'
import {
  AdapterHardBudgetProfileError,
  assertAdapterHardBudgetRequestProofBinding,
  defineAdapterHardBudgetHostProfile,
  type AdapterHardBudgetHostProfileDefinition,
  type AdapterHardBudgetModelSnapshot,
  type AdapterHardBudgetProfileErrorCode,
  type AdapterHardBudgetRequest,
  type AdapterHardBudgetRequestProofBinding,
  type AdapterHardBudgetRequestProofResult,
} from './context/hard-budget-profile-registry.js'
import {
  emitAdapterHardBudgetEvaluation,
  prepareAdapterHardBudgetInputCore,
  type AdapterHardBudgetPolicy,
  type AdapterHardBudgetUsageReconciliation,
  type PreparedAdapterHardBudgetInput,
} from './context/hard-budget-input.js'
import { httpErrorToForgeError } from './utils/http-error.js'
import { resolveOpenAIApiKey } from './openai/openai-http.js'
import {
  DEFAULT_BASE_URL,
  defaultOpenAIOutboundPolicy,
  type OpenAIConfig,
  type OpenAIResponsesInputRequest,
} from './openai/openai-types.js'

export {
  ADAPTER_HARD_BUDGET_PROFILE_SCHEMA_VERSION,
  AdapterHardBudgetHostProfileRegistry,
  AdapterHardBudgetProfileError,
  assertAdapterHardBudgetBinding,
  assertAdapterHardBudgetRequestProofBinding,
  defineAdapterHardBudgetHostProfile,
} from './context/hard-budget-profile-registry.js'
export type {
  AdapterHardBudgetCounterBinding,
  AdapterHardBudgetHostProfileDefinition,
  AdapterHardBudgetModelSnapshot,
  AdapterHardBudgetProfileErrorCode,
  AdapterHardBudgetRequest,
  AdapterHardBudgetRequestProofBinding,
  AdapterHardBudgetRequestProofContract,
  AdapterHardBudgetRequestProofResult,
  BoundAdapterHardBudgetProfile,
} from './context/hard-budget-profile-registry.js'
export { prepareAdapterHardBudgetInput } from './context/hard-budget-input.js'
export type {
  AdapterHardBudgetEvaluation,
  AdapterHardBudgetPolicy,
  AdapterHardBudgetUsageReconciliation,
  PreparedAdapterHardBudgetInput,
} from './context/hard-budget-input.js'
export type { OpenAIResponsesInputRequest } from './openai/openai-types.js'

export interface ProvenAdapterHardBudgetInput
  extends PreparedAdapterHardBudgetInput {
  requestProof: AdapterHardBudgetRequestProofResult
}

function rejectProof(
  policy: AdapterHardBudgetPolicy,
  prepared: PreparedAdapterHardBudgetInput,
  code: AdapterHardBudgetProfileErrorCode,
  message: string,
): never {
  emitAdapterHardBudgetEvaluation(policy, {
    ...prepared.evaluation,
    accepted: false,
    satisfied: false,
    adoptionSafe: false,
    code,
  })
  throw new AdapterHardBudgetProfileError(code, message)
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function assertProofResult(
  proof: AdapterHardBudgetRequestProofResult,
  prepared: PreparedAdapterHardBudgetInput,
  now: number,
  maxAgeMs: number,
): number {
  if (
    proof.method !== 'exact'
    || proof.model !== prepared.request.model
    || !Number.isInteger(proof.tokens)
    || proof.tokens < 0
    || !isSha256(proof.requestFingerprint)
    || proof.requestFormatFingerprint
      !== prepared.evaluation.requestFormatFingerprint
  ) {
    throw new AdapterHardBudgetProfileError(
      'request_proof_failed',
      'authoritative request proof returned invalid provenance',
    )
  }
  const measuredAt = Date.parse(proof.measuredAt)
  const ageMs = now - measuredAt
  if (!Number.isFinite(measuredAt) || ageMs < 0 || ageMs > maxAgeMs) {
    throw new AdapterHardBudgetProfileError(
      'request_proof_stale',
      'authoritative request proof is stale or future-dated',
    )
  }
  return ageMs
}

export async function prepareAdapterHardBudgetInputWithProof(args: {
  input: AgentInput
  provider: AdapterProviderId
  model: string
  tools?: readonly unknown[]
  toolChoice?: unknown
  policy: AdapterHardBudgetPolicy
  signal?: AbortSignal
}): Promise<ProvenAdapterHardBudgetInput> {
  const prepared = prepareAdapterHardBudgetInputCore(args, {
    allowRequestProofPending: true,
    deferAcceptedEvaluation: true,
  })
  const definition = args.policy.registry.resolveRequired(args.provider, args.model)
  const contract = definition.requestProof
  const binding = args.policy.requestProof
  if (!contract || !binding) {
    return rejectProof(args.policy, prepared, 'request_proof_required',
      'adapter hard-budget authoritative request proof is required')
  }
  try {
    assertAdapterHardBudgetRequestProofBinding(definition, binding)
  } catch (error) {
    const code = error instanceof AdapterHardBudgetProfileError
      ? error.code
      : 'request_proof_binding_mismatch'
    return rejectProof(args.policy, prepared, code,
      'adapter hard-budget request proof binding failed')
  }
  const snapshotExpiresAt = Date.parse(definition.modelSnapshot!.expiresAt)
  if ((args.policy.clock?.() ?? Date.now()) >= snapshotExpiresAt) {
    return rejectProof(args.policy, prepared, 'model_snapshot_stale',
      'adapter hard-budget model snapshot has expired')
  }
  let proof: AdapterHardBudgetRequestProofResult
  let preflightAgeMs: number
  try {
    proof = await binding.proveRequest(
      prepared.request,
      args.signal ? { signal: args.signal } : undefined,
    )
    preflightAgeMs = assertProofResult(
      proof,
      prepared,
      args.policy.clock?.() ?? Date.now(),
      contract.maxAgeMs,
    )
  } catch (error) {
    const code = error instanceof AdapterHardBudgetProfileError
      ? error.code
      : 'request_proof_failed'
    return rejectProof(args.policy, prepared, code,
      'adapter authoritative request proof failed')
  }
  if (proof.tokens > prepared.hardBudget.limit) {
    return rejectProof(args.policy, prepared, 'request_over_budget',
      'adapter request exceeds the provider input budget')
  }
  const evaluation = {
    ...prepared.evaluation,
    accepted: true,
    localMeasuredRequestTokens: prepared.requestMeasurement.tokens,
    measuredRequestTokens: proof.tokens,
    providerMeasuredRequestTokens: proof.tokens,
    measurementMethod: proof.method,
    requestFingerprint: proof.requestFingerprint,
    preflightMeasuredAt: proof.measuredAt,
    preflightAgeMs,
    adoptionSafe: true,
    satisfied: true,
  } as const
  emitAdapterHardBudgetEvaluation(args.policy, evaluation)
  return { ...prepared, evaluation, requestProof: proof }
}

export function reconcileAdapterHardBudgetUsage(args: {
  prepared: ProvenAdapterHardBudgetInput
  responseInputTokens?: number
  policy: AdapterHardBudgetPolicy
}): AdapterHardBudgetUsageReconciliation {
  const configured = args.policy.usageReconciliationToleranceTokens
  const tolerance = configured !== undefined
    && Number.isInteger(configured) && configured >= 0 ? configured : 0
  const validUsage = Number.isInteger(args.responseInputTokens)
    && args.responseInputTokens! >= 0
  const deltaTokens = validUsage
    ? args.responseInputTokens! - args.prepared.requestProof.tokens
    : undefined
  const reconciled = validUsage && Math.abs(deltaTokens!) <= tolerance
  const result: AdapterHardBudgetUsageReconciliation = {
    type: 'adapter:hard_budget_usage_reconciled',
    provider: args.prepared.evaluation.provider,
    model: args.prepared.evaluation.model,
    profileId: args.prepared.evaluation.profileId!,
    profileRevision: args.prepared.evaluation.profileRevision!,
    requestFingerprint: args.prepared.requestProof.requestFingerprint,
    preflightInputTokens: args.prepared.requestProof.tokens,
    ...(validUsage ? { responseInputTokens: args.responseInputTokens } : {}),
    ...(deltaTokens !== undefined ? { deltaTokens } : {}),
    toleranceTokens: tolerance,
    reconciled,
    ...(!validUsage
      ? { code: 'usage_missing' as const }
      : !reconciled ? { code: 'usage_mismatch' as const } : {}),
  }
  try {
    args.policy.onUsageReconciliation?.(result)
  } catch {
    // Telemetry cannot alter the already returned provider response.
  }
  return result
}

export const OPENAI_RESPONSES_REQUEST_FORMAT_ID = 'openai-responses-input'
export const OPENAI_RESPONSES_REQUEST_FORMAT_REVISION = '2026-08-01.1'
export const OPENAI_RESPONSES_INPUT_TOKEN_PROOF_ID =
  'openai-responses-input-tokens'
export const OPENAI_RESPONSES_INPUT_TOKEN_PROOF_REVISION = '2026-08-01.1'
const REQUEST_FORMAT_DESCRIPTOR = Object.freeze({
  endpoint: '/responses',
  countedEndpoint: '/responses/input_tokens',
  fields: Object.freeze([
    'model', 'input[].role', 'input[].content', 'tools[].type',
    'tools[].name', 'tools[].description', 'tools[].parameters',
    'tools[].strict', 'tool_choice',
  ]),
  chatToolMapping: 'tools[].function -> flattened responses function tool',
  chatNamedToolChoiceMapping:
    '{type:function,function:{name}} -> {type:function,name}',
})
export const OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(REQUEST_FORMAT_DESCRIPTOR)).digest('hex')

export interface OpenAIResponsesHardBudgetProfileOptions extends Omit<
  AdapterHardBudgetHostProfileDefinition,
  'provider' | 'requestFormat' | 'requestProof' | 'modelSnapshot'
> {
  modelSnapshot: AdapterHardBudgetModelSnapshot
  requestProofMaxAgeMs: number
}

export function defineOpenAIResponsesHardBudgetHostProfile(
  options: OpenAIResponsesHardBudgetProfileOptions,
): Readonly<AdapterHardBudgetHostProfileDefinition> {
  const { requestProofMaxAgeMs, ...definition } = options
  return defineAdapterHardBudgetHostProfile({
    ...definition,
    provider: 'openai',
    requestFormat: {
      id: OPENAI_RESPONSES_REQUEST_FORMAT_ID,
      revision: OPENAI_RESPONSES_REQUEST_FORMAT_REVISION,
      fingerprint: OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT,
    },
    requestProof: {
      id: OPENAI_RESPONSES_INPUT_TOKEN_PROOF_ID,
      revision: OPENAI_RESPONSES_INPUT_TOKEN_PROOF_REVISION,
      maxAgeMs: requestProofMaxAgeMs,
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function flattenTool(
  tool: unknown,
): NonNullable<OpenAIResponsesInputRequest['tools']>[number] {
  if (!isRecord(tool) || tool['type'] !== 'function') {
    throw new AdapterHardBudgetProfileError(
      'request_proof_failed',
      'OpenAI Responses hard-budget proof requires function tools',
    )
  }
  const fn = tool['function']
  if (!isRecord(fn) || typeof fn['name'] !== 'string') {
    throw new AdapterHardBudgetProfileError(
      'request_proof_failed',
      'OpenAI Responses function tool is missing a name',
    )
  }
  return {
    type: 'function',
    name: fn['name'],
    ...(typeof fn['description'] === 'string'
      ? { description: fn['description'] } : {}),
    ...(isRecord(fn['parameters']) ? { parameters: fn['parameters'] } : {}),
    ...(typeof fn['strict'] === 'boolean' ? { strict: fn['strict'] } : {}),
  }
}

function flattenToolChoice(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice) || toolChoice['type'] !== 'function') {
    return toolChoice
  }
  const fn = toolChoice['function']
  return isRecord(fn) && typeof fn['name'] === 'string'
    ? { type: 'function', name: fn['name'] }
    : toolChoice
}

export function buildOpenAIResponsesInputRequest(
  request: AdapterHardBudgetRequest,
): OpenAIResponsesInputRequest {
  return {
    model: request.model,
    input: request.messages.map((message) => ({ ...message })),
    ...(request.tools?.length ? { tools: request.tools.map(flattenTool) } : {}),
    ...(request.toolChoice !== undefined
      ? { tool_choice: flattenToolChoice(request.toolChoice) } : {}),
  }
}

export function createOpenAIResponsesInputTokenProofBinding(
  config: Pick<
    OpenAIConfig,
    'apiKey' | 'baseURL' | 'outboundUrlPolicy' | 'fetchImpl'
  > & { clock?: () => number } = {},
): AdapterHardBudgetRequestProofBinding {
  return {
    id: OPENAI_RESPONSES_INPUT_TOKEN_PROOF_ID,
    revision: OPENAI_RESPONSES_INPUT_TOKEN_PROOF_REVISION,
    requestFormatId: OPENAI_RESPONSES_REQUEST_FORMAT_ID,
    requestFormatRevision: OPENAI_RESPONSES_REQUEST_FORMAT_REVISION,
    requestFormatFingerprint: OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT,
    async proveRequest(request, options) {
      const apiKey = resolveOpenAIApiKey(config)
      const baseURL = config.baseURL ?? DEFAULT_BASE_URL
      const body = buildOpenAIResponsesInputRequest(request)
      const response = await fetchWithOutboundUrlPolicy(
        `${baseURL}/responses/input_tokens`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
        {
          policy:
            config.outboundUrlPolicy ?? defaultOpenAIOutboundPolicy(baseURL),
          ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        },
      )
      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText)
        throw httpErrorToForgeError(response.status, errorText, 'openai')
      }
      const data = await response.json() as { input_tokens?: unknown }
      if (!Number.isInteger(data.input_tokens) || Number(data.input_tokens) < 0) {
        throw new AdapterHardBudgetProfileError(
          'request_proof_failed',
          'OpenAI input token counter returned an invalid count',
        )
      }
      return {
        tokens: Number(data.input_tokens),
        method: 'exact',
        model: request.model,
        requestFingerprint: createHash('sha256')
          .update(JSON.stringify(body)).digest('hex'),
        requestFormatFingerprint: OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT,
        measuredAt: new Date(config.clock?.() ?? Date.now()).toISOString(),
      }
    },
  }
}
