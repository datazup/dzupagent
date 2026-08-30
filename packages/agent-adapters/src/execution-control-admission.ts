import { createHash } from 'node:crypto'

import { ForgeError } from '@dzupagent/core'

import type {
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentInput,
} from './types.js'

const REQUIREMENT_SCHEMA = 'dzupagent/adapter-execution-control-requirement/v1'
const ADMISSION_SCHEMA = 'dzupagent/adapter-execution-control-admission/v1'
const CANONICAL_REQUIREMENT_BYTES = '{"schema":"dzupagent/adapter-execution-control-requirement/v1","tools":{"mode":"none"}}'
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u
const BLOCKER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u
const MAX_BLOCKERS = 16
const arrayIsArray = Array.isArray
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const getPrototypeOf = Object.getPrototypeOf
const ownKeys = Reflect.ownKeys

const PROVIDER_IDS = new Set<AdapterProviderId>([
  'claude',
  'codex',
  'gemini',
  'gemini-sdk',
  'qwen',
  'crush',
  'goose',
  'ollama',
  'openrouter',
  'openai',
])

const CANONICAL_REQUIREMENT: AdapterExecutionControlRequirement = Object.freeze({
  schema: REQUIREMENT_SCHEMA,
  tools: Object.freeze({ mode: 'none' as const }),
})

const CANONICAL_REQUIREMENT_SHA256 = `sha256:${createHash('sha256')
  .update(Buffer.from(CANONICAL_REQUIREMENT_BYTES, 'utf8'))
  .digest('hex')}`

export interface BuildExecutionControlAdmissionArgs {
  readonly providerId: AdapterProviderId
  readonly requirement: AdapterExecutionControlRequirement
  readonly status: 'admitted' | 'rejected'
  readonly enforcement: 'provider-pre-dispatch' | 'unsupported'
  readonly blockers?: readonly string[] | undefined
}

type AdmissionValidationResult =
  | { readonly evidence: AdapterExecutionControlAdmission; readonly valid: true }
  | { readonly blocker: string; readonly valid: false }

type OwnDataProperty =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' }

/** Parse the one exact provider-neutral zero-tool requirement. */
export function canonicalExecutionControlRequirement(
  value: unknown,
): AdapterExecutionControlRequirement {
  const requirementValues = exactDataValues(value, ['schema', 'tools'])
  if (!requirementValues) {
    throw new TypeError('Execution-control requirement must contain only schema and tools')
  }
  const schema = requirementValues[0]
  const tools = requirementValues[1]
  if (schema !== REQUIREMENT_SCHEMA) {
    throw new TypeError('Execution-control requirement schema is not supported')
  }
  const toolValues = exactDataValues(tools, ['mode'])
  if (!toolValues) {
    throw new TypeError('Execution-control requirement tools must contain only mode')
  }
  if (toolValues[0] !== 'none') {
    throw new TypeError('Execution-control requirement tools mode must be none')
  }
  return CANONICAL_REQUIREMENT
}

/** Hash the canonical UTF-8 requirement bytes. */
export function executionControlRequirementSha256(
  requirement: AdapterExecutionControlRequirement,
): string {
  canonicalExecutionControlRequirement(requirement)
  return CANONICAL_REQUIREMENT_SHA256
}

/** Build immutable, effect-free admission evidence. */
export function buildExecutionControlAdmission(
  args: BuildExecutionControlAdmissionArgs,
): AdapterExecutionControlAdmission {
  canonicalExecutionControlRequirement(args.requirement)
  if (!PROVIDER_IDS.has(args.providerId)) {
    throw new TypeError('Execution-control admission providerId is not supported')
  }
  if (args.status !== 'admitted' && args.status !== 'rejected') {
    throw new TypeError('Execution-control admission status is invalid')
  }
  if (
    args.enforcement !== 'provider-pre-dispatch'
    && args.enforcement !== 'unsupported'
  ) {
    throw new TypeError('Execution-control admission enforcement is invalid')
  }

  const blockers = canonicalBlockers(args.blockers ?? [])
  if (
    args.status === 'admitted'
    && (args.enforcement !== 'provider-pre-dispatch' || blockers.length > 0)
  ) {
    throw new TypeError('Admitted execution controls require predispatch enforcement and no blockers')
  }
  if (args.status === 'rejected' && args.enforcement !== 'unsupported') {
    throw new TypeError('Rejected execution controls require unsupported enforcement')
  }

  return Object.freeze({
    schema: ADMISSION_SCHEMA,
    status: args.status,
    providerId: args.providerId,
    requirementSha256: executionControlRequirementSha256(args.requirement),
    tools: Object.freeze({
      mode: 'none' as const,
      enforcement: args.enforcement,
    }),
    blockers,
    effects: Object.freeze({
      credentialReads: 0 as const,
      networkAttempts: 0 as const,
      providerDispatches: 0 as const,
      providerSpendUsd: 0 as const,
    }),
  })
}

/**
 * Evaluate an opted-in input against the selected concrete adapter instance.
 * Legacy inputs return undefined and do not become admitted evidence.
 */
export function admitAdapterExecutionControls(
  adapter: AgentCLIAdapter,
  input: AgentInput,
): AdapterExecutionControlAdmission | undefined {
  const inputRequirement = ownEnumerableDataProperty(
    input,
    'executionControlRequirement',
  )
  if (inputRequirement.kind === 'missing') return undefined
  if (inputRequirement.kind === 'data' && inputRequirement.value === undefined) {
    return undefined
  }
  if (inputRequirement.kind !== 'data') {
    return rejected(adapter.providerId, 'execution_control_requirement_invalid')
  }

  let canonicalRequirement: AdapterExecutionControlRequirement
  try {
    canonicalRequirement = canonicalExecutionControlRequirement(
      inputRequirement.value,
    )
  } catch {
    return rejected(adapter.providerId, 'execution_control_requirement_invalid')
  }
  const originalRequirementSha256 = executionControlRequirementSha256(
    canonicalRequirement,
  )

  if (!hasStrictZeroToolPolicy(input)) {
    return rejected(adapter.providerId, 'execution_control_policy_inconsistent')
  }

  let supportsZeroToolDispatch: boolean
  try {
    supportsZeroToolDispatch = adapter.getCapabilities().supportsZeroToolDispatch === true
  } catch {
    return rejected(adapter.providerId, 'zero_tool_dispatch_capability_invalid')
  }
  if (!supportsZeroToolDispatch) {
    return rejected(adapter.providerId, 'zero_tool_dispatch_capability_missing')
  }

  let admissionMethod: AgentCLIAdapter['admitExecutionControls']
  try {
    admissionMethod = adapter.admitExecutionControls
  } catch {
    return rejected(adapter.providerId, 'execution_control_admission_method_threw')
  }
  if (typeof admissionMethod !== 'function') {
    return rejected(adapter.providerId, 'execution_control_admission_method_missing')
  }

  let returned: unknown
  try {
    returned = admissionMethod.call(adapter, input, canonicalRequirement)
  } catch {
    return rejected(adapter.providerId, 'execution_control_admission_method_threw')
  }

  const finalRequirement = ownEnumerableDataProperty(
    input,
    'executionControlRequirement',
  )
  if (
    finalRequirement.kind !== 'data'
    || finalRequirement.value === undefined
  ) {
    return rejected(
      adapter.providerId,
      'execution_control_requirement_changed_after_admission',
    )
  }
  try {
    const finalCanonicalRequirement = canonicalExecutionControlRequirement(
      finalRequirement.value,
    )
    if (
      executionControlRequirementSha256(finalCanonicalRequirement)
      !== originalRequirementSha256
    ) {
      return rejected(
        adapter.providerId,
        'execution_control_requirement_changed_after_admission',
      )
    }
  } catch {
    return rejected(
      adapter.providerId,
      'execution_control_requirement_changed_after_admission',
    )
  }
  if (!hasStrictZeroToolPolicy(input)) {
    return rejected(
      adapter.providerId,
      'execution_control_policy_changed_after_admission',
    )
  }

  const validation = validateReturnedAdmission(
    returned,
    adapter.providerId,
    canonicalRequirement,
  )
  return validation.valid
    ? validation.evidence
    : rejected(adapter.providerId, validation.blocker)
}

/** Fail closed for opted-in inputs while retaining legacy bypass behavior. */
export function assertAdapterExecutionControlsAdmitted(
  adapter: AgentCLIAdapter,
  input: AgentInput,
): AdapterExecutionControlAdmission | undefined {
  const admission = admitAdapterExecutionControls(adapter, input)
  if (admission === undefined || admission.status === 'admitted') return admission

  throw new ForgeError({
    code: 'CAPABILITY_DENIED',
    message: `Adapter ${adapter.providerId} did not admit the required execution controls`,
    recoverable: false,
    context: { admission },
  })
}

function validateReturnedAdmission(
  value: unknown,
  providerId: AdapterProviderId,
  requirement: AdapterExecutionControlRequirement,
): AdmissionValidationResult {
  try {
    const admissionValues = exactDataValues(value, [
      'schema',
      'status',
      'providerId',
      'requirementSha256',
      'tools',
      'blockers',
      'effects',
    ])
    if (!admissionValues) {
      return invalid('execution_control_admission_malformed')
    }
    const schema = admissionValues[0]
    const status = admissionValues[1]
    const returnedProviderId = admissionValues[2]
    const requirementSha256 = admissionValues[3]
    const tools = admissionValues[4]
    const blockerValues = admissionValues[5]
    const effects = admissionValues[6]

    if (schema !== ADMISSION_SCHEMA) {
      return invalid('execution_control_admission_malformed')
    }
    if (status !== 'admitted' && status !== 'rejected') {
      return invalid('execution_control_admission_malformed')
    }
    if (returnedProviderId !== providerId) {
      return invalid('execution_control_admission_provider_mismatch')
    }
    if (
      typeof requirementSha256 !== 'string'
      || !SHA256_PATTERN.test(requirementSha256)
    ) {
      return invalid('execution_control_admission_digest_invalid')
    }
    if (requirementSha256 !== executionControlRequirementSha256(requirement)) {
      return invalid('execution_control_admission_digest_mismatch')
    }
    const toolValues = exactDataValues(tools, ['mode', 'enforcement'])
    if (!toolValues) {
      return invalid('execution_control_admission_malformed')
    }
    const mode = toolValues[0]
    const enforcement = toolValues[1]
    if (
      mode !== 'none'
      || (enforcement !== 'provider-pre-dispatch'
        && enforcement !== 'unsupported')
    ) {
      return invalid('execution_control_admission_malformed')
    }

    let blockers: readonly string[]
    try {
      blockers = canonicalBlockers(blockerValues)
    } catch {
      return invalid('execution_control_admission_malformed')
    }

    const effectValues = exactDataValues(effects, [
      'credentialReads',
      'networkAttempts',
      'providerDispatches',
      'providerSpendUsd',
    ])
    if (!effectValues) {
      return invalid('execution_control_admission_malformed')
    }
    if (
      effectValues[0] !== 0
      || effectValues[1] !== 0
      || effectValues[2] !== 0
      || effectValues[3] !== 0
    ) {
      return invalid('execution_control_admission_malformed')
    }
    if (
      status === 'admitted'
      && (enforcement !== 'provider-pre-dispatch' || blockers.length > 0)
    ) {
      return invalid('execution_control_admission_malformed')
    }
    if (status === 'rejected' && enforcement !== 'unsupported') {
      return invalid('execution_control_admission_malformed')
    }

    return {
      valid: true,
      evidence: buildExecutionControlAdmission({
        providerId,
        requirement,
        status,
        enforcement,
        blockers,
      }),
    }
  } catch {
    return invalid('execution_control_admission_malformed')
  }
}

function rejected(
  providerId: AdapterProviderId,
  blocker: string,
): AdapterExecutionControlAdmission {
  return buildExecutionControlAdmission({
    providerId,
    requirement: CANONICAL_REQUIREMENT,
    status: 'rejected',
    enforcement: 'unsupported',
    blockers: [blocker],
  })
}

function invalid(blocker: string): AdmissionValidationResult {
  return { valid: false, blocker }
}

function hasStrictZeroToolPolicy(input: AgentInput): boolean {
  try {
    const policyContextProperty = ownEnumerableDataProperty(input, 'policyContext')
    if (
      policyContextProperty.kind !== 'data'
      || !isRecord(policyContextProperty.value)
    ) {
      return false
    }
    const activePolicyProperty = ownEnumerableDataProperty(
      policyContextProperty.value,
      'activePolicy',
    )
    const conformanceProperty = ownEnumerableDataProperty(
      policyContextProperty.value,
      'conformanceMode',
    )
    if (
      activePolicyProperty.kind !== 'data'
      || !isRecord(activePolicyProperty.value)
      || conformanceProperty.kind !== 'data'
    ) {
      return false
    }
    const toolPolicyProperty = ownEnumerableDataProperty(
      activePolicyProperty.value,
      'toolPolicy',
    )
    const allowedToolsProperty = ownEnumerableDataProperty(
      activePolicyProperty.value,
      'allowedTools',
    )
    const blockedToolsProperty = ownEnumerableDataProperty(
      activePolicyProperty.value,
      'blockedTools',
    )
    return toolPolicyProperty.kind === 'data'
      && toolPolicyProperty.value === 'strict'
      && allowedToolsProperty.kind === 'data'
      && isExactEmptyArray(allowedToolsProperty.value)
      && blockedToolsProperty.kind === 'data'
      && isExactEmptyArray(blockedToolsProperty.value)
      && conformanceProperty.value === 'strict'
  } catch {
    return false
  }
}

function canonicalBlockers(value: unknown): readonly string[] {
  const values = denseOwnDataArray(value, MAX_BLOCKERS)
  const blockers: string[] = []
  for (const entry of values) {
    if (typeof entry !== 'string' || !BLOCKER_PATTERN.test(entry)) {
      throw new TypeError('Execution-control admission blocker is invalid')
    }
    if (!blockers.includes(entry)) blockers.push(entry)
  }
  blockers.sort()
  return Object.freeze(blockers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || arrayIsArray(value)) return false
  const prototype = getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactDataValues(
  value: unknown,
  expected: readonly string[],
): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined
  const keys = ownKeys(value)
  if (keys.length !== expected.length) return undefined
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.includes(key)) return undefined
  }
  const values: unknown[] = []
  for (const key of expected) {
    const property = ownEnumerableDataProperty(value, key)
    if (property.kind !== 'data') return undefined
    values.push(property.value)
  }
  return values
}

function ownEnumerableDataProperty(
  value: object,
  key: PropertyKey,
): OwnDataProperty {
  const descriptor = getOwnPropertyDescriptor(value, key)
  if (!descriptor) return { kind: 'missing' }
  if (!descriptor.enumerable || !('value' in descriptor)) {
    return { kind: 'invalid' }
  }
  return { kind: 'data', value: descriptor.value }
}

function denseOwnDataArray(
  value: unknown,
  maxLength: number,
): readonly unknown[] {
  if (!arrayIsArray(value)) {
    throw new TypeError('Execution-control admission blockers must be an array')
  }
  const lengthDescriptor = getOwnPropertyDescriptor(value, 'length')
  if (
    !lengthDescriptor
    || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maxLength
  ) {
    throw new TypeError(`Execution-control admission supports at most ${maxLength} blockers`)
  }
  const length = lengthDescriptor.value
  const keys = ownKeys(value)
  if (keys.length !== length + 1) {
    throw new TypeError('Execution-control admission blockers must be dense data')
  }
  const values: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    const descriptor = getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Execution-control admission blockers must be dense data')
    }
    values.push(descriptor.value)
  }
  for (const key of keys) {
    if (key === 'length') continue
    if (typeof key !== 'string') {
      throw new TypeError('Execution-control admission blockers contain an extra property')
    }
    const index = Number(key)
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index >= length
      || String(index) !== key
    ) {
      throw new TypeError('Execution-control admission blockers contain an extra property')
    }
  }
  return values
}

function isExactEmptyArray(value: unknown): boolean {
  try {
    return denseOwnDataArray(value, 0).length === 0
  } catch {
    return false
  }
}
