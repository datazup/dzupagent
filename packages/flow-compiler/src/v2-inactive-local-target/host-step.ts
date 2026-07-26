import type { PrimitiveMultiPortSaveContract } from "@dzupagent/flow-dsl/v2-multi-port-save";

import { deepFreeze, digest, stableStringify } from "./evidence.js";
import type {
  V2InactiveLocalHostAttemptReceipt,
  V2InactiveLocalHostError,
  V2InactiveLocalHandlerResult,
  V2InactiveLocalHostStepReceipt,
  V2InactiveLocalHostStepStatus,
} from "./host-contracts.js";
import type { V2InactiveLocalHostPrimitiveStepPlan } from "./host-plan.js";
import { validateSimulationValue } from "./schema-validation.js";

export interface ExecuteV2InactiveLocalHostStepInput {
  readonly runId: string;
  readonly step: V2InactiveLocalHostPrimitiveStepPlan;
  readonly state: Readonly<Record<string, unknown>>;
  readonly resolvedInput: Readonly<Record<string, unknown>>;
  readonly condition: {
    readonly value: boolean;
    readonly resolvedReferences: readonly string[];
  };
}

export type ExecuteV2InactiveLocalHostStepResult =
  | {
      readonly ok: true;
      readonly receipt: V2InactiveLocalHostStepReceipt;
      readonly state: Readonly<Record<string, unknown>>;
      readonly outputs?: Readonly<Record<string, unknown>>;
      readonly terminal: boolean;
    }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError };

export async function executeV2InactiveLocalHostStep(
  input: ExecuteV2InactiveLocalHostStepInput
): Promise<ExecuteV2InactiveLocalHostStepResult> {
  const { step } = input;
  if (!input.condition.value) {
    return stepResult(input, "skipped", [], input.state, false);
  }
  if (step.policy.requireApproval === true) {
    return stepResult(input, "approval-required", [], input.state, true, {
      code: "V2_LOCAL_HOST_APPROVAL_REQUIRED",
    });
  }

  const attempts: V2InactiveLocalHostAttemptReceipt[] = [];
  let cumulativeDurationMs = 0;
  let cumulativeCostCents = 0;
  for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
    let outcome: unknown;
    try {
      outcome = await step.handler.invoke(
        deepFreeze({
          runId: input.runId,
          stepIndex: step.index,
          stepId: step.id,
          authoredPath: step.authoredPath,
          attempt,
          handlerId: step.handler.handlerId,
          handlerSha256: step.handler.handlerSha256,
          input: cloneRecord(input.resolvedInput),
          state: cloneRecord(input.state),
          authority: {
            providerDispatch: false as const,
            externalStateMutation: false as const,
            deployment: false as const,
            activation: false as const,
          },
        })
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "V2_LOCAL_HOST_HANDLER_RESULT_INVALID",
          message: "local handler threw instead of returning a bounded result",
          path: `${step.authoredPath}.handler`,
          causes: [error instanceof Error ? error.message : String(error)],
        },
      };
    }
    const resultError = validateHandlerResult(outcome, step.authoredPath);
    if (resultError !== undefined) return { ok: false, error: resultError };
    const handlerResult = outcome as V2InactiveLocalHandlerResult;

    const nextDuration = cumulativeDurationMs + handlerResult.durationMs;
    const nextCost = cumulativeCostCents + handlerResult.costCents;
    if (
      step.policy.timeoutMs !== undefined &&
      nextDuration > step.policy.timeoutMs
    ) {
      return stepResult(input, "failed", attempts, input.state, true, {
        code: "V2_LOCAL_HOST_TIMEOUT_EXCEEDED",
      });
    }
    if (
      step.policy.budgetCents !== undefined &&
      nextCost > step.policy.budgetCents
    ) {
      return stepResult(input, "failed", attempts, input.state, true, {
        code: "V2_LOCAL_HOST_BUDGET_EXCEEDED",
      });
    }
    cumulativeDurationMs = nextDuration;
    cumulativeCostCents = nextCost;

    if (handlerResult.status === "success") {
      const outputErrors = validateOutputs(
        handlerResult.outputs,
        step.primitive.outputPorts,
        step.save
      );
      if (outputErrors.length > 0) {
        return {
          ok: false,
          error: {
            code: "V2_LOCAL_HOST_OUTPUT_INVALID",
            message:
              "local handler output violates the exact atomic save contract",
            path: `${step.authoredPath}.handler.outputs`,
            causes: outputErrors,
          },
        };
      }
      attempts.push(
        deepFreeze({
          attempt,
          status: "success" as const,
          durationMs: handlerResult.durationMs,
          costCents: handlerResult.costCents,
          cumulativeDurationMs,
          cumulativeCostCents,
          outputSha256: digest(stableStringify(handlerResult.outputs)),
          rawProviderContent: "excluded" as const,
        })
      );
      const state = applySaveTransaction(
        input.state,
        handlerResult.outputs,
        step.save
      );
      return stepResult(
        input,
        "completed",
        attempts,
        state,
        false,
        undefined,
        handlerResult.outputs
      );
    }

    if (
      !step.primitive.errors.some((item) => item.code === handlerResult.code)
    ) {
      return {
        ok: false,
        error: {
          code: "V2_LOCAL_HOST_HANDLER_RESULT_INVALID",
          message: `handler returned undeclared primitive error ${handlerResult.code}`,
          path: `${step.authoredPath}.handler.code`,
        },
      };
    }
    const retryable = step.retry.match.includes(handlerResult.code);
    const mayRetry = retryable && attempt < step.retry.maxAttempts;
    const backoff = mayRetry ? retryBackoff(step, attempt) : undefined;
    if (
      backoff !== undefined &&
      step.policy.timeoutMs !== undefined &&
      cumulativeDurationMs + backoff > step.policy.timeoutMs
    ) {
      attempts.push(
        errorAttempt(
          attempt,
          handlerResult,
          "retryable-error",
          cumulativeDurationMs,
          cumulativeCostCents
        )
      );
      return stepResult(input, "failed", attempts, input.state, true, {
        code: "V2_LOCAL_HOST_TIMEOUT_EXCEEDED",
      });
    }
    if (backoff !== undefined) cumulativeDurationMs += backoff;
    attempts.push(
      errorAttempt(
        attempt,
        handlerResult,
        retryable ? "retryable-error" : "terminal-error",
        cumulativeDurationMs,
        cumulativeCostCents,
        backoff
      )
    );
    if (mayRetry) continue;

    const caught = step.terminalCatch.clauses.find((clause) =>
      clause.matches.some((match) => match.errorCode === handlerResult.code)
    )?.outcome;
    if (caught?.action === "continue") {
      return stepResult(
        input,
        "caught-continue",
        attempts,
        input.state,
        false,
        { code: handlerResult.code, catchAction: caught.action }
      );
    }
    if (caught?.action === "complete") {
      return stepResult(input, "caught-complete", attempts, input.state, true, {
        code: handlerResult.code,
        catchAction: caught.action,
      });
    }
    return stepResult(input, "failed", attempts, input.state, true, {
      code: caught?.action === "fail" ? caught.code : handlerResult.code,
      ...(caught?.action === "fail" ? { catchAction: caught.action } : {}),
    });
  }
  return stepResult(input, "failed", attempts, input.state, true, {
    code: "V2_LOCAL_HOST_RETRY_ATTEMPTS_EXHAUSTED",
  });
}

function stepResult(
  input: ExecuteV2InactiveLocalHostStepInput,
  status: V2InactiveLocalHostStepStatus,
  attempts: readonly V2InactiveLocalHostAttemptReceipt[],
  state: Readonly<Record<string, unknown>>,
  terminal: boolean,
  terminalResult?: {
    readonly code: string;
    readonly catchAction?: "continue" | "complete" | "fail";
  },
  outputs?: Readonly<Record<string, unknown>>
): ExecuteV2InactiveLocalHostStepResult {
  const stateSnapshot = deepFreeze(cloneRecord(state));
  const core = {
    index: input.step.index,
    id: input.step.id,
    authoredPath: input.step.authoredPath,
    kind: "primitive" as const,
    use: input.step.use,
    primitiveRef: input.step.primitive.ref,
    primitiveSemanticHash: input.step.primitive.compatibility.semanticHash,
    handler: deepFreeze({
      id: input.step.handler.handlerId,
      sha256: input.step.handler.handlerSha256,
      mode: input.step.handler.mode,
      declaredEffects: input.step.handler.declaredEffects,
      replay: input.step.handler.replay,
    }),
    status,
    condition: deepFreeze({ ...input.condition }),
    effectivePolicy: deepFreeze({ ...input.step.policy }),
    attempts: deepFreeze(attempts.map((attempt) => ({ ...attempt }))),
    stateBeforeSha256: digest(stableStringify(input.state)),
    stateAfterSha256: digest(stableStringify(stateSnapshot)),
    resolvedInputSha256: digest(stableStringify(input.resolvedInput)),
    ...(outputs === undefined
      ? {}
      : { outputSha256: digest(stableStringify(outputs)) }),
    ...(terminalResult === undefined
      ? {}
      : { terminal: deepFreeze({ ...terminalResult }) }),
  };
  return {
    ok: true,
    receipt: deepFreeze({
      ...core,
      stepSha256: digest(stableStringify(core)),
    }),
    state: stateSnapshot,
    ...(outputs === undefined
      ? {}
      : { outputs: deepFreeze(cloneRecord(outputs)) }),
    terminal,
  };
}

function validateHandlerResult(
  value: unknown,
  path: string
): V2InactiveLocalHostError | undefined {
  if (!isPlainRecord(value)) {
    return invalidResult(path, "handler result must be a plain object");
  }
  const status = value.status;
  const allowed =
    status === "success"
      ? ["status", "outputs", "durationMs", "costCents"]
      : ["status", "code", "durationMs", "costCents"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return invalidResult(path, "handler result contains an unknown field");
  }
  if (
    !isNonNegativeInteger(value.durationMs) ||
    !isNonNegativeInteger(value.costCents)
  ) {
    return invalidResult(
      path,
      "handler durationMs and costCents must be finite non-negative integers"
    );
  }
  if (status === "success" && isJsonRecord(value.outputs)) return undefined;
  if (
    status === "error" &&
    typeof value.code === "string" &&
    value.code.length > 0
  ) {
    return undefined;
  }
  return invalidResult(
    path,
    "handler must return success JSON outputs or an exact non-empty error code"
  );
}

function validateOutputs(
  outputs: Readonly<Record<string, unknown>>,
  outputPorts: V2InactiveLocalHostPrimitiveStepPlan["primitive"]["outputPorts"],
  save: PrimitiveMultiPortSaveContract
): readonly string[] {
  const errors: string[] = [];
  for (const port of Object.keys(outputs)) {
    if (outputPorts[port] === undefined) {
      errors.push(`outputs.${port}: primitive does not declare this port`);
    }
  }
  for (const binding of save.bindings) {
    const value = outputs[binding.port];
    if (value === undefined) {
      if (binding.source.cardinality !== "optional") {
        errors.push(`outputs.${binding.port}: required saved port is missing`);
      }
      continue;
    }
    const values = binding.source.cardinality === "many" ? value : [value];
    if (!Array.isArray(values)) {
      errors.push(
        `outputs.${binding.port}: many cardinality requires an array`
      );
      continue;
    }
    values.forEach((item, index) => {
      errors.push(
        ...validateSimulationValue(
          item,
          binding.source.schema,
          binding.source.cardinality === "many"
            ? `outputs.${binding.port}[${index}]`
            : `outputs.${binding.port}`
        )
      );
    });
  }
  return deepFreeze(errors);
}

function applySaveTransaction(
  state: Readonly<Record<string, unknown>>,
  outputs: Readonly<Record<string, unknown>>,
  save: PrimitiveMultiPortSaveContract
): Readonly<Record<string, unknown>> {
  const next = cloneRecord(state);
  for (const binding of save.bindings) {
    if (outputs[binding.port] !== undefined) {
      next[binding.destination.key] = structuredClone(outputs[binding.port]);
    }
  }
  return deepFreeze(next);
}

function retryBackoff(
  step: V2InactiveLocalHostPrimitiveStepPlan,
  attempt: number
): number {
  const backoff = step.retry.backoff;
  if (backoff === undefined) return 0;
  const uncapped =
    backoff.strategy === "fixed"
      ? backoff.initialMs
      : backoff.initialMs * 2 ** (attempt - 1);
  const maximum = Math.min(uncapped, backoff.maxMs);
  if (backoff.jitter === "none") return maximum;
  const entropy = digest(
    `${step.primitive.compatibility.semanticHash}:${step.authoredPath}:${attempt}`
  ).slice(7, 15);
  return Number.parseInt(entropy, 16) % (maximum + 1);
}

function errorAttempt(
  attempt: number,
  outcome: {
    readonly durationMs: number;
    readonly costCents: number;
    readonly code: string;
  },
  status: "retryable-error" | "terminal-error",
  cumulativeDurationMs: number,
  cumulativeCostCents: number,
  scheduledBackoffMs?: number
): V2InactiveLocalHostAttemptReceipt {
  return deepFreeze({
    attempt,
    status,
    durationMs: outcome.durationMs,
    costCents: outcome.costCents,
    cumulativeDurationMs,
    cumulativeCostCents,
    errorCode: outcome.code,
    ...(scheduledBackoffMs === undefined ? {} : { scheduledBackoffMs }),
    rawProviderContent: "excluded" as const,
  });
}

function invalidResult(
  path: string,
  message: string
): V2InactiveLocalHostError {
  return {
    code: "V2_LOCAL_HOST_HANDLER_RESULT_INVALID",
    message,
    path: `${path}.handler`,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
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
