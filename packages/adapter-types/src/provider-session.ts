import {
  PROVIDER_SESSION_RICH_CONTROL_CAPABILITIES,
  validateProviderSessionAttemptBinding,
  type ProviderSessionAdmissionDiagnostic,
  type ProviderSessionAdmissionResult,
  type ProviderSessionAttemptBinding,
  type ProviderSessionCapability,
  type ProviderSessionCompactRequest,
  type ProviderSessionForkRequest,
  type ProviderSessionGoalClearRequest,
  type ProviderSessionGoalGetRequest,
  type ProviderSessionGoalSetRequest,
  type ProviderSessionHistoryReadRequest,
  type ProviderSessionInterruptTurnRequest,
  type ProviderSessionOperationResult,
  type ProviderSessionStartReviewRequest,
  type ProviderSessionSteerRequest,
} from '@dzupagent/runtime-contracts/provider-session'

type Result<Kind extends ProviderSessionOperationResult['kind']> =
  ProviderSessionOperationResult & { readonly kind: Kind }

/**
 * Optional rich-control companion for an existing SDK or CLI adapter.
 * Legacy AgentCLIAdapter implementations need not implement this interface and
 * therefore do not acquire capabilities merely by compiling against it.
 */
export interface ProviderSessionAdapter {
  readonly attemptBinding: ProviderSessionAttemptBinding
  steer?(request: ProviderSessionSteerRequest): Promise<Result<'steer'>>
  interruptTurn?(
    request: ProviderSessionInterruptTurnRequest,
  ): Promise<Result<'interrupt-turn'>>
  forkSession?(request: ProviderSessionForkRequest): Promise<Result<'fork-session'>>
  startReview?(
    request: ProviderSessionStartReviewRequest,
  ): Promise<Result<'start-review'>>
  readHistory?(
    request: ProviderSessionHistoryReadRequest,
  ): Promise<Result<'history-read'>>
  compact?(request: ProviderSessionCompactRequest): Promise<Result<'compact'>>
  getGoal?(request: ProviderSessionGoalGetRequest): Promise<Result<'goal-get'>>
  setGoal?(request: ProviderSessionGoalSetRequest): Promise<Result<'goal-set'>>
  clearGoal?(request: ProviderSessionGoalClearRequest): Promise<Result<'goal-clear'>>
}

export type ProviderSessionAdapterMethod =
  | 'steer'
  | 'interruptTurn'
  | 'forkSession'
  | 'startReview'
  | 'readHistory'
  | 'compact'
  | 'getGoal'
  | 'setGoal'
  | 'clearGoal'

export interface ProviderSessionAdapterDiagnostic {
  readonly code: 'NATIVE_CAPABILITY_METHOD_MISSING'
  readonly path: string
  readonly message: string
}

export interface ProviderSessionAdapterConformanceResult {
  readonly valid: boolean
  readonly diagnostics: readonly (
    | ProviderSessionAdmissionDiagnostic
    | ProviderSessionAdapterDiagnostic
  )[]
}

const RICH_METHODS = {
  steer: ['steer'],
  'interrupt-turn': ['interruptTurn'],
  'fork-session': ['forkSession'],
  'start-review': ['startReview'],
  'history-read': ['readHistory'],
  compact: ['compact'],
  'goal-control': ['getGoal', 'setGoal', 'clearGoal'],
} as const satisfies Record<
  (typeof PROVIDER_SESSION_RICH_CONTROL_CAPABILITIES)[number],
  readonly ProviderSessionAdapterMethod[]
>

/** Validates capability admission and method truth before provider dispatch. */
export function validateProviderSessionAdapter(
  adapter: ProviderSessionAdapter,
  requiredCapabilities: readonly ProviderSessionCapability[] = [],
): ProviderSessionAdapterConformanceResult {
  const bindingResult: ProviderSessionAdmissionResult =
    validateProviderSessionAttemptBinding(
      adapter.attemptBinding,
      requiredCapabilities,
    )
  const diagnostics: (
    | ProviderSessionAdmissionDiagnostic
    | ProviderSessionAdapterDiagnostic
  )[] = [...bindingResult.diagnostics]

  for (const capability of PROVIDER_SESSION_RICH_CONTROL_CAPABILITIES) {
    if (adapter.attemptBinding.descriptor.capabilities[capability]?.status === 'native') {
      for (const method of RICH_METHODS[capability]) {
        if (typeof adapter[method] !== 'function') {
          diagnostics.push({
            code: 'NATIVE_CAPABILITY_METHOD_MISSING',
            path: method,
            message: `Native provider-session capability has no adapter method: ${capability}.`,
          })
        }
      }
    }
  }

  return { valid: diagnostics.length === 0, diagnostics }
}

export type {
  ProviderInteractionRef,
  ProviderReviewRef,
  ProviderSessionAdmissionDiagnostic,
  ProviderSessionAttemptBinding,
  ProviderSessionCapability,
  ProviderSessionCapabilityDescriptor,
  ProviderSessionCompactRequest,
  ProviderSessionForkRequest,
  ProviderSessionGoalClearRequest,
  ProviderSessionGoalGetRequest,
  ProviderSessionGoalSetRequest,
  ProviderSessionGoalSnapshot,
  ProviderSessionGoalStatus,
  ProviderSessionHistoryItem,
  ProviderSessionHistoryReadRequest,
  ProviderSessionInterruptTurnRequest,
  ProviderSessionOperationResult,
  ProviderSessionRef,
  ProviderSessionStartReviewRequest,
  ProviderSessionSteerRequest,
  ProviderThreadRef,
  ProviderTurnRef,
} from '@dzupagent/runtime-contracts/provider-session'
