import type {
  ProviderSessionRef,
  RuntimeToolHandlerFailureResult,
  RuntimeToolHandlerSuccessResult,
  RuntimeToolStructuredError,
} from "../pipeline-runtime-types.js";
import { compactRuntimeToolResult } from "./arg-helpers.js";

export interface RuntimeToolSuccessOptions {
  output: unknown;
  providerSessionRefs?: ProviderSessionRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RuntimeToolFailureOptions {
  output?: unknown | undefined;
  providerSessionRefs?: ProviderSessionRef[] | undefined;
}

export function runtimeToolSuccess(
  options: RuntimeToolSuccessOptions
): RuntimeToolHandlerSuccessResult {
  return compactRuntimeToolResult({
    __dzupRuntimeToolResult: true,
    ok: true,
    output: options.output,
    providerSessionRefs: options.providerSessionRefs,
    metadata: options.metadata,
  }) as RuntimeToolHandlerSuccessResult;
}

export function runtimeToolFailure(
  error: string | RuntimeToolStructuredError,
  options: RuntimeToolFailureOptions = {}
): RuntimeToolHandlerFailureResult {
  return compactRuntimeToolResult({
    __dzupRuntimeToolResult: true,
    ok: false,
    error: normalizeRuntimeToolError(error),
    output: options.output,
    providerSessionRefs: options.providerSessionRefs,
  }) as RuntimeToolHandlerFailureResult;
}

export function runtimeToolErrorMetadata(
  error: RuntimeToolStructuredError
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    ...(error.metadata ?? {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function normalizeRuntimeToolError(
  error: string | RuntimeToolStructuredError
): RuntimeToolStructuredError {
  return typeof error === "string" ? { message: error } : error;
}
