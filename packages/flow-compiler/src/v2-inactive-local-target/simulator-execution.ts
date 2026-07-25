import type { PrimitiveMultiPortSaveContract } from "@dzupagent/flow-dsl/v2-multi-port-save";
import type { PrimitiveTerminalCatchAction } from "@dzupagent/flow-dsl/v2-terminal-catch";

import { digest, stableStringify } from "./evidence.js";
import type {
  MutableSimulationProgress,
  SimulationContext,
} from "./simulator-internal.js";
import {
  completeSimulation,
  simulationFailure,
  suspendSimulation,
} from "./simulator-receipts.js";
import { validateSimulationValue } from "./schema-validation.js";
import type {
  V2InactiveLocalAttemptReceipt,
  V2InactiveLocalSimulationRequest,
  V2InactiveLocalSimulationResult,
} from "./simulator-contracts.js";

export function executeSimulation(
  context: SimulationContext,
  progress: MutableSimulationProgress
): V2InactiveLocalSimulationResult {
  if (!context.condition.value) {
    return completeSimulation(context, progress, "skipped");
  }
  if (context.request.cancelBeforeAttempt === progress.nextAttempt) {
    return completeSimulation(context, progress, "cancelled", {
      code: "V2_SIMULATION_CANCELLED",
    });
  }
  if (context.policy.requireApproval === true) {
    return completeSimulation(context, progress, "approval-required", {
      code: "V2_SIMULATION_APPROVAL_REQUIRED",
    });
  }
  return runAttempts(context, progress);
}

function runAttempts(
  context: SimulationContext,
  progress: MutableSimulationProgress
): V2InactiveLocalSimulationResult {
  let processedThisRun = 0;
  while (progress.nextAttempt <= context.retry.maxAttempts) {
    const attemptNumber = progress.nextAttempt;
    if (context.request.cancelBeforeAttempt === attemptNumber) {
      return completeSimulation(context, progress, "cancelled", {
        code: "V2_SIMULATION_CANCELLED",
      });
    }
    if (
      processedThisRun > 0 &&
      processedThisRun === context.request.maxAttemptsThisRun
    ) {
      return suspendSimulation(context, progress);
    }
    const scripted = context.request.attempts[attemptNumber - 1];
    if (scripted === undefined) {
      return completeSimulation(context, progress, "failed", {
        code: "V2_SIMULATION_ATTEMPT_PLAN_EXHAUSTED",
      });
    }

    const nextDuration = progress.cumulativeDurationMs + scripted.durationMs;
    const nextCost = progress.cumulativeCostCents + scripted.costCents;
    if (
      context.policy.timeoutMs !== undefined &&
      nextDuration > context.policy.timeoutMs
    ) {
      return completeSimulation(context, progress, "failed", {
        code: "V2_SIMULATION_TIMEOUT_EXCEEDED",
      });
    }
    if (
      context.policy.budgetCents !== undefined &&
      nextCost > context.policy.budgetCents
    ) {
      return completeSimulation(context, progress, "failed", {
        code: "V2_SIMULATION_BUDGET_EXCEEDED",
      });
    }

    progress.cumulativeDurationMs = nextDuration;
    progress.cumulativeCostCents = nextCost;
    processedThisRun += 1;
    if (scripted.status === "success") {
      const outputErrors = validateOutputs(
        scripted.outputs,
        context.primitive.outputPorts,
        context.save
      );
      if (outputErrors.length > 0) {
        return simulationFailure({
          code: "V2_SIMULATOR_OUTPUT_INVALID",
          message:
            "scripted successful output violates the exact multi-port save contract",
          path: `attempts[${attemptNumber - 1}].outputs`,
          causes: outputErrors,
        });
      }
      progress.attempts.push(
        attemptReceipt(progress, scripted, "success", {
          outputSha256: digest(stableStringify(scripted.outputs)),
        })
      );
      applySaveTransaction(progress.state, scripted.outputs, context.save);
      progress.nextAttempt += 1;
      return completeSimulation(context, progress, "completed");
    }

    const retryable = context.retry.match.includes(scripted.code);
    const mayRetry = retryable && attemptNumber < context.retry.maxAttempts;
    const backoff = mayRetry ? retryBackoff(context, attemptNumber) : undefined;
    if (
      backoff !== undefined &&
      context.policy.timeoutMs !== undefined &&
      progress.cumulativeDurationMs + backoff > context.policy.timeoutMs
    ) {
      progress.attempts.push(
        attemptReceipt(progress, scripted, "retryable-error", {
          errorCode: scripted.code,
        })
      );
      progress.nextAttempt += 1;
      return completeSimulation(context, progress, "failed", {
        code: "V2_SIMULATION_TIMEOUT_EXCEEDED",
      });
    }
    if (backoff !== undefined) progress.cumulativeDurationMs += backoff;
    progress.attempts.push(
      attemptReceipt(
        progress,
        scripted,
        retryable ? "retryable-error" : "terminal-error",
        {
          errorCode: scripted.code,
          ...(backoff === undefined ? {} : { scheduledBackoffMs: backoff }),
        }
      )
    );
    progress.nextAttempt += 1;
    if (mayRetry) continue;

    const catchAction = findCatchAction(context, scripted.code);
    if (catchAction !== undefined) {
      return caught(context, progress, scripted.code, catchAction);
    }
    return completeSimulation(context, progress, "failed", {
      code: scripted.code,
    });
  }
  return completeSimulation(context, progress, "failed", {
    code: "V2_SIMULATION_RETRY_ATTEMPTS_EXHAUSTED",
  });
}

function validateOutputs(
  outputs: Readonly<Record<string, unknown>>,
  outputPorts: SimulationContext["primitive"]["outputPorts"],
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
    if (binding.source.cardinality === "many") {
      if (!Array.isArray(value)) {
        errors.push(
          `outputs.${binding.port}: many cardinality requires an array`
        );
        continue;
      }
      value.forEach((item, index) => {
        errors.push(
          ...validateSimulationValue(
            item,
            binding.source.schema,
            `outputs.${binding.port}[${index}]`
          )
        );
      });
    } else {
      errors.push(
        ...validateSimulationValue(
          value,
          binding.source.schema,
          `outputs.${binding.port}`
        )
      );
    }
  }
  return Object.freeze(errors);
}

function applySaveTransaction(
  state: Record<string, unknown>,
  outputs: Readonly<Record<string, unknown>>,
  save: PrimitiveMultiPortSaveContract
): void {
  const writes = save.bindings
    .filter((binding) => outputs[binding.port] !== undefined)
    .map(
      (binding) => [binding.destination.key, outputs[binding.port]] as const
    );
  for (const [key, value] of writes) state[key] = structuredClone(value);
}

function attemptReceipt(
  progress: MutableSimulationProgress,
  scripted: V2InactiveLocalSimulationRequest["attempts"][number],
  status: V2InactiveLocalAttemptReceipt["status"],
  details: Pick<
    V2InactiveLocalAttemptReceipt,
    "errorCode" | "outputSha256" | "scheduledBackoffMs"
  >
): V2InactiveLocalAttemptReceipt {
  return Object.freeze({
    attempt: progress.nextAttempt,
    attemptIdentity: "same-invocation" as const,
    status,
    durationMs: scripted.durationMs,
    costCents: scripted.costCents,
    cumulativeDurationMs: progress.cumulativeDurationMs,
    cumulativeCostCents: progress.cumulativeCostCents,
    ...details,
    rawProviderContent: "excluded" as const,
  });
}

function retryBackoff(
  context: SimulationContext,
  attemptNumber: number
): number {
  const backoff = context.retry.backoff;
  if (backoff === undefined) return 0;
  const uncapped =
    backoff.strategy === "fixed"
      ? backoff.initialMs
      : backoff.initialMs * 2 ** (attemptNumber - 1);
  const maximum = Math.min(uncapped, backoff.maxMs);
  if (backoff.jitter === "none") return maximum;
  const entropy = digest(
    `${context.qualificationSha256}:${context.planSha256}:${attemptNumber}`
  ).slice(7, 15);
  return Number.parseInt(entropy, 16) % (maximum + 1);
}

function findCatchAction(
  context: SimulationContext,
  code: string
): PrimitiveTerminalCatchAction | undefined {
  return context.terminalCatch.clauses.find((clause) =>
    clause.matches.some((match) => match.errorCode === code)
  )?.outcome;
}

function caught(
  context: SimulationContext,
  progress: MutableSimulationProgress,
  code: string,
  action: PrimitiveTerminalCatchAction
): V2InactiveLocalSimulationResult {
  if (action.action === "continue") {
    return completeSimulation(context, progress, "caught-continue", {
      code,
      catchAction: action.action,
    });
  }
  if (action.action === "complete") {
    return completeSimulation(context, progress, "caught-complete", {
      code,
      catchAction: action.action,
    });
  }
  if (action.action === "fail") {
    return completeSimulation(context, progress, "failed", {
      code: action.code,
      catchAction: action.action,
    });
  }
  return completeSimulation(context, progress, "failed", {
    code: "V2_SIMULATION_CATCH_ACTION_INVALID",
  });
}
