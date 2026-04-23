/**
 * @deprecated This module has been absorbed into `@dzupagent/core`. It now
 * re-exports `KeyedCircuitBreaker` from core under the legacy
 * `AgentCircuitBreaker` name so that existing call sites (and tests) keep
 * working unchanged. New code should import `KeyedCircuitBreaker` directly
 * from `@dzupagent/core`.
 *
 * The core `KeyedCircuitBreaker` accepts `cooldownMs` as an alias for
 * `resetTimeoutMs`, preserving the orchestration API.
 */
export {
  KeyedCircuitBreaker as AgentCircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitState,
} from '@dzupagent/core'
