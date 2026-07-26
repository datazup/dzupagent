import type {
  V2InactiveLocalHostError,
  V2InactiveLocalHostRequest,
} from "./host-contracts.js";

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
