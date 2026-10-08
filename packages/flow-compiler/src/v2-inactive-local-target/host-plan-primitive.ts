import type { DslV2FrontendMetadata } from "@dzupagent/flow-dsl";
import { evaluatePrimitivePolicyNarrowing } from "@dzupagent/flow-dsl/v2-policy-narrowing";
import type { V2InactiveLocalHandlerBinding, V2InactiveLocalHostRequest, V2InactiveLocalHostError, V2InactiveLocalHostPrimitiveStepPlan, PlanBase } from "./host-contracts.js";
import { deepFreeze } from "./evidence.js";
import { cloneHostPlanRecord as cloneRecord, exactHostPlanBinding as exactBinding, invalidHostPlan as invalidPlan, invalidHostPlanBinding as bindingInvalid, isPlainHostPlanRecord as isPlainRecord, resolveHostPlanPrimitive as resolvePrimitive } from "./host-plan-support.js";

export function planPrimitive(
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
