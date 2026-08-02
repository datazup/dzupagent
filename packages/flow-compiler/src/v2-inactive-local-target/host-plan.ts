import type { FlowNode } from "@dzupagent/flow-ast";
import type { FlowTypedCondition } from "@dzupagent/flow-ast/expressions";
import {
  parseYamlSubset,
  type DslV2FrontendMetadata,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import type { PrimitiveMultiPortSaveContract } from "@dzupagent/flow-dsl/v2-multi-port-save";
import {
  evaluatePrimitivePolicyNarrowing,
  type PrimitivePolicyLimits,
} from "@dzupagent/flow-dsl/v2-policy-narrowing";
import type { PrimitiveRetryPolicy } from "@dzupagent/flow-dsl/v2-retry-policy";
import type { PrimitiveTerminalCatchContract } from "@dzupagent/flow-dsl/v2-terminal-catch";

import { prepareFlowInputFromDsl } from "../authoring-input.js";
import {
  collectTypedConditions,
  deepFreeze,
  digest,
  stableStringify,
} from "./evidence.js";
import type {
  V2InactiveLocalHandlerBinding,
  V2InactiveLocalHostError,
  V2InactiveLocalHostRequest,
  V2InactiveLocalHostPrimitiveStepPlan,
  V2InactiveLocalHostStepPlan,
  PlanBase,
} from "./host-contracts.js";
export type {
  V2InactiveLocalHostBranchStepPlan,
  V2InactiveLocalHostCompleteStepPlan,
  V2InactiveLocalHostPrimitiveStepPlan,
  V2InactiveLocalHostSetStepPlan,
  V2InactiveLocalHostStepPlan,
} from "./host-contracts.js";
import { validateV2InactiveLocalHostRequest } from "./host-plan-request.js";
import {
  cloneHostPlanRecord as cloneRecord,
  exactHostPlanBinding as exactBinding,
  hostPlanIdentity as planIdentity,
  invalidHostPlan as invalidPlan,
  invalidHostPlanBinding as bindingInvalid,
  isPlainHostPlanRecord as isPlainRecord,
  resolveHostPlanPrimitive as resolvePrimitive,
} from "./host-plan-support.js";
import { qualifyV2InactiveLocalTarget } from "./qualification.js";


export interface V2InactiveLocalHostContext {
  readonly request: V2InactiveLocalHostRequest;
  readonly sourceSha256: `sha256:${string}`;
  readonly qualificationSha256: `sha256:${string}`;
  readonly planSha256: `sha256:${string}`;
  readonly stateBefore: Readonly<Record<string, unknown>>;
  readonly steps: readonly V2InactiveLocalHostStepPlan[];
}

export type PrepareV2InactiveLocalHostResult =
  | { readonly ok: true; readonly context: V2InactiveLocalHostContext }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError };

export async function prepareV2InactiveLocalHost(
  input: V2InactiveLocalHostRequest
): Promise<PrepareV2InactiveLocalHostResult> {
  const requestError = validateV2InactiveLocalHostRequest(input);
  if (requestError !== undefined) return { ok: false, error: requestError };

  const qualification = await qualifyV2InactiveLocalTarget({
    ...input,
    conditionEvaluationMode: "deferred-runtime",
  });
  if (!qualification.ok) {
    return {
      ok: false,
      error: {
        code: "V2_LOCAL_HOST_QUALIFICATION_FAILED",
        message: "multi-step host requires exact inactive V2 qualification",
        path: "qualification",
        causes: qualification.errors.flatMap((error) => [
          `${error.code}:${error.path ?? "root"}:${error.message}`,
          ...(error.causes ?? []).map((cause) => `cause:${cause}`),
        ]),
      },
    };
  }

  const authored = parseYamlSubset(input.source);
  const prepared = prepareFlowInputFromDsl(input.source, {
    ...(input.compilerOptions.primitiveRegistry === undefined
      ? {}
      : { primitiveRegistry: input.compilerOptions.primitiveRegistry }),
    ...(input.compilerOptions.primitiveExpansionHandlers === undefined
      ? {}
      : {
          primitiveExpansionHandlers:
            input.compilerOptions.primitiveExpansionHandlers,
        }),
  });
  if (
    !authored.ok ||
    !isPlainRecord(authored.value) ||
    !prepared.ok ||
    prepared.frontend === undefined
  ) {
    return invalidPlan(
      "source",
      "qualified source could not enter the V2 host plan"
    );
  }

  const typedConditions = collectTypedConditions(
    prepared.flowInput as FlowNode
  );
  const planned = planSteps(
    authored.value,
    prepared.frontend,
    typedConditions.map((item) => item.condition),
    input
  );
  if (!planned.ok) return planned;
  const stateBefore = cloneRecord(input.initialState ?? {});
  const planSha256 = digest(
    stableStringify({
      sourceSha256: qualification.receipt.sourceSha256,
      qualificationSha256: qualification.receipt.qualificationSha256,
      runId: input.runId,
      steps: planned.steps.map(planIdentity),
      initialState: stateBefore,
      conditionBindings: input.conditionBindings,
      inheritedPolicy: input.inheritedPolicy ?? {},
      cancelBeforeStep: input.cancelBeforeStep ?? null,
    })
  );
  return {
    ok: true,
    context: Object.freeze({
      request: Object.freeze({
        ...input,
        conditionEvaluationMode: "deferred-runtime" as const,
        hostCapabilities: Object.freeze([...input.hostCapabilities]),
        conditionBindings: deepFreeze(cloneRecord(input.conditionBindings)),
        handlers: Object.freeze([...input.handlers]),
        ...(input.initialState === undefined
          ? {}
          : { initialState: deepFreeze(cloneRecord(input.initialState)) }),
        ...(input.inheritedPolicy === undefined
          ? {}
          : { inheritedPolicy: Object.freeze({ ...input.inheritedPolicy }) }),
        ...(input.cancellation === undefined
          ? {}
          : { cancellation: input.cancellation }),
      }),
      sourceSha256: qualification.receipt.sourceSha256,
      qualificationSha256: qualification.receipt.qualificationSha256,
      planSha256,
      stateBefore: deepFreeze(stateBefore),
      steps: deepFreeze([...planned.steps]),
    }),
  };
}

function planSteps(
  document: Readonly<Record<string, unknown>>,
  frontend: DslV2FrontendMetadata,
  conditions: readonly FlowTypedCondition[],
  request: V2InactiveLocalHostRequest
):
  | {
      readonly ok: true;
      readonly steps: readonly V2InactiveLocalHostStepPlan[];
    }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError } {
  const rawSteps = document.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return invalidPlan(
      "root.steps",
      "multi-step host requires authored V2 steps"
    );
  }
  const handlers = new Map(
    request.handlers.map((handler) => [handler.ref, handler] as const)
  );
  if (handlers.size !== request.handlers.length) {
    return bindingInvalid("handlers", "handler refs must be unique");
  }
  const lineage = new Map(
    frontend.stepLineage.map((item) => [item.authoredPath, item] as const)
  );
  if (lineage.size !== frontend.stepLineage.length) {
    return invalidPlan("root.steps", "authored step lineage must be unique");
  }
  const conditionCursor = { value: 0 };
  const steps: V2InactiveLocalHostStepPlan[] = [];
  const expanded = flattenSteps(
    rawSteps,
    "root.steps",
    [],
    steps,
    conditions,
    conditionCursor,
    lineage,
    frontend,
    handlers,
    request
  );
  if (!expanded.ok) return expanded;
  if (
    steps.length < 2 ||
    conditionCursor.value !== conditions.length ||
    steps.length !== frontend.stepLineage.length
  ) {
    return invalidPlan(
      "root.steps",
      "host requires an exact multi-step kernel projection and condition lineage"
    );
  }
  const used = new Set(
    steps
      .filter(
        (step): step is V2InactiveLocalHostPrimitiveStepPlan =>
          step.kind === "primitive"
      )
      .map((step) => step.handler.ref)
  );
  if (request.handlers.some((handler) => !used.has(handler.ref))) {
    return bindingInvalid(
      "handlers",
      "unused local handler bindings are forbidden"
    );
  }
  return { ok: true, steps: deepFreeze(steps) };
}

function flattenSteps(
  rawSteps: readonly unknown[],
  basePath: string,
  requirements: readonly { readonly id: string; readonly outcome: boolean }[],
  output: V2InactiveLocalHostStepPlan[],
  conditions: readonly FlowTypedCondition[],
  conditionCursor: { value: number },
  lineage: ReadonlyMap<string, DslV2FrontendMetadata["stepLineage"][number]>,
  frontend: DslV2FrontendMetadata,
  handlers: ReadonlyMap<string, V2InactiveLocalHandlerBinding>,
  request: V2InactiveLocalHostRequest
):
  | { readonly ok: true }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError } {
  for (const [rawIndex, rawValue] of rawSteps.entries()) {
    const authoredPath = `${basePath}[${rawIndex}]`;
    if (!isPlainRecord(rawValue)) {
      return invalidPlan(authoredPath, "hosted step must be a plain object");
    }
    const selected = lineage.get(authoredPath);
    if (selected === undefined || typeof rawValue.use !== "string") {
      return invalidPlan(
        authoredPath,
        "hosted step requires exact V2 source lineage"
      );
    }
    const id =
      typeof rawValue.id === "string"
        ? rawValue.id
        : `step-${output.length + 1}`;
    const condition =
      rawValue.when === undefined
        ? undefined
        : conditions[conditionCursor.value++];
    if (rawValue.when !== undefined && condition === undefined) {
      return invalidPlan(
        `${authoredPath}.when`,
        "typed condition lineage is missing"
      );
    }
    const base = {
      index: output.length,
      id,
      authoredPath,
      use: rawValue.use,
      ...(condition === undefined ? {} : { condition }),
      branchRequirements: deepFreeze([...requirements]),
    };
    if (rawValue.use === "core.branch@1") {
      if (condition === undefined || !isPlainRecord(rawValue.with)) {
        return invalidPlan(
          authoredPath,
          "core.branch@1 requires typed when and with"
        );
      }
      output.push(deepFreeze({ ...base, kind: "branch" as const, condition }));
      const thenSteps = rawValue.with.then;
      const elseSteps = rawValue.with.else;
      if (!Array.isArray(thenSteps) || thenSteps.length === 0) {
        return invalidPlan(
          `${authoredPath}.with.then`,
          "branch then must be non-empty"
        );
      }
      const thenResult = flattenSteps(
        thenSteps,
        `${authoredPath}.with.then`,
        [...requirements, { id, outcome: true }],
        output,
        conditions,
        conditionCursor,
        lineage,
        frontend,
        handlers,
        request
      );
      if (!thenResult.ok) return thenResult;
      if (elseSteps !== undefined) {
        if (!Array.isArray(elseSteps) || elseSteps.length === 0) {
          return invalidPlan(
            `${authoredPath}.with.else`,
            "branch else must be non-empty when present"
          );
        }
        const elseResult = flattenSteps(
          elseSteps,
          `${authoredPath}.with.else`,
          [...requirements, { id, outcome: false }],
          output,
          conditions,
          conditionCursor,
          lineage,
          frontend,
          handlers,
          request
        );
        if (!elseResult.ok) return elseResult;
      }
      continue;
    }
    if (rawValue.use === "core.set@1") {
      const assign =
        isPlainRecord(rawValue.with) && isPlainRecord(rawValue.with.assign)
          ? rawValue.with.assign
          : undefined;
      if (assign === undefined) {
        return invalidPlan(
          `${authoredPath}.with.assign`,
          "core.set@1 requires assign"
        );
      }
      output.push(
        deepFreeze({
          ...base,
          kind: "set" as const,
          assign: cloneRecord(assign),
        })
      );
      continue;
    }
    if (rawValue.use === "core.complete@1") {
      if (!isPlainRecord(rawValue.with) || !("result" in rawValue.with)) {
        return invalidPlan(
          `${authoredPath}.with.result`,
          "core.complete@1 requires result"
        );
      }
      output.push(
        deepFreeze({
          ...base,
          kind: "complete" as const,
          result: structuredClone(rawValue.with.result),
        })
      );
      continue;
    }
    const primitive = planPrimitive(
      base,
      rawValue,
      selected,
      frontend,
      handlers,
      request
    );
    if (!primitive.ok) return primitive;
    output.push(primitive.step);
  }
  return { ok: true };
}

function planPrimitive(
  base: PlanBase,
  raw: Readonly<Record<string, unknown>>,
  lineage: DslV2FrontendMetadata["stepLineage"][number],
  frontend: DslV2FrontendMetadata,
  handlers: ReadonlyMap<string, V2InactiveLocalHandlerBinding>,
  request: V2InactiveLocalHostRequest
):
  | { readonly ok: true; readonly step: V2InactiveLocalHostPrimitiveStepPlan }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError } {
  const primitiveRef = lineage.primitiveRef;
  if (
    primitiveRef === undefined ||
    lineage.primitiveSemanticHash === undefined
  ) {
    return invalidPlan(
      base.authoredPath,
      "primitive step requires exact ref/hash lineage"
    );
  }
  const primitive = resolvePrimitive(request, primitiveRef);
  const handler = handlers.get(primitiveRef);
  if (
    primitive === undefined ||
    handler === undefined ||
    handler.semanticHash !== lineage.primitiveSemanticHash ||
    handler.semanticHash !== primitive.compatibility.semanticHash
  ) {
    return bindingInvalid(
      `handlers.${primitiveRef}`,
      `step requires exact local handler ${primitiveRef}/${lineage.primitiveSemanticHash}`
    );
  }
  const policy = exactBinding(frontend.policyNarrowings, base.authoredPath);
  const retry = exactBinding(frontend.retryPolicies, base.authoredPath);
  const terminal = exactBinding(frontend.terminalCatches, base.authoredPath);
  const save = exactBinding(frontend.multiPortSaves, base.authoredPath);
  if (
    policy === undefined ||
    retry === undefined ||
    terminal === undefined ||
    save === undefined
  ) {
    return invalidPlan(
      base.authoredPath,
      "every hosted primitive must own policy, retry, terminal catch, and multi-port save"
    );
  }
  const narrowed = evaluatePrimitivePolicyNarrowing(
    primitive,
    policy.narrowing,
    request.inheritedPolicy
  );
  if (!narrowed.ok) {
    return invalidPlan(
      `${base.authoredPath}.policy`,
      "authored policy is incompatible with the inherited host policy",
      narrowed.errors.map(
        (error) => `${error.code}:${error.field ?? "root"}:${error.message}`
      )
    );
  }
  return {
    ok: true,
    step: deepFreeze({
      ...base,
      kind: "primitive" as const,
      input: cloneRecord(isPlainRecord(raw.with) ? raw.with : {}),
      primitive,
      handler,
      policy: narrowed.effectivePolicy,
      retry: retry.retry,
      terminalCatch: terminal.catch,
      save: save.save,
    }),
  };
}
