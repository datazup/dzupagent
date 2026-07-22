import type { ReadContext, WriteContext } from "@dzupagent/agent-types";

import type { RequestSignalContext } from "./types.js";

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : err instanceof Error && err.name === "AbortError";
}

export function createRequestSignal(
  timeoutMs: number,
  externalSignal?: ReadContext["signal"] | WriteContext["signal"]
): RequestSignalContext {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let detachExternalAbort: (() => void) | undefined;

  if (externalSignal?.aborted) {
    controller.abort();
  } else if (externalSignal?.addEventListener) {
    const onAbort = (): void => {
      controller.abort();
    };
    externalSignal.addEventListener("abort", onAbort);
    detachExternalAbort = () => {
      externalSignal.removeEventListener?.("abort", onAbort);
    };
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      detachExternalAbort?.();
    },
    didTimeout: () => timedOut,
  };
}
