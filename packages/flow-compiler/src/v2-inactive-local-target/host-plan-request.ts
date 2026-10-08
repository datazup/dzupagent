import { findConfigLiteralSecret } from "@dzupagent/flow-dsl";

import type {
  V2InactiveLocalHostError,
  V2InactiveLocalHostRequest,
} from "./host-contracts.js";

const MAX_CONFIG_BINDING_LENGTH = 256;

/** Diagnostic path for a config binding; a secret-shaped name is never echoed. */
export function configBindingPath(name: string): string {
  return `configBindings.${
    findConfigLiteralSecret(name) === undefined ? name : "<redacted>"
  }`;
}

export function validateV2InactiveLocalHostRequest(
  request: V2InactiveLocalHostRequest
): V2InactiveLocalHostError | undefined {
  if (!isBoundedId(request.runId)) {
    return invalid("runId", "runId must be 1-128 visible characters");
  }
  if (!isBoundedId(request.ownerId)) {
    return invalid("ownerId", "ownerId must be 1-128 visible characters");
  }
  if (!Array.isArray(request.handlers) || request.handlers.length === 0) {
    return invalid("handlers", "handlers must be a non-empty array");
  }
  if (
    request.checkpointStore === null ||
    typeof request.checkpointStore !== "object" ||
    typeof request.checkpointStore.claim !== "function" ||
    typeof request.checkpointStore.commit !== "function" ||
    typeof request.checkpointStore.release !== "function"
  ) {
    return invalid(
      "checkpointStore",
      "checkpointStore must implement atomic claim, commit, and release"
    );
  }
  if (!isJsonRecord(request.initialState ?? {})) {
    return invalid("initialState", "initialState must be a JSON object");
  }
  for (const [path, value] of [
    ["cancelBeforeStep", request.cancelBeforeStep],
    ["maxStepsThisRun", request.maxStepsThisRun],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      return invalid(path, `${path} must be a positive integer`);
    }
  }
  const configError = validateConfigBindings(request.configBindings);
  if (configError !== undefined) return configError;
  for (const [index, handler] of request.handlers.entries()) {
    if (
      !/^primitive:\/\/[a-z][a-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
        handler.ref
      ) ||
      !/^sha256:[a-f0-9]{64}$/.test(handler.semanticHash) ||
      !/^[A-Za-z][A-Za-z0-9_.:/@-]{0,255}$/.test(handler.handlerId) ||
      !/^sha256:[a-f0-9]{64}$/.test(handler.handlerSha256) ||
      handler.mode !== "provider-free-local" ||
      handler.declaredEffects !== "none" ||
      handler.replay !== "safe" ||
      typeof handler.invoke !== "function"
    ) {
      return invalid(
        `handlers[${index}]`,
        "handler requires exact identities and provider-free, effect-free, replay-safe invocation"
      );
    }
  }
  return undefined;
}

function validateConfigBindings(
  bindings: unknown
): V2InactiveLocalHostError | undefined {
  if (bindings === undefined) return undefined;
  if (!isPlainRecord(bindings)) {
    return invalid(
      "configBindings",
      "configBindings must be an object mapping reference names to values"
    );
  }
  for (const [name, value] of Object.entries(bindings)) {
    const path = configBindingPath(name);
    if (findConfigLiteralSecret(name) !== undefined) {
      return invalid(path, "config reference name looks like a literal secret");
    }
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_CONFIG_BINDING_LENGTH
    ) {
      return invalid(
        path,
        `config binding must be a non-empty string of at most ${MAX_CONFIG_BINDING_LENGTH} characters`
      );
    }
    const secretClass = findConfigLiteralSecret(value);
    if (secretClass !== undefined) {
      return invalid(
        path,
        `config binding looks like a literal secret (${secretClass}); bind a model, provider, or environment name, not a credential`
      );
    }
  }
  return undefined;
}

function invalid(path: string, message: string): V2InactiveLocalHostError {
  return { code: "V2_LOCAL_HOST_REQUEST_INVALID", message, path };
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
