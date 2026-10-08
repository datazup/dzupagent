import type { HttpMemoryOperation } from "./types.js";

/**
 * Formerly thrown by the `HttpMemoryClient` stub before the wire protocol
 * shipped. `HttpMemoryClient` now implements `get`/`put`/`delete` over
 * `fetch` and never throws this; failures surface as `HttpMemoryError`
 * subclasses (see `__tests__/http-client-liveness.test.ts`).
 *
 * @deprecated Unreachable. Kept only so existing `instanceof` guards still
 * compile; it will be removed in the next breaking release of
 * `@dzupagent/memory`. Guard on `HttpMemoryError` instead.
 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`HttpMemoryClient.${method} is not implemented yet.`);
    this.name = "NotImplementedError";
  }
}

export interface HttpMemoryErrorBody {
  error?: string;
  message?: string;
  code?: string;
  details?: unknown;
}

export class HttpMemoryError extends Error {
  readonly operation: HttpMemoryOperation;
  readonly status?: number;
  readonly errorCode?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    operation: HttpMemoryOperation,
    options?: {
      status?: number;
      errorCode?: string;
      details?: unknown;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "HttpMemoryError";
    this.operation = operation;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.errorCode !== undefined) this.errorCode = options.errorCode;
    if (options?.details !== undefined) this.details = options.details;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class HttpMemoryTimeoutError extends HttpMemoryError {
  constructor(operation: HttpMemoryOperation, timeoutMs: number) {
    super(
      `HttpMemoryClient.${operation} timed out after ${timeoutMs}ms`,
      operation,
      { errorCode: "HTTP_MEMORY_TIMEOUT" }
    );
    this.name = "HttpMemoryTimeoutError";
  }
}

export class HttpMemoryAbortError extends HttpMemoryError {
  constructor(operation: HttpMemoryOperation) {
    super(`HttpMemoryClient.${operation} was aborted`, operation, {
      errorCode: "HTTP_MEMORY_ABORTED",
    });
    this.name = "HttpMemoryAbortError";
  }
}

export class HttpMemoryResponseError extends HttpMemoryError {
  constructor(
    operation: HttpMemoryOperation,
    status: number,
    message: string,
    options?: { errorCode?: string; details?: unknown }
  ) {
    super(
      `HttpMemoryClient.${operation} failed with HTTP ${status}: ${message}`,
      operation,
      {
        status,
        ...(options?.errorCode !== undefined
          ? { errorCode: options.errorCode }
          : {}),
        ...(options?.details !== undefined ? { details: options.details } : {}),
      }
    );
    this.name = "HttpMemoryResponseError";
  }
}

export function decodeErrorBody(payload: unknown): HttpMemoryErrorBody {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const obj = payload as Record<string, unknown>;
  return {
    ...(typeof obj["error"] === "string" ? { error: obj["error"] } : {}),
    ...(typeof obj["message"] === "string" ? { message: obj["message"] } : {}),
    ...(typeof obj["code"] === "string" ? { code: obj["code"] } : {}),
    ...(obj["details"] !== undefined ? { details: obj["details"] } : {}),
  };
}
