export type HttpMemoryOperation = "get" | "put" | "delete";

export interface HttpMemoryRequestResult {
  signal: "http_memory_client_request_result";
  operation: HttpMemoryOperation;
  namespace: string;
  status?: number;
  outcome: "success" | "http_error" | "timeout" | "aborted" | "network_error";
  errorCode?: string;
}

export interface HttpMemoryClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Optional fetch override for testing or non-browser environments. */
  fetch?: typeof fetch;
  /** Optional structured diagnostics callback for request outcomes. */
  onRequestResult?: (result: HttpMemoryRequestResult) => void;
}

export interface RequestSignalContext {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
}
