/**
 * Request deadline for embedding providers (SHARED-KIT-AGENT-M-74).
 *
 * Every provider in this directory posts to a remote endpoint with a bare
 * `fetch()`. `fetch()` has no default timeout: a server that accepts the
 * connection and then stops responding leaves the promise pending forever. The
 * embedder sits on the memory *write* path, so that one stalled socket wedges
 * the caller — an agent turn, a consolidation pass, a request handler — with no
 * error, no retry, and nothing in the logs. A hung dependency must look like a
 * failure, not like slowness.
 *
 * The deadline is per attempt, so it composes with the retry/backoff loops the
 * providers already run: a timeout is classified recoverable and gets the same
 * treatment as a 503.
 */

import { ForgeError } from "../../errors/forge-error.js";

/**
 * Default per-attempt deadline.
 *
 * Generous enough for a cold self-hosted model loading weights on first call
 * (the slowest legitimate case observed), short enough that a wedged endpoint
 * surfaces inside one agent turn rather than at the request timeout.
 */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * `fetch()` with a per-attempt deadline.
 *
 * On expiry the request is aborted and a recoverable `PROVIDER_TIMEOUT`
 * {@link ForgeError} is thrown, so a caller's existing retry loop treats it the
 * way it treats a transient upstream failure.
 *
 * @param url        Endpoint to post to.
 * @param init       Standard `fetch` init. Any `signal` already present is
 *                   honoured alongside the deadline — whichever fires first
 *                   aborts the request.
 * @param providerId Logical provider id, for the error message and context.
 * @param timeoutMs  Deadline override; defaults to
 *                   {@link DEFAULT_EMBEDDING_TIMEOUT_MS}.
 */
export async function fetchWithEmbeddingTimeout(
  url: string,
  init: RequestInit,
  providerId: string,
  timeoutMs: number = DEFAULT_EMBEDDING_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // A caller-supplied signal must keep working; abort on either.
  const callerSignal = init.signal;
  const forwardAbort = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    // eslint-disable-next-line no-restricted-globals -- the guarded wrapper every embedding provider routes through; endpoints here are operator-configured infrastructure, not user input
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: unknown) {
    // Only *our* deadline becomes a timeout error. A caller-initiated abort is
    // that caller's cancellation and is re-thrown untouched.
    const abortedByDeadline =
      controller.signal.aborted && callerSignal?.aborted !== true;
    if (abortedByDeadline) {
      throw new ForgeError({
        code: "PROVIDER_TIMEOUT",
        message: `${providerId} embedding request timed out after ${timeoutMs}ms`,
        recoverable: true,
        suggestion:
          "Check that the embedding endpoint is reachable and responsive, " +
          "or raise the provider's timeoutMs.",
        context: { provider: providerId, timeoutMs },
        ...(err instanceof Error ? { cause: err } : {}),
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}
