/**
 * Shared "fail-closed" gate for integration test suites (DZUPAGENT-TEST-H-01).
 *
 * Problem: integration suites across the monorepo commonly guard themselves
 * with `describe.skipIf(!canRun)`, where `canRun` reflects whether some
 * external service (Postgres, Redis, Qdrant, a container runtime, ...) is
 * reachable. In the required-integration CI lane
 * (`RUN_REQUIRED_INTEGRATION=1`), an unreachable service must NOT be treated
 * as "skip and report green" — it must fail loudly so a missing/misconfigured
 * environment is visible instead of silently passing.
 *
 * `requireIntegration()` centralises that policy:
 *   - When `RUN_REQUIRED_INTEGRATION` is unset (local/dev lane): returns
 *     `{ shouldSkip: true }` if the capability is unavailable, so callers can
 *     keep using `describe.skipIf(requireIntegration(...).shouldSkip)`.
 *   - When `RUN_REQUIRED_INTEGRATION=1` (the required CI lane) and the
 *     capability is unavailable: throws, which fails the suite instead of
 *     skipping it.
 *
 * Usage:
 * ```ts
 * const gate = requireIntegration({
 *   name: 'PostgresRunStore integration',
 *   available: containerRuntimeAvailable && GenericContainerClass !== undefined,
 *   reason: 'Docker/testcontainers unavailable',
 * })
 * describe.skipIf(gate.shouldSkip)('PostgresRunStore integration', () => { ... })
 * ```
 */

/** Name of the env var that switches the required-integration (fail-closed) lane on. */
export const REQUIRED_INTEGRATION_ENV_VAR = 'RUN_REQUIRED_INTEGRATION'

export interface RequireIntegrationOptions {
  /** Human-readable suite/capability name, used in the thrown error message. */
  name: string
  /** Whether the external capability (DB, queue, vector store, container runtime, ...) is reachable. */
  available: boolean
  /**
   * Short explanation of what's missing (e.g. "TEST_DATABASE_URL is not set"
   * or "Docker is not running"). Included in the thrown error message.
   */
  reason: string
}

export interface RequireIntegrationResult {
  /** Whether the caller should skip the suite (`describe.skipIf(result.shouldSkip)`). */
  shouldSkip: boolean
}

/** Returns whether the current process is running the required-integration (fail-closed) lane. */
export function isRequiredIntegrationLane(): boolean {
  return Boolean(process.env[REQUIRED_INTEGRATION_ENV_VAR])
}

/**
 * Fail-closed capability gate for integration suites.
 *
 * - Capability available: always returns `{ shouldSkip: false }`.
 * - Capability unavailable, required lane off: returns `{ shouldSkip: true }`
 *   (suite skips, same as historical `describe.skipIf(!canRun)` behaviour).
 * - Capability unavailable, required lane on (`RUN_REQUIRED_INTEGRATION=1`):
 *   throws, so the suite fails loudly instead of silently skipping.
 */
export function requireIntegration(
  options: RequireIntegrationOptions
): RequireIntegrationResult {
  if (options.available) {
    return { shouldSkip: false }
  }

  if (isRequiredIntegrationLane()) {
    throw new Error(
      `[require-integration] "${options.name}" cannot run: ${options.reason} ` +
        `(${REQUIRED_INTEGRATION_ENV_VAR}=1 requires this suite to run rather than skip). ` +
        `Provision the missing dependency, or unset ${REQUIRED_INTEGRATION_ENV_VAR} to allow skipping locally.`
    )
  }

  return { shouldSkip: true }
}

/**
 * Convenience wrapper: fail-closed gate keyed off an env var that must be a
 * non-empty string (e.g. `TEST_DATABASE_URL`, `QDRANT_URL`).
 *
 * Returns `{ shouldSkip }` like `requireIntegration`, and throws under
 * `RUN_REQUIRED_INTEGRATION=1` when the env var is missing/empty.
 */
export function requireIntegrationEnv(
  name: string,
  envVarName: string
): RequireIntegrationResult {
  const value = process.env[envVarName]
  const available = typeof value === 'string' && value.length > 0
  return requireIntegration({
    name,
    available,
    reason: `${envVarName} is not set`,
  })
}
