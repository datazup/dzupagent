import { evaluateFlowTypedCondition } from "@dzupagent/flow-ast/typed-condition-evaluator";

import { deepFreeze, digest, stableStringify } from "./evidence.js";
import type {
  V2InactiveLocalHostError,
  V2InactiveLocalHostStepReceipt,
  V2InactiveLocalHostStepStatus,
} from "./host-contracts.js";
import type {
  V2InactiveLocalHostContext,
  V2InactiveLocalHostStepPlan,
} from "./host-plan.js";
import { resolveV2LocalHostValue } from "./host-resolution.js";
import { executeV2InactiveLocalHostStep } from "./host-step.js";

export interface V2InactiveLocalKernelProgress {
  readonly state: Readonly<Record<string, unknown>>;
  readonly stepOutputs: Readonly<Record<string, unknown>>;
  readonly branchDecisions: Readonly<Record<string, boolean>>;
}

export type ExecuteV2InactiveLocalKernelStepResult =
  | {
      readonly ok: true;
      readonly receipt: V2InactiveLocalHostStepReceipt;
      readonly state: Readonly<Record<string, unknown>>;
      readonly stepOutputs: Readonly<Record<string, unknown>>;
      readonly branchDecisions: Readonly<Record<string, boolean>>;
      readonly completionResult?: unknown;
      readonly terminal: boolean;
    }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError };

export async function executeV2InactiveLocalKernelStep(
  context: V2InactiveLocalHostContext,
  step: V2InactiveLocalHostStepPlan,
  progress: V2InactiveLocalKernelProgress
): Promise<ExecuteV2InactiveLocalKernelStepResult> {
  const branchActive = step.branchRequirements.every(
    (required) => progress.branchDecisions[required.id] === required.outcome
  );
  if (!branchActive) {
    return kernelResult(step, progress, "skipped-branch", {
      value: false,
      resolvedReferences: [],
    });
  }
  const condition = evaluateCondition(context, step, progress);
  if (!condition.ok) return condition;
  if (step.kind === "branch") {
    const decisions = {
      ...progress.branchDecisions,
      [step.id]: condition.condition.value,
    };
    return kernelResult(
      step,
      { ...progress, branchDecisions: decisions },
      condition.condition.value ? "branch-then" : "branch-else",
      condition.condition,
      { branchDecision: condition.condition.value }
    );
  }
  if (!condition.condition.value) {
    return kernelResult(step, progress, "skipped", condition.condition);
  }
  const bindings = runtimeBindings(context, progress);
  if (step.kind === "set") {
    const resolved = resolveV2LocalHostValue(
      step.assign,
      bindings,
      `${step.authoredPath}.with.assign`
    );
    if (!resolved.ok) return resolved;
    const state = deepFreeze({
      ...cloneRecord(progress.state),
      ...cloneRecord(resolved.value),
    });
    return kernelResult(
      step,
      { ...progress, state },
      "set-applied",
      mergeConditionReferences(condition.condition, resolved.resolvedReferences),
      { stateBefore: progress.state, resolvedInput: resolved.value }
    );
  }
  if (step.kind === "complete") {
    const resolved = resolveV2LocalHostValue(
      step.result,
      bindings,
      `${step.authoredPath}.with.result`
    );
    if (!resolved.ok) return resolved;
    return kernelResult(
      step,
      progress,
      "complete",
      mergeConditionReferences(condition.condition, resolved.resolvedReferences),
      {
        completionResult: resolved.value,
        resolvedInput: resolved.value,
        terminal: true,
      }
    );
  }
  const resolved = resolveV2LocalHostValue(
    step.input,
    bindings,
    `${step.authoredPath}.with`
  );
  if (!resolved.ok) return resolved;
  const primitive = await executeV2InactiveLocalHostStep({
    runId: context.request.runId,
    step,
    state: progress.state,
    resolvedInput: resolved.value,
    condition: mergeConditionReferences(
      condition.condition,
      resolved.resolvedReferences
    ),
  });
  if (!primitive.ok) return primitive;
  const stepOutputs = primitive.outputs === undefined
    ? progress.stepOutputs
    : deepFreeze({
        ...cloneRecord(progress.stepOutputs),
        [step.id]: cloneRecord(primitive.outputs),
      });
  return {
    ...primitive,
    stepOutputs,
    branchDecisions: progress.branchDecisions,
  };
}

function evaluateCondition(
  context: V2InactiveLocalHostContext,
  step: V2InactiveLocalHostStepPlan,
  progress: V2InactiveLocalKernelProgress
):
  | {
      readonly ok: true;
      readonly condition: {
        readonly value: boolean;
        readonly resolvedReferences: readonly string[];
      };
    }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError } {
  if (step.condition === undefined) {
    return {
      ok: true,
      condition: { value: true, resolvedReferences: Object.freeze([]) },
    };
  }
  const evaluation = evaluateFlowTypedCondition(step.condition, {
    hostCapabilities: context.request.hostCapabilities,
    bindings: runtimeBindings(context, progress),
  });
  if (!evaluation.ok) {
    return {
      ok: false,
      error: {
        code: "V2_LOCAL_HOST_TYPED_CONDITION_FAILED",
        message: evaluation.message,
        path: `${step.authoredPath}.when.${evaluation.path}`,
        causes: [evaluation.code],
      },
    };
  }
  return {
    ok: true,
    condition: {
      value: evaluation.value,
      resolvedReferences: Object.freeze([...evaluation.resolvedReferences]),
    },
  };
}

function runtimeBindings(
  context: V2InactiveLocalHostContext,
  progress: V2InactiveLocalKernelProgress
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    ...cloneRecord(context.request.conditionBindings),
    state: cloneRecord(progress.state),
    steps: cloneRecord(progress.stepOutputs),
  });
}

function kernelResult(
  step: V2InactiveLocalHostStepPlan,
  progress: V2InactiveLocalKernelProgress,
  status: V2InactiveLocalHostStepStatus,
  condition: {
    readonly value: boolean;
    readonly resolvedReferences: readonly string[];
  },
  options: {
    readonly branchDecision?: boolean;
    readonly completionResult?: unknown;
    readonly resolvedInput?: unknown;
    readonly terminal?: boolean;
    readonly stateBefore?: Readonly<Record<string, unknown>>;
  } = {}
): ExecuteV2InactiveLocalKernelStepResult {
  const state = deepFreeze(cloneRecord(progress.state));
  const core = {
    index: step.index,
    id: step.id,
    authoredPath: step.authoredPath,
    kind: step.kind,
    use: step.use,
    status,
    condition: deepFreeze({ ...condition }),
    attempts: Object.freeze([]),
    stateBeforeSha256: digest(
      stableStringify(options.stateBefore ?? progress.state)
    ),
    stateAfterSha256: digest(stableStringify(state)),
    ...(options.resolvedInput === undefined
      ? {}
      : {
          resolvedInputSha256: digest(stableStringify(options.resolvedInput)),
        }),
    ...(options.branchDecision === undefined
      ? {}
      : { branchDecision: options.branchDecision }),
    ...(options.completionResult === undefined
      ? {}
      : {
          completionResultSha256: digest(
            stableStringify(options.completionResult)
          ),
        }),
  };
  return {
    ok: true,
    receipt: deepFreeze({
      ...core,
      stepSha256: digest(stableStringify(core)),
    }),
    state,
    stepOutputs: deepFreeze(cloneRecord(progress.stepOutputs)),
    branchDecisions: deepFreeze({ ...progress.branchDecisions }),
    ...(options.completionResult === undefined
      ? {}
      : { completionResult: deepFreeze(structuredClone(options.completionResult)) }),
    terminal: options.terminal ?? false,
  };
}

function mergeConditionReferences(
  condition: {
    readonly value: boolean;
    readonly resolvedReferences: readonly string[];
  },
  references: readonly string[]
) {
  return {
    value: condition.value,
    resolvedReferences: Object.freeze([
      ...new Set([...condition.resolvedReferences, ...references]),
    ]),
  };
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}
