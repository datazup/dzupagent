/**
 * Helpers for integration-test capability gates (MC-8 / TEST-H-02 / DZUPAGENT-TEST-H-01).
 *
 * When `RUN_REQUIRED_INTEGRATION=1` is set (the `test:required-integration`
 * script), tests that would normally skip due to a missing service must
 * instead fail loudly so CI surfaces the missing environment rather than
 * silently reporting a passing (skipped) run.
 *
 * This module re-exports the canonical `requireIntegration` gate from
 * `@dzupagent/test-utils` (single source of truth for the fail-closed
 * policy) alongside a few server-specific convenience wrappers kept for
 * backward compatibility with existing call sites.
 */
import {
  requireIntegration as sharedRequireIntegration,
  requireIntegrationEnv as sharedRequireIntegrationEnv,
} from '@dzupagent/test-utils'

export {
  requireIntegration,
  requireIntegrationEnv,
  isRequiredIntegrationLane,
  REQUIRED_INTEGRATION_ENV_VAR,
} from '@dzupagent/test-utils'
export type {
  RequireIntegrationOptions,
  RequireIntegrationResult,
} from '@dzupagent/test-utils'

/**
 * Returns `true` when the caller should skip a test suite because
 * `TEST_DATABASE_URL` is absent.
 *
 * When `RUN_REQUIRED_INTEGRATION=1`, throws instead of returning `true` so
 * the suite fails loudly rather than being silently skipped.
 *
 * Usage:
 * ```ts
 * describe.skipIf(skipOrFailIfNoDatabase())('my postgres suite', () => { ... })
 * ```
 */
export function skipOrFailIfNoDatabase(): boolean {
  return sharedRequireIntegrationEnv(
    "Postgres integration suite",
    "TEST_DATABASE_URL"
  ).shouldSkip;
}

/**
 * Returns `true` when the caller should skip a test suite because
 * `TEST_REDIS_URL` is absent.
 *
 * Throws when `RUN_REQUIRED_INTEGRATION=1` is set (same semantics as
 * `skipOrFailIfNoDatabase`).
 */
export function skipOrFailIfNoRedis(): boolean {
  return sharedRequireIntegrationEnv(
    "Redis integration suite",
    "TEST_REDIS_URL"
  ).shouldSkip;
}

/**
 * Returns `true` when the caller should skip a test suite because the Docker
 * container runtime is unavailable (detected by the caller).
 *
 * Throws when `RUN_REQUIRED_INTEGRATION=1` is set.
 */
export function skipOrFailIfNoContainerRuntime(
  containerRuntimeAvailable: boolean
): boolean {
  return sharedRequireIntegration({
    name: "container-runtime integration suite",
    available: containerRuntimeAvailable,
    reason:
      "A container runtime (Docker) is required for this integration test suite " +
      "but is not available. Start Docker",
  }).shouldSkip;
}
