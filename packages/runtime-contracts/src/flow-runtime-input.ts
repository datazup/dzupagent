import { CANONICAL_JSON_VERSION, canonicalJson } from "./idempotency.js";

import {
  CLASSIFICATIONS,
  INPUT_TYPES,
  cloneJson,
  describeType,
  digest,
  handlePath,
  inputPath,
  invalidKeyIssue,
  issue,
  matchesType,
  nullRecord,
  plainRecord,
  utf8Bytes,
  validTopLevelKey,
} from "./flow-runtime-input-values.js";
import {
  validateCredentialHandle,
  validateJsonValue,
} from "./flow-runtime-input-validate.js";
import {
  DEFAULT_FLOW_RUNTIME_INPUT_LIMITS,
  FLOW_RUNTIME_INPUT_CONTRACT,
} from "./flow-runtime-input-contracts.js";
import type {
  FlowRuntimeCredentialHandleRef,
  FlowRuntimeInputClassification,
  FlowRuntimeInputIssue,
  FlowRuntimeInputLimits,
  FlowRuntimeInputSpec,
  FlowRuntimeInputType,
  FlowRuntimeInputValidationRequest,
  FlowRuntimeInputValidationResult,
  FlowRuntimeJsonValue,
} from "./flow-runtime-input-contracts.js";

// PUBLIC API, not a convenience: src/index.ts imports every public flow runtime
// input name from THIS path, so each symbol moved out stays re-exported here.
export * from "./flow-runtime-input-contracts.js";
export { sha256Text } from "./flow-runtime-input-values.js";

export function validateFlowRuntimeInput(
  request: FlowRuntimeInputValidationRequest,
): FlowRuntimeInputValidationResult {
  const limits = resolveLimits(request.limits);
  const issues: FlowRuntimeInputIssue[] = [];
  const contract = request.inputContract ?? {};
  const suppliedInput = request.input === undefined ? {} : request.input;
  const suppliedHandles =
    request.credentialHandleRefs === undefined
      ? {}
      : request.credentialHandleRefs;
  const rawInput = plainRecord(suppliedInput)
    ? suppliedInput
    : undefined;
  const rawHandles = plainRecord(suppliedHandles)
    ? suppliedHandles
    : undefined;

  if (rawInput === undefined) {
    issues.push(issue("FLOW_INPUT_NOT_OBJECT", "$.inputs", "Run input must be an object."));
  }
  if (rawHandles === undefined) {
    issues.push(
      issue(
        "FLOW_INPUT_CREDENTIAL_HANDLE_INVALID",
        "$.credentialHandleRefs",
        "Credential handle references must be an object.",
      ),
    );
  }

  const inputRecord = (rawInput ?? {}) as Record<string, unknown>;
  const handleRecord = (rawHandles ?? {}) as Record<string, unknown>;
  const normalizedInputs = nullRecord<FlowRuntimeJsonValue>();
  const normalizedHandles = nullRecord<FlowRuntimeCredentialHandleRef>();
  const classifications = nullRecord<FlowRuntimeInputClassification>();
  const valueCounter = { total: 0 };

  for (const key of Object.keys(inputRecord).sort()) {
    if (!validTopLevelKey(key)) {
      issues.push(invalidKeyIssue(inputPath(key), key));
      continue;
    }
    const spec = Object.hasOwn(contract, key) ? contract[key] : undefined;
    if (spec === undefined) {
      issues.push(
        issue(
          "FLOW_INPUT_UNKNOWN_KEY",
          inputPath(key),
          `Input key '${key}' is not declared by the flow.`,
        ),
      );
    } else if (spec.type === "credential") {
      issues.push(
        issue(
          "FLOW_INPUT_CREDENTIAL_INLINE_DENIED",
          inputPath(key),
          `Credential input '${key}' must be supplied as a separate opaque handle reference.`,
        ),
      );
    }
  }

  for (const key of Object.keys(handleRecord).sort()) {
    if (!validTopLevelKey(key)) {
      issues.push(invalidKeyIssue(handlePath(key), key));
      continue;
    }
    if (!Object.hasOwn(contract, key) || contract[key]?.type !== "credential") {
      issues.push(
        issue(
          "FLOW_INPUT_CREDENTIAL_HANDLE_UNKNOWN",
          handlePath(key),
          `Credential handle '${key}' does not match a declared credential input.`,
        ),
      );
    }
  }

  for (const key of Object.keys(contract).sort()) {
    if (!validTopLevelKey(key)) {
      issues.push(invalidKeyIssue(`$.contract.${key}`, key));
      continue;
    }
    const spec = contract[key];
    if (!validSpec(spec)) {
      issues.push(
        issue(
          "FLOW_INPUT_CONTRACT_INVALID",
          `$.contract.${key}`,
          `Input declaration '${key}' is not a valid runtime input contract.`,
        ),
      );
      continue;
    }

    const classification =
      spec.type === "credential"
        ? "secret"
        : (spec.classification ?? "internal");
    classifications[key] = classification;

    if (spec.type === "credential") {
      const rawHandle = handleRecord[key];
      if (rawHandle === undefined) {
        if (spec.required === true) {
          issues.push(
            issue(
              "FLOW_INPUT_CREDENTIAL_HANDLE_REQUIRED",
              handlePath(key),
              `Required credential input '${key}' has no opaque handle reference.`,
            ),
          );
        }
        continue;
      }
      const handle = validateCredentialHandle(rawHandle, handlePath(key), issues);
      if (handle !== undefined) normalizedHandles[key] = handle;
      continue;
    }

    let value = inputRecord[key];
    if (value === undefined && spec.default !== undefined) {
      value = spec.default;
    }
    if (value === undefined) {
      if (spec.required === true) {
        issues.push(
          issue(
            "FLOW_INPUT_REQUIRED",
            inputPath(key),
            `Required input '${key}' is missing.`,
          ),
        );
      }
      continue;
    }
    if (!matchesType(value, spec.type)) {
      issues.push(
        issue(
          "FLOW_INPUT_TYPE_MISMATCH",
          inputPath(key),
          `Input '${key}' must be ${spec.type}; received ${describeType(value)}.`,
        ),
      );
      continue;
    }
    if (
      validateJsonValue(
        value,
        inputPath(key),
        limits,
        issues,
        valueCounter,
      )
    ) {
      normalizedInputs[key] = cloneJson(value as FlowRuntimeJsonValue);
    }
  }

  if (issues.length > 0) return { valid: false, issues };

  const canonicalPayloadJson = canonicalJson({
    contract: FLOW_RUNTIME_INPUT_CONTRACT,
    canonicalization: CANONICAL_JSON_VERSION,
    inputs: normalizedInputs,
    credentialHandleRefs: normalizedHandles,
  });
  const canonicalBytes = utf8Bytes(canonicalPayloadJson);
  if (canonicalBytes > limits.maxCanonicalBytes) {
    return {
      valid: false,
      issues: [
        issue(
          "FLOW_INPUT_MAX_CANONICAL_BYTES",
          "$",
          `Canonical run input is ${canonicalBytes} bytes; the limit is ${limits.maxCanonicalBytes}.`,
        ),
      ],
    };
  }

  const credentialHandleDigests = Object.fromEntries(
    Object.entries(normalizedHandles).map(([key, handle]) => [
      key,
      digest(handle),
    ]),
  );

  return {
    valid: true,
    issues: [],
    value: {
      contract: FLOW_RUNTIME_INPUT_CONTRACT,
      canonicalization: CANONICAL_JSON_VERSION,
      inputs: normalizedInputs,
      credentialHandleRefs: normalizedHandles,
      classifications,
      canonicalPayloadJson,
      canonicalBytes,
      payloadDigest: digest(JSON.parse(canonicalPayloadJson)),
      classificationMapDigest: digest(classifications),
      credentialHandleDigests,
      runtimeState: {
        inputs: Object.assign(
          nullRecord<FlowRuntimeJsonValue | FlowRuntimeCredentialHandleRef>(),
          normalizedInputs,
          normalizedHandles,
        ),
      },
    },
  };
}

function resolveLimits(
  overrides: Partial<FlowRuntimeInputLimits> | undefined,
): FlowRuntimeInputLimits {
  const resolved = { ...DEFAULT_FLOW_RUNTIME_INPUT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${key} must be a positive safe integer.`);
    }
  }
  return resolved;
}

function validSpec(value: unknown): value is FlowRuntimeInputSpec {
  if (!plainRecord(value) || !INPUT_TYPES.has(value.type as FlowRuntimeInputType)) {
    return false;
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    return false;
  }
  if (
    value.classification !== undefined &&
    !CLASSIFICATIONS.has(value.classification as FlowRuntimeInputClassification)
  ) {
    return false;
  }
  if (value.type === "credential") {
    return value.default === undefined &&
      (value.classification === undefined || value.classification === "secret");
  }
  return value.default === undefined || matchesType(value.default, value.type as FlowRuntimeInputType);
}

