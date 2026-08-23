import type {
  ExecutionRouteCandidate,
  ExecutionRouteCandidateHealth,
  ExecutionRouteConstraint,
  ExecutionRoutePolicy,
  ExecutionRouteRequirements,
} from '@dzupagent/runtime-contracts'

export interface DeterministicRouteSelectionOptions {
  /** Host-supplied timestamp keeps selection deterministic and replayable. */
  decidedAt: string
  /** Host-recorded seed for weighted and hash strategies. */
  seed?: string
  /** Stable request/tenant key used by rendezvous hashing. */
  routingKey?: string
  /** Previous receipt's selected candidate for receipt-pure round-robin. */
  roundRobinCursor?: string
}

export const IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES = [
  'fixed', 'rule', 'weighted', 'hash', 'round-robin',
] as const

type ImplementedDeterministicRouteStrategy =
  (typeof IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES)[number]

export type DeterministicRouteSelectionAdmissionCode =
  | 'UNSUPPORTED_ROUTE_STRATEGY'
  | 'DUPLICATE_ROUTE_CANDIDATE'
  | 'FIXED_STRATEGY_REQUIRES_SINGLE_CANDIDATE'
  | 'SEEDED_STRATEGY_REQUIRES_SEED'
  | 'WEIGHTED_STRATEGY_REQUIRES_CANDIDATE_WEIGHT'
  | 'WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT'
  | 'WEIGHTED_STRATEGY_REQUIRES_POSITIVE_WEIGHT_SUM'
  | 'HASH_STRATEGY_REQUIRES_ROUTING_KEY'
  | 'ROUND_ROBIN_STRATEGY_INVALID_CURSOR'
  | 'ROUND_ROBIN_STRATEGY_UNKNOWN_CURSOR_CANDIDATE'

/** Fail-closed strategy-admission error raised before any candidate is evaluated. */
export class DeterministicRouteSelectionAdmissionError extends Error {
  readonly code: DeterministicRouteSelectionAdmissionCode

  constructor(code: DeterministicRouteSelectionAdmissionCode, message: string) {
    super(message)
    this.name = 'DeterministicRouteSelectionAdmissionError'
    this.code = code
  }
}

/** Admit strategy inputs and policy-wide identity constraints before candidate evaluation. */
export function assertDeterministicRoutePolicyAdmission(
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): void {
  if (!isImplementedStrategy(policy.strategy)) {
    throw new DeterministicRouteSelectionAdmissionError(
      'UNSUPPORTED_ROUTE_STRATEGY',
      `Route strategy "${policy.strategy}" is not implemented by the deterministic selector; supported strategies: ${IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES.join(', ')}`,
    )
  }

  const candidateIds = new Set<string>()
  for (const candidate of policy.candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new DeterministicRouteSelectionAdmissionError(
        'DUPLICATE_ROUTE_CANDIDATE',
        `Duplicate route candidate: ${candidate.id}`,
      )
    }
    candidateIds.add(candidate.id)
  }

  if (policy.strategy === 'fixed' && policy.candidates.length !== 1) {
    throw new DeterministicRouteSelectionAdmissionError(
      'FIXED_STRATEGY_REQUIRES_SINGLE_CANDIDATE',
      `Fixed route strategy requires exactly one candidate; received ${policy.candidates.length}`,
    )
  }
  if ((policy.strategy === 'weighted' || policy.strategy === 'hash') && !nonEmpty(options.seed)) {
    throw new DeterministicRouteSelectionAdmissionError(
      'SEEDED_STRATEGY_REQUIRES_SEED',
      `Route strategy "${policy.strategy}" requires a non-empty host-recorded seed`,
    )
  }
  if (policy.strategy === 'hash' && !nonEmpty(options.routingKey)) {
    throw new DeterministicRouteSelectionAdmissionError(
      'HASH_STRATEGY_REQUIRES_ROUTING_KEY',
      'Hash route strategy requires a non-empty routing key',
    )
  }
  if (policy.strategy === 'round-robin' && options.roundRobinCursor !== undefined) {
    if (!nonEmpty(options.roundRobinCursor)) {
      throw new DeterministicRouteSelectionAdmissionError(
        'ROUND_ROBIN_STRATEGY_INVALID_CURSOR',
        'Round-robin cursor must be a non-empty candidate ID',
      )
    }
    if (!candidateIds.has(options.roundRobinCursor)) {
      throw new DeterministicRouteSelectionAdmissionError(
        'ROUND_ROBIN_STRATEGY_UNKNOWN_CURSOR_CANDIDATE',
        `Round-robin cursor is not declared by this policy: ${options.roundRobinCursor}`,
      )
    }
  }
}

export const ROUTE_POLICY_ADMISSION_CODES = [
  'ROUTE_POLICY_EXPECTED_OBJECT',
  'ROUTE_POLICY_UNKNOWN_KEY',
  'ROUTE_POLICY_REQUIRED_FIELD',
  'ROUTE_POLICY_EXPECTED_STRING',
  'ROUTE_POLICY_EXPECTED_BOOLEAN',
  'ROUTE_POLICY_EXPECTED_NUMBER',
  'ROUTE_POLICY_EXPECTED_ARRAY',
  'ROUTE_POLICY_EXPECTED_ENUM',
  'ROUTE_POLICY_EMPTY_STRING',
  'ROUTE_POLICY_INVALID_INTEGER',
  'ROUTE_POLICY_CANDIDATE_EXPECTED_OBJECT',
  'ROUTE_POLICY_CANDIDATE_UNKNOWN_KEY',
  'ROUTE_POLICY_HEALTH_EXPECTED_OBJECT',
  'ROUTE_POLICY_HEALTH_UNKNOWN_KEY',
  'ROUTE_POLICY_CONSTRAINT_EXPECTED_OBJECT',
  'ROUTE_POLICY_CONSTRAINT_UNKNOWN_KEY',
  'ROUTE_POLICY_REQUIREMENTS_UNKNOWN_KEY',
] as const

export type RoutePolicyAdmissionCode = (typeof ROUTE_POLICY_ADMISSION_CODES)[number]

/** A stable path-bearing failure from the dependency-free public admission boundary. */
export class RoutePolicyAdmissionError extends Error {
  readonly code: RoutePolicyAdmissionCode
  readonly path: string

  constructor(code: RoutePolicyAdmissionCode, path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'RoutePolicyAdmissionError'
    this.code = code
    this.path = path
  }
}

const POLICY_KEYS = [
  'id', 'requestId', 'strategy', 'candidates', 'hardConstraints', 'preferenceOrder',
  'fallback', 'maxSelectionLatencyMs', 'originCandidateId', 'approvedTransitions', 'requirements',
] as const
const CANDIDATE_KEYS = [
  'id', 'provider', 'backend', 'authMode', 'agentHost', 'model', 'profileRef', 'authSourceRef',
  'authAvailable', 'backendAvailable', 'modelAvailable', 'health', 'costClass', 'privacyClass',
  'locality', 'accessClass', 'policyCompatible', 'tags', 'capabilities',
] as const
const HEALTH_KEYS = ['status', 'checkedAt', 'reason'] as const
const CONSTRAINT_KEYS = ['kind', 'values'] as const
const REQUIREMENTS_KEYS = [
  'providers', 'backends', 'agentHosts', 'models', 'capabilities', 'profileRefs', 'authSourceRefs',
  'maximumCostClass', 'minimumPrivacyClass', 'requireHealthy',
] as const

const STRATEGIES = ['fixed', 'rule', 'weighted', 'hash', 'round-robin', 'llm-rank'] as const
const FALLBACKS = ['none', 'ordered-compatible'] as const
const BACKENDS = ['cli', 'local-model', 'sdk', 'api', 'remote'] as const
const AUTH_MODES = ['subscription_cli', 'api_key', 'workload_identity', 'local_model'] as const
const HEALTH_STATUSES = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const
const COST_CLASSES = ['free', 'low', 'medium', 'high'] as const
const PRIVACY_CLASSES = ['device', 'private-network', 'provider', 'public'] as const
const LOCALITIES = ['local', 'remote'] as const
const ACCESS_CLASSES = ['local', 'subscription', 'api'] as const
const CONSTRAINT_KINDS = ['provider', 'tags', 'capability', 'policy'] as const
const TRANSITIONS = [
  'subscription-to-api', 'local-to-remote', 'identity-change', 'privacy-downgrade', 'higher-cost',
] as const

/** Strictly parse and rebuild an untrusted route policy without coercion or retained references. */
export function admitExecutionRoutePolicy(input: unknown): ExecutionRoutePolicy {
  const source = record(input, '$', 'ROUTE_POLICY_EXPECTED_OBJECT')
  knownKeys(source, POLICY_KEYS, '$', 'ROUTE_POLICY_UNKNOWN_KEY')

  const maxSelectionLatencyMs = required(source, 'maxSelectionLatencyMs', '$')
  if (typeof maxSelectionLatencyMs !== 'number') {
    fail('ROUTE_POLICY_EXPECTED_NUMBER', '$.maxSelectionLatencyMs', 'expected a number')
  }
  if (!Number.isSafeInteger(maxSelectionLatencyMs) || maxSelectionLatencyMs <= 0) {
    fail('ROUTE_POLICY_INVALID_INTEGER', '$.maxSelectionLatencyMs', 'expected a positive safe integer')
  }

  const candidates = array(required(source, 'candidates', '$'), '$.candidates')
    .map((candidate, index) => admitCandidate(candidate, `$.candidates[${index}]`))
  const hardConstraints = array(required(source, 'hardConstraints', '$'), '$.hardConstraints')
    .map((constraint, index) => admitConstraint(constraint, `$.hardConstraints[${index}]`))

  return {
    id: nonEmptyString(required(source, 'id', '$'), '$.id'),
    requestId: nonEmptyString(required(source, 'requestId', '$'), '$.requestId'),
    strategy: enumValue(required(source, 'strategy', '$'), STRATEGIES, '$.strategy'),
    candidates,
    hardConstraints,
    preferenceOrder: stringArray(required(source, 'preferenceOrder', '$'), '$.preferenceOrder'),
    fallback: enumValue(required(source, 'fallback', '$'), FALLBACKS, '$.fallback'),
    maxSelectionLatencyMs,
    ...optionalStringProperty(source, 'originCandidateId', '$.originCandidateId'),
    ...optionalEnumArrayProperty(source, 'approvedTransitions', TRANSITIONS, '$.approvedTransitions'),
    ...(source.requirements === undefined
      ? {}
      : { requirements: admitRequirements(source.requirements, '$.requirements') }),
  }
}

function admitCandidate(input: unknown, path: string): ExecutionRouteCandidate {
  const source = record(input, path, 'ROUTE_POLICY_CANDIDATE_EXPECTED_OBJECT')
  knownKeys(source, CANDIDATE_KEYS, path, 'ROUTE_POLICY_CANDIDATE_UNKNOWN_KEY')
  return {
    id: nonEmptyString(required(source, 'id', path), `${path}.id`),
    ...optionalStringProperty(source, 'provider', `${path}.provider`),
    ...optionalEnumProperty(source, 'backend', BACKENDS, `${path}.backend`),
    ...optionalEnumProperty(source, 'authMode', AUTH_MODES, `${path}.authMode`),
    ...optionalStringProperty(source, 'agentHost', `${path}.agentHost`),
    ...optionalStringProperty(source, 'model', `${path}.model`),
    ...optionalStringProperty(source, 'profileRef', `${path}.profileRef`),
    ...optionalStringProperty(source, 'authSourceRef', `${path}.authSourceRef`),
    ...optionalBooleanProperty(source, 'authAvailable', `${path}.authAvailable`),
    ...optionalBooleanProperty(source, 'backendAvailable', `${path}.backendAvailable`),
    ...optionalBooleanProperty(source, 'modelAvailable', `${path}.modelAvailable`),
    ...(source.health === undefined ? {} : { health: admitHealth(source.health, `${path}.health`) }),
    ...optionalEnumProperty(source, 'costClass', COST_CLASSES, `${path}.costClass`),
    ...optionalEnumProperty(source, 'privacyClass', PRIVACY_CLASSES, `${path}.privacyClass`),
    ...optionalEnumProperty(source, 'locality', LOCALITIES, `${path}.locality`),
    ...optionalEnumProperty(source, 'accessClass', ACCESS_CLASSES, `${path}.accessClass`),
    ...optionalBooleanProperty(source, 'policyCompatible', `${path}.policyCompatible`),
    ...optionalStringArrayProperty(source, 'tags', `${path}.tags`),
    ...optionalStringArrayProperty(source, 'capabilities', `${path}.capabilities`),
  }
}

function admitHealth(input: unknown, path: string): ExecutionRouteCandidateHealth {
  const source = record(input, path, 'ROUTE_POLICY_HEALTH_EXPECTED_OBJECT')
  knownKeys(source, HEALTH_KEYS, path, 'ROUTE_POLICY_HEALTH_UNKNOWN_KEY')
  return {
    status: enumValue(required(source, 'status', path), HEALTH_STATUSES, `${path}.status`),
    ...optionalStringProperty(source, 'checkedAt', `${path}.checkedAt`),
    ...optionalStringProperty(source, 'reason', `${path}.reason`),
  }
}

function admitConstraint(input: unknown, path: string): ExecutionRouteConstraint {
  const source = record(input, path, 'ROUTE_POLICY_CONSTRAINT_EXPECTED_OBJECT')
  knownKeys(source, CONSTRAINT_KEYS, path, 'ROUTE_POLICY_CONSTRAINT_UNKNOWN_KEY')
  return {
    kind: enumValue(required(source, 'kind', path), CONSTRAINT_KINDS, `${path}.kind`),
    values: stringArray(required(source, 'values', path), `${path}.values`),
  }
}

function admitRequirements(input: unknown, path: string): ExecutionRouteRequirements {
  const source = record(input, path, 'ROUTE_POLICY_EXPECTED_OBJECT')
  knownKeys(source, REQUIREMENTS_KEYS, path, 'ROUTE_POLICY_REQUIREMENTS_UNKNOWN_KEY')
  return {
    ...optionalStringArrayProperty(source, 'providers', `${path}.providers`),
    ...optionalEnumArrayProperty(source, 'backends', BACKENDS, `${path}.backends`),
    ...optionalStringArrayProperty(source, 'agentHosts', `${path}.agentHosts`),
    ...optionalStringArrayProperty(source, 'models', `${path}.models`),
    ...optionalStringArrayProperty(source, 'capabilities', `${path}.capabilities`),
    ...optionalStringArrayProperty(source, 'profileRefs', `${path}.profileRefs`),
    ...optionalStringArrayProperty(source, 'authSourceRefs', `${path}.authSourceRefs`),
    ...optionalEnumProperty(source, 'maximumCostClass', COST_CLASSES, `${path}.maximumCostClass`),
    ...optionalEnumProperty(source, 'minimumPrivacyClass', PRIVACY_CLASSES, `${path}.minimumPrivacyClass`),
    ...optionalBooleanProperty(source, 'requireHealthy', `${path}.requireHealthy`),
  }
}

type InputRecord = Record<string, unknown>

function record(input: unknown, path: string, code: RoutePolicyAdmissionCode): InputRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(code, path, 'expected an object')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, path, 'expected a plain object')
  }
  return input as InputRecord
}

function knownKeys(
  source: InputRecord,
  allowed: readonly string[],
  path: string,
  code: RoutePolicyAdmissionCode,
): void {
  const allowedKeys = new Set(allowed)
  for (const ownKey of Reflect.ownKeys(source)) {
    if (typeof ownKey !== 'string') {
      fail(code, path, 'symbol keys are not admitted')
    }
    const key = ownKey
    if (!allowedKeys.has(key)) fail(code, `${path}.${key}`, `unknown key "${key}"`)
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      fail(code, `${path}.${key}`, 'accessor properties are not admitted')
    }
  }
}

function required(source: InputRecord, key: string, path: string): unknown {
  if (!Object.hasOwn(source, key) || source[key] === undefined) {
    fail('ROUTE_POLICY_REQUIRED_FIELD', `${path}.${key}`, 'required field is missing')
  }
  return source[key]
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('ROUTE_POLICY_EXPECTED_ARRAY', path, 'expected an array')
  return value
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail('ROUTE_POLICY_EXPECTED_STRING', path, 'expected a string')
  if (value.length === 0) fail('ROUTE_POLICY_EMPTY_STRING', path, 'expected a non-empty string')
  return value
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('ROUTE_POLICY_EXPECTED_BOOLEAN', path, 'expected a boolean')
  return value
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  const parsed = nonEmptyString(value, path)
  if (!(allowed as readonly string[]).includes(parsed)) {
    fail('ROUTE_POLICY_EXPECTED_ENUM', path, `expected one of: ${allowed.join(', ')}`)
  }
  return parsed as T[number]
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => nonEmptyString(item, `${path}[${index}]`))
}

function optionalStringProperty<K extends string>(
  source: InputRecord,
  key: K,
  path: string,
): Partial<Record<K, string>> {
  return source[key] === undefined ? {} : { [key]: nonEmptyString(source[key], path) } as Record<K, string>
}

function optionalBooleanProperty<K extends string>(
  source: InputRecord,
  key: K,
  path: string,
): Partial<Record<K, boolean>> {
  return source[key] === undefined ? {} : { [key]: booleanValue(source[key], path) } as Record<K, boolean>
}

function optionalStringArrayProperty<K extends string>(
  source: InputRecord,
  key: K,
  path: string,
): Partial<Record<K, readonly string[]>> {
  return source[key] === undefined
    ? {}
    : { [key]: stringArray(source[key], path) } as unknown as Record<K, readonly string[]>
}

function optionalEnumProperty<K extends string, const T extends readonly string[]>(
  source: InputRecord,
  key: K,
  allowed: T,
  path: string,
): Partial<Record<K, T[number]>> {
  return source[key] === undefined ? {} : { [key]: enumValue(source[key], allowed, path) } as Record<K, T[number]>
}

function optionalEnumArrayProperty<K extends string, const T extends readonly string[]>(
  source: InputRecord,
  key: K,
  allowed: T,
  path: string,
): Partial<Record<K, readonly T[number][]>> {
  if (source[key] === undefined) return {}
  const parsed = array(source[key], path).map((item, index) => enumValue(item, allowed, `${path}[${index}]`))
  return { [key]: parsed } as unknown as Record<K, readonly T[number][]>
}

function fail(code: RoutePolicyAdmissionCode, path: string, message: string): never {
  throw new RoutePolicyAdmissionError(code, path, message)
}

function isImplementedStrategy(
  strategy: ExecutionRoutePolicy['strategy'],
): strategy is ImplementedDeterministicRouteStrategy {
  return (IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES as readonly string[]).includes(strategy)
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}
