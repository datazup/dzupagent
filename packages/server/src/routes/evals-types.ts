import type { MetricsCollector } from '@dzupagent/core/utils'
import type {
  EvalExecutionTarget,
  EvalOrchestratorLike,
  EvalRunStore,
  EvalSuite,
} from '@dzupagent/eval-contracts'

/**
 * Factory for constructing an `EvalOrchestratorLike`. Injected so the server
 * (Layer 4) does not need a runtime dependency on `@dzupagent/evals` (Layer 5).
 * Hosts that want eval execution provide this factory, typically importing
 * `EvalOrchestrator` from `@dzupagent/evals`.
 */
export type EvalOrchestratorFactory = (deps: {
  store: EvalRunStore
  executeTarget?: EvalExecutionTarget
  allowReadOnlyMode?: boolean
  metrics?: MetricsCollector
}) => EvalOrchestratorLike

export interface EvalRouteConfig {
  /** Optional label returned by the route for operator diagnostics. */
  serviceName?: string
  /** Optional execution target used to run suites. */
  executeTarget?: EvalExecutionTarget
  /** Explicitly allow read-only mode when no execution target is configured. */
  allowReadOnlyMode?: boolean
  /** Optional in-memory or persistent eval run store. */
  store?: EvalRunStore
  /** Optional metrics collector used for queue visibility hooks. */
  metrics?: MetricsCollector
  /** Optional registry for resolving `suiteId` when a full suite payload is not posted. */
  suites?: Record<string, EvalSuite>
  /**
   * Pre-constructed orchestrator. If provided, takes precedence over
   * `orchestratorFactory`. Enables full dependency injection from the host.
   */
  orchestrator?: EvalOrchestratorLike
  /**
   * Factory that constructs an orchestrator from the resolved store + target.
   * Hosts using `@dzupagent/evals` typically pass
   * `(deps) => new EvalOrchestrator(deps)`.
   *
   * When neither `orchestrator` nor `orchestratorFactory` is supplied the
   * server falls back to read-only mode so eval routes stay available without
   * an evals runtime.
   */
  orchestratorFactory?: EvalOrchestratorFactory
}
