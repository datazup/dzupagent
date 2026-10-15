const REQUIRED_INTEGRATION_ENV_VAR = 'RUN_REQUIRED_INTEGRATION'

/**
 * Package-local fail-closed gate for agent-adapters integration suites
 * (DZUPAGENT-TEST-M-24). Mirrors `requireIntegration` in
 * `@dzupagent/test-utils`, which this package does not depend on.
 *
 * - Capability available: `{ shouldSkip: false }`.
 * - Unavailable, `RUN_REQUIRED_INTEGRATION` unset: `{ shouldSkip: true }`.
 * - Unavailable, `RUN_REQUIRED_INTEGRATION=1`: throws, so the suite fails
 *   instead of silently skipping to green.
 */
export function requireIntegration(options: {
  name: string
  available: boolean
  reason: string
}): { shouldSkip: boolean } {
  if (options.available) return { shouldSkip: false }
  if (process.env[REQUIRED_INTEGRATION_ENV_VAR]) {
    throw new Error(
      `[require-integration] "${options.name}" cannot run: ${options.reason} ` +
        `(${REQUIRED_INTEGRATION_ENV_VAR}=1 requires this suite to run rather than skip). ` +
        `Provision the missing dependency, or unset ${REQUIRED_INTEGRATION_ENV_VAR} to allow skipping locally.`,
    )
  }
  return { shouldSkip: true }
}
