import type {
  MemoryClient,
  MemoryRecord,
  MemoryScope,
  MemoryQuery,
  ReadContext,
  WriteContext,
  CancellationSignal,
} from "@dzupagent/agent-types";

import {
  HttpMemoryError,
  HttpMemoryResponseError,
  HttpMemoryTimeoutError,
  HttpMemoryAbortError,
  decodeErrorBody,
} from "./http-client/errors.js";
import {
  createRequestSignal,
  isAbortError,
  normalizeBaseUrl,
} from "./http-client/request.js";
import type {
  HttpMemoryClientConfig,
  HttpMemoryOperation,
  HttpMemoryRequestResult,
} from "./http-client/types.js";
import {
  DEFAULT_TIMEOUT_MS,
  validateNamespace,
  validateQuery,
  validateRecord,
  validateScope,
} from "./http-client/validation.js";

export {
  NotImplementedError,
  HttpMemoryError,
  HttpMemoryTimeoutError,
  HttpMemoryAbortError,
  HttpMemoryResponseError,
} from "./http-client/errors.js";
export type {
  HttpMemoryClientConfig,
  HttpMemoryOperation,
  HttpMemoryRequestResult,
} from "./http-client/types.js";

export class HttpMemoryClient implements MemoryClient {
  /** Retained for inspection by tooling once the wire protocol lands. */
  readonly config: HttpMemoryClientConfig;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpMemoryClientConfig) {
    if (!config.baseUrl) {
      throw new Error("HttpMemoryClient requires baseUrl");
    }

    this.config = config;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.fetchImpl = config.fetch ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("HttpMemoryClient requires fetch to be available");
    }
  }

  async get(
    namespace: string,
    scope: MemoryScope,
    query?: MemoryQuery,
    ctx?: ReadContext
  ): Promise<MemoryRecord[]> {
    validateNamespace(namespace);
    validateScope(scope);
    validateQuery(query);

    const params = new URLSearchParams();
    params.set("scope", JSON.stringify(scope));
    if (query !== undefined) {
      params.set("query", JSON.stringify(query));
    }

    const endpoint = `${this.buildNamespaceUrl(
      namespace
    )}?${params.toString()}`;

    const response = await this.request(
      "get",
      endpoint,
      {
        method: "GET",
        ...(ctx?.signal !== undefined
          ? { signal: ctx.signal as unknown as AbortSignal }
          : {}),
      },
      namespace
    );

    const payload = await this.parseJsonBody(response);

    if (Array.isArray(payload)) {
      return payload as MemoryRecord[];
    }

    if (
      payload &&
      typeof payload === "object" &&
      Array.isArray((payload as Record<string, unknown>)["records"])
    ) {
      return (payload as { records: MemoryRecord[] }).records;
    }

    return [];
  }

  async put(
    namespace: string,
    scope: MemoryScope,
    record: MemoryRecord,
    ctx?: WriteContext
  ): Promise<void> {
    validateNamespace(namespace);
    validateScope(scope);
    validateRecord(record, namespace, scope);

    await this.request(
      "put",
      this.buildRecordUrl(namespace, record.id),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ scope, record }),
        ...(ctx?.signal !== undefined
          ? { signal: ctx.signal as unknown as AbortSignal }
          : {}),
      },
      namespace
    );
  }

  async delete(
    namespace: string,
    scope: MemoryScope,
    recordId: string
  ): Promise<boolean> {
    validateNamespace(namespace);
    validateScope(scope);

    if (recordId.trim().length === 0) {
      throw new Error("Memory recordId must be non-empty");
    }

    const params = new URLSearchParams();
    params.set("scope", JSON.stringify(scope));

    const response = await this.request(
      "delete",
      `${this.buildRecordUrl(namespace, recordId)}?${params.toString()}`,
      {
        method: "DELETE",
      },
      namespace
    );

    if (response.status === 204) {
      return true;
    }

    const payload = await this.parseJsonBody(response);

    if (typeof payload === "boolean") {
      return payload;
    }

    if (payload && typeof payload === "object") {
      const obj = payload as Record<string, unknown>;
      if (typeof obj["deleted"] === "boolean") {
        return obj["deleted"];
      }
      if (typeof obj["ok"] === "boolean") {
        return obj["ok"];
      }
    }

    return true;
  }

  private buildNamespaceUrl(namespace: string): string {
    return `${this.baseUrl}/memory/${encodeURIComponent(namespace)}`;
  }

  private buildRecordUrl(namespace: string, recordId: string): string {
    return `${this.buildNamespaceUrl(namespace)}/${encodeURIComponent(
      recordId
    )}`;
  }

  private buildHeaders(extraHeaders?: Record<string, string>): Headers {
    const headers = new Headers();
    headers.set("Accept", "application/json; charset=utf-8");

    for (const [key, value] of Object.entries(this.config.headers ?? {})) {
      headers.set(key, value);
    }

    if (this.config.apiKey) {
      headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    }

    for (const [key, value] of Object.entries(extraHeaders ?? {})) {
      headers.set(key, value);
    }

    return headers;
  }

  private async request(
    operation: HttpMemoryOperation,
    url: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
    namespace: string
  ): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const requestSignal = createRequestSignal(
      timeoutMs,
      init.signal as CancellationSignal | undefined
    );

    try {
      const { signal: _initSignal, headers: _initHeaders, ...restInit } = init;
      const response = await this.fetchImpl(url, {
        ...restInit,
        headers: this.buildHeaders(_initHeaders),
        signal: requestSignal.signal,
      });

      if (!response.ok) {
        const mapped = await this.mapHttpError(operation, response);
        this.emitRequestResult({
          signal: "http_memory_client_request_result",
          operation,
          namespace,
          ...(mapped.status !== undefined ? { status: mapped.status } : {}),
          outcome: "http_error",
          ...(mapped.errorCode !== undefined
            ? { errorCode: mapped.errorCode }
            : {}),
        });
        throw mapped;
      }

      this.emitRequestResult({
        signal: "http_memory_client_request_result",
        operation,
        namespace,
        status: response.status,
        outcome: "success",
      });

      return response;
    } catch (err) {
      if (isAbortError(err)) {
        const timeoutError = requestSignal.didTimeout()
          ? new HttpMemoryTimeoutError(operation, timeoutMs)
          : new HttpMemoryAbortError(operation);

        this.emitRequestResult({
          signal: "http_memory_client_request_result",
          operation,
          namespace,
          outcome: requestSignal.didTimeout() ? "timeout" : "aborted",
          ...(timeoutError.errorCode !== undefined
            ? { errorCode: timeoutError.errorCode }
            : {}),
        });
        throw timeoutError;
      }

      if (err instanceof HttpMemoryError) {
        throw err;
      }

      const mapped = new HttpMemoryError(
        `HttpMemoryClient.${operation} request failed`,
        operation,
        {
          errorCode: "HTTP_MEMORY_NETWORK_ERROR",
          cause: err,
        }
      );

      this.emitRequestResult({
        signal: "http_memory_client_request_result",
        operation,
        namespace,
        outcome: "network_error",
        ...(mapped.errorCode !== undefined
          ? { errorCode: mapped.errorCode }
          : {}),
      });

      throw mapped;
    } finally {
      requestSignal.cleanup();
    }
  }

  private async mapHttpError(
    operation: HttpMemoryOperation,
    response: Response
  ): Promise<HttpMemoryResponseError> {
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";

    let message = response.statusText || "Request failed";
    let errorCode: string | undefined;
    let details: unknown;

    if (contentType.includes("application/json")) {
      const parsed = decodeErrorBody(await this.parseJsonBody(response));
      message = parsed.message ?? parsed.error ?? message;
      errorCode = parsed.code;
      details = parsed.details;
    } else {
      const text = await response.text();
      if (text.trim().length > 0) {
        message = text;
      }
    }

    return new HttpMemoryResponseError(operation, response.status, message, {
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }

  private async parseJsonBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  private emitRequestResult(result: HttpMemoryRequestResult): void {
    this.config.onRequestResult?.(result);
  }
}
