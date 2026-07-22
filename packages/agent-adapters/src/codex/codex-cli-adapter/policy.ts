import { ForgeError } from "@dzupagent/core/events";

/**
 * Shared error factories and small value helpers used across the Codex CLI
 * adapter leaf modules. Extracted from the composition root so the class,
 * the persistent-home projection, and the MCP projection share one canonical
 * ForgeError shape ({ code: 'CAPABILITY_DENIED', ... }) and env/option coercion.
 */

/** Denial with the codex_cli_policy_rejected telemetry marker attached. */
export function policyRejected(message: string, reason: string): ForgeError {
  return new ForgeError({
    code: "CAPABILITY_DENIED",
    message,
    recoverable: false,
    context: {
      providerId: "codex",
      backend: "cli",
      reason,
      telemetry: "codex_cli_policy_rejected",
    },
  });
}

/** Denial for capabilities the CLI backend does not expose (no telemetry marker). */
export function unsupported(message: string): ForgeError {
  return new ForgeError({
    code: "CAPABILITY_DENIED",
    message,
    recoverable: false,
    context: { providerId: "codex", backend: "cli" },
  });
}

/** Coerce an unknown option value to a non-empty string, else undefined. */
export function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** True for env keys that must never be forwarded to the Codex subprocess. */
export function isSensitiveEnvKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|credential|password|auth)/iu.test(key);
}

/** Combine an optional external abort signal with the adapter's internal one. */
export function combineSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal
): AbortSignal {
  if (!external) return internal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (external.aborted || internal.aborted) controller.abort();
  else {
    external.addEventListener("abort", abort, { once: true });
    internal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
