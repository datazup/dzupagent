import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  type DslV2FrontendMetadata,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import { evaluatePrimitivePolicyNarrowing } from "@dzupagent/flow-dsl/v2-policy-narrowing";

import { prepareFlowInputFromDsl } from "../authoring-input.js";
import { digest, stableStringify } from "./evidence.js";
import type { SimulationContext } from "./simulator-internal.js";
import type {
  V2InactiveLocalSimulationError,
  V2InactiveLocalSimulationRequest,
} from "./simulator-contracts.js";
import { qualifyV2InactiveLocalTarget } from "./qualification.js";

export type PrepareSimulationResult =
  | { readonly ok: true; readonly context: SimulationContext }
  | { readonly ok: false; readonly error: V2InactiveLocalSimulationError };

export async function prepareSimulationContext(
  input: V2InactiveLocalSimulationRequest
): Promise<PrepareSimulationResult> {
  const requestError = validateRequestShape(input);
  if (requestError !== undefined) return { ok: false, error: requestError };
  const request = snapshotRequest(input);

  const qualification = await qualifyV2InactiveLocalTarget(request);
  if (!qualification.ok) {
    return {
      ok: false,
      error: {
        code: "V2_SIMULATOR_QUALIFICATION_FAILED",
        message:
          "inactive local simulation requires a valid target qualification",
        path: "qualification",
        causes: qualification.errors.map(
          (error) => `${error.code}:${error.path ?? "root"}:${error.message}`
        ),
      },
    };
  }

  const prepared = prepareFlowInputFromDsl(request.source, {
    ...(request.compilerOptions.primitiveRegistry === undefined
      ? {}
      : { primitiveRegistry: request.compilerOptions.primitiveRegistry }),
    ...(request.compilerOptions.primitiveExpansionHandlers === undefined
      ? {}
      : {
          primitiveExpansionHandlers:
            request.compilerOptions.primitiveExpansionHandlers,
        }),
  });
  if (!prepared.ok || prepared.frontend === undefined) {
    return {
      ok: false,
      error: {
        code: "V2_SIMULATOR_QUALIFICATION_FAILED",
        message: "qualified V2 source could not be reprojected for simulation",
        path: "source",
      },
    };
  }

  const selected = selectSingleStep(
    prepared.frontend,
    qualification.receipt.conditionEvaluations.length
  );
  if (!selected.ok) return selected;
  const condition = qualification.receipt.conditionEvaluations[0];
  if (condition?.status !== "evaluated") {
    return {
      ok: false,
      error: {
        code: "V2_SIMULATOR_QUALIFICATION_FAILED",
        message: "inactive simulator requires eager typed-condition evidence",
        path: "qualification.conditionEvaluations",
      },
    };
  }
  const primitive = resolvePrimitive(request, selected.primitiveRef);
  if (primitive === undefined) {
    return {
      ok: false,
      error: {
        code: "V2_SIMULATOR_SINGLE_STEP_REQUIRED",
        message: `exact primitive ${selected.primitiveRef} is unavailable`,
        path: "compilerOptions.primitiveRegistry",
      },
    };
  }

  const policy = evaluatePrimitivePolicyNarrowing(
    primitive,
    selected.policy.narrowing,
    request.inheritedPolicy
  );
  if (!policy.ok) {
    return {
      ok: false,
      error: {
        code: "V2_SIMULATOR_REQUEST_INVALID",
        message:
          "simulator inherited policy is incompatible with the authored narrowing",
        path: "inheritedPolicy",
        causes: policy.errors.map(
          (error) => `${error.code}:${error.field ?? "root"}:${error.message}`
        ),
      },
    };
  }

  const planError = validateAttemptPlan(
    request,
    primitive,
    selected.retry.retry
  );
  if (planError !== undefined) return { ok: false, error: planError };
  const sourceSha256 = qualification.receipt.sourceSha256;
  const qualificationSha256 = qualification.receipt.qualificationSha256;
  const stateBefore = cloneRecord(request.initialState ?? {});
  const planSha256 = digest(
    stableStringify({
      sourceSha256,
      qualificationSha256,
      attempts: request.attempts,
      initialState: stateBefore,
      inheritedPolicy: request.inheritedPolicy ?? {},
      cancelBeforeAttempt: request.cancelBeforeAttempt ?? null,
      primitiveRef: primitive.ref,
      primitiveSemanticHash: primitive.compatibility.semanticHash,
    })
  );
  return {
    ok: true,
    context: {
      request,
      sourceSha256,
      qualificationSha256,
      planSha256,
      primitive,
      authoredPath: selected.authoredPath,
      condition,
      policy: policy.effectivePolicy,
      retry: selected.retry.retry,
      terminalCatch: selected.terminal.catch,
      save: selected.save.save,
      stateBefore,
    },
  };
}

function selectSingleStep(
  frontend: DslV2FrontendMetadata,
  conditionCount: number
):
  | {
      readonly ok: true;
      readonly authoredPath: string;
      readonly primitiveRef: PrimitiveDefinitionV2["ref"];
      readonly policy: DslV2FrontendMetadata["policyNarrowings"][number];
      readonly retry: DslV2FrontendMetadata["retryPolicies"][number];
      readonly terminal: DslV2FrontendMetadata["terminalCatches"][number];
      readonly save: DslV2FrontendMetadata["multiPortSaves"][number];
    }
  | { readonly ok: false; readonly error: V2InactiveLocalSimulationError } {
  const groups = [
    frontend.policyNarrowings,
    frontend.retryPolicies,
    frontend.terminalCatches,
    frontend.multiPortSaves,
  ];
  const paths = new Set(
    groups.flatMap((group) => group.map((item) => item.authoredPath))
  );
  const refs = new Set(
    groups.flatMap((group) => group.map((item) => item.primitiveRef))
  );
  const authoredPath = [...paths][0];
  if (
    conditionCount !== 1 ||
    frontend.stepLineage.length !== 1 ||
    groups.some((group) => group.length !== 1) ||
    paths.size !== 1 ||
    refs.size !== 1 ||
    authoredPath === undefined ||
    frontend.stepLineage[0]?.authoredPath !== authoredPath
  ) {
    return {
      ok: false,
      error: {
        code: "V2_SIMULATOR_SINGLE_STEP_REQUIRED",
        message:
          "inactive simulator requires one guarded primitive step owning exactly one policy, retry, terminal catch, and multi-port save contract",
        path: "root",
      },
    };
  }
  return {
    ok: true,
    authoredPath,
    primitiveRef: [...refs][0]!,
    policy: frontend.policyNarrowings[0]!,
    retry: frontend.retryPolicies[0]!,
    terminal: frontend.terminalCatches[0]!,
    save: frontend.multiPortSaves[0]!,
  };
}

function resolvePrimitive(
  request: V2InactiveLocalSimulationRequest,
  ref: PrimitiveDefinitionV2["ref"]
): PrimitiveDefinitionV2 | undefined {
  return (
    request.compilerOptions.primitiveRegistry?.get(ref) ??
    BUILT_IN_PRIMITIVE_REGISTRY_V2.get(ref)
  );
}

function validateRequestShape(
  request: V2InactiveLocalSimulationRequest
): V2InactiveLocalSimulationError | undefined {
  if (!Array.isArray(request.attempts) || request.attempts.length === 0) {
    return invalid("attempts", "attempts must be a non-empty scripted array");
  }
  if (!isJsonRecord(request.initialState ?? {})) {
    return requestInvalid("initialState", "initialState must be a JSON object");
  }
  if (!isJsonRecord(request.conditionBindings)) {
    return requestInvalid(
      "conditionBindings",
      "conditionBindings must be a deterministic JSON object"
    );
  }
  for (const [index, attempt] of request.attempts.entries()) {
    if (!isPlainRecord(attempt)) {
      return invalid(`attempts[${index}]`, "attempt must be a plain object");
    }
    const fields =
      attempt.status === "success"
        ? ["status", "outputs", "durationMs", "costCents"]
        : ["status", "code", "durationMs", "costCents"];
    if (Object.keys(attempt).some((field) => !fields.includes(field))) {
      return invalid(`attempts[${index}]`, "attempt contains an unknown field");
    }
    if (
      !isNonNegativeInteger(attempt.durationMs) ||
      !isNonNegativeInteger(attempt.costCents)
    ) {
      return invalid(
        `attempts[${index}]`,
        "attempt durationMs and costCents must be finite non-negative integers"
      );
    }
    if (attempt.status === "success") {
      if (!isJsonRecord(attempt.outputs)) {
        return invalid(
          `attempts[${index}].outputs`,
          "success outputs must be a deterministic JSON object"
        );
      }
    } else if (
      attempt.status !== "error" ||
      typeof attempt.code !== "string" ||
      attempt.code.length === 0
    ) {
      return invalid(
        `attempts[${index}]`,
        "error attempts require a non-empty exact code"
      );
    }
  }
  for (const [path, value] of [
    ["cancelBeforeAttempt", request.cancelBeforeAttempt],
    ["maxAttemptsThisRun", request.maxAttemptsThisRun],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      return requestInvalid(path, `${path} must be a positive integer`);
    }
  }
  if (
    (request.resumeFrom === undefined) !==
    (request.resumeSha256 === undefined)
  ) {
    return requestInvalid(
      "resumeFrom",
      "resumeFrom and resumeSha256 must be supplied together"
    );
  }
  return undefined;
}

function validateAttemptPlan(
  request: V2InactiveLocalSimulationRequest,
  primitive: PrimitiveDefinitionV2,
  retry: DslV2FrontendMetadata["retryPolicies"][number]["retry"]
): V2InactiveLocalSimulationError | undefined {
  if (request.attempts.length > retry.maxAttempts) {
    return invalid(
      "attempts",
      `scripted plan exceeds retry.maxAttempts=${retry.maxAttempts}`
    );
  }
  if (
    request.cancelBeforeAttempt !== undefined &&
    request.cancelBeforeAttempt > retry.maxAttempts
  ) {
    return requestInvalid(
      "cancelBeforeAttempt",
      `cancelBeforeAttempt exceeds retry.maxAttempts=${retry.maxAttempts}`
    );
  }
  const declared = new Set(primitive.errors.map((error) => error.code));
  for (const [index, attempt] of request.attempts.entries()) {
    const last = index === request.attempts.length - 1;
    if (attempt.status === "success") {
      if (!last) {
        return invalid(
          `attempts[${index + 1}]`,
          "scripted attempts after success are unreachable"
        );
      }
      continue;
    }
    if (!declared.has(attempt.code)) {
      return invalid(
        `attempts[${index}].code`,
        `primitive ${primitive.ref} does not declare error ${attempt.code}`
      );
    }
    const mayRetry =
      retry.match.includes(attempt.code) && index + 1 < retry.maxAttempts;
    if (!mayRetry && !last) {
      return invalid(
        `attempts[${index + 1}]`,
        "scripted attempts after a terminal outcome are unreachable"
      );
    }
    if (last && mayRetry && request.attempts.length < retry.maxAttempts) {
      return invalid(
        "attempts",
        "scripted plan ends before the declared retry sequence reaches a terminal outcome"
      );
    }
  }
  return undefined;
}

function snapshotRequest(
  request: V2InactiveLocalSimulationRequest
): V2InactiveLocalSimulationRequest {
  return {
    ...request,
    hostCapabilities: Object.freeze([...request.hostCapabilities]),
    conditionBindings: cloneRecord(request.conditionBindings),
    attempts: Object.freeze(
      request.attempts.map((attempt) =>
        attempt.status === "success"
          ? Object.freeze({ ...attempt, outputs: cloneRecord(attempt.outputs) })
          : Object.freeze({ ...attempt })
      )
    ),
    ...(request.initialState === undefined
      ? {}
      : { initialState: cloneRecord(request.initialState) }),
    ...(request.inheritedPolicy === undefined
      ? {}
      : { inheritedPolicy: Object.freeze({ ...request.inheritedPolicy }) }),
  };
}

function invalid(
  path: string,
  message: string
): V2InactiveLocalSimulationError {
  return { code: "V2_SIMULATOR_ATTEMPT_PLAN_INVALID", message, path };
}

function requestInvalid(
  path: string,
  message: string
): V2InactiveLocalSimulationError {
  return { code: "V2_SIMULATOR_REQUEST_INVALID", message, path };
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
