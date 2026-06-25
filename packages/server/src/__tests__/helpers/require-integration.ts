/**
 * Helpers for integration-test capability gates (MC-8 / TEST-H-02).
 *
 * When `RUN_REQUIRED_INTEGRATION=1` is set (the `test:required-integration`
 * script), tests that would normally skip due to a missing service must
 * instead fail loudly so CI surfaces the missing environment rather than
 * silently reporting a passing (skipped) run.
 */

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
  if (!process.env["TEST_DATABASE_URL"]) {
    if (process.env["RUN_REQUIRED_INTEGRATION"]) {
      throw new Error(
        "TEST_DATABASE_URL is required for integration tests but is not set. " +
          "Set it to a valid Postgres connection string, or unset " +
          "RUN_REQUIRED_INTEGRATION to allow the suite to be skipped."
      );
    }
    return true; // skip
  }
  return false;
}

/**
 * Returns `true` when the caller should skip a test suite because
 * `TEST_REDIS_URL` is absent.
 *
 * Throws when `RUN_REQUIRED_INTEGRATION=1` is set (same semantics as
 * `skipOrFailIfNoDatabase`).
 */
export function skipOrFailIfNoRedis(): boolean {
  if (!process.env["TEST_REDIS_URL"]) {
    if (process.env["RUN_REQUIRED_INTEGRATION"]) {
      throw new Error(
        "TEST_REDIS_URL is required for integration tests but is not set. " +
          "Set it to a valid Redis URL, or unset " +
          "RUN_REQUIRED_INTEGRATION to allow the suite to be skipped."
      );
    }
    return true; // skip
  }
  return false;
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
  if (!containerRuntimeAvailable) {
    if (process.env["RUN_REQUIRED_INTEGRATION"]) {
      throw new Error(
        "A container runtime (Docker) is required for this integration test suite " +
          "but is not available. Start Docker, or unset RUN_REQUIRED_INTEGRATION " +
          "to allow the suite to be skipped."
      );
    }
    return true; // skip
  }
  return false;
}
