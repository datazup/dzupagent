import type {
  BenchmarkOrchestratorLike,
  BenchmarkRunStore,
  BenchmarkSuite,
} from '@dzupagent/eval-contracts'

/**
 * Factory for a `BenchmarkOrchestratorLike`. Injected so the server does not
 * take a runtime dependency on `@dzupagent/evals`. Hosts typically construct
 * `new BenchmarkOrchestrator({ ... })` from `@dzupagent/evals` inside this
 * factory.
 */
export type BenchmarkOrchestratorFactory = (deps: {
  suites: Record<string, BenchmarkSuite>
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>
  allowNonStrictExecution?: boolean
  store: BenchmarkRunStore
}) => BenchmarkOrchestratorLike

export interface BenchmarkRouteConfig {
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>
  /** Explicitly allow non-strict benchmark fallback behavior. */
  allowNonStrictExecution?: boolean
  /**
   * Registry of benchmark suites the host wants exposed over HTTP. The server
   * no longer ships the default evals suite bundle (that coupling was part of
   * the MC-A02 layer-inversion fix); hosts that want the canonical suites
   * should import them from `@dzupagent/evals` and pass them here.
   */
  suites?: Record<string, BenchmarkSuite>
  store?: BenchmarkRunStore
  /** Pre-constructed orchestrator. Takes precedence over `orchestratorFactory`. */
  orchestrator?: BenchmarkOrchestratorLike
  /**
   * Factory for constructing a benchmark orchestrator. When provided, the
   * server composes the orchestrator on startup. When neither `orchestrator`
   * nor `orchestratorFactory` is supplied the routes throw 503 on write
   * endpoints while still serving read endpoints from the store.
   */
  orchestratorFactory?: BenchmarkOrchestratorFactory
}
