const REQUIRED_INTEGRATION_ENV_VAR = 'RUN_REQUIRED_INTEGRATION'

/**
 * Package-local fail-closed gate for Agent integration tests.
 *
 * Keeping this tiny test-only primitive local avoids a production-package
 * build cycle through `agent -> test-utils -> testing -> agent`.
 */
export function requireIntegrationEnv(
  name: string,
  envVarName: string,
): { shouldSkip: boolean } {
  const value = process.env[envVarName]
  if (typeof value === 'string' && value.length > 0) {
    return { shouldSkip: false }
  }
  if (process.env[REQUIRED_INTEGRATION_ENV_VAR]) {
    throw new Error(
      `[require-integration] "${name}" cannot run: ${envVarName} is not set ` +
        `(${REQUIRED_INTEGRATION_ENV_VAR}=1 requires this suite to run rather than skip). ` +
        `Provision the missing dependency, or unset ${REQUIRED_INTEGRATION_ENV_VAR} to allow skipping locally.`,
    )
  }
  return { shouldSkip: true }
}
