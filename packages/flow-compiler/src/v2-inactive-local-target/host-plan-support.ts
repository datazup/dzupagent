import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";

import type { V2InactiveLocalHostRequest } from "./host-contracts.js";
import type { V2InactiveLocalHostStepPlan } from "./host-plan.js";

export function hostPlanIdentity(step: V2InactiveLocalHostStepPlan) {
  return step.kind === "primitive"
    ? {
        ...step,
        handler: {
          ref: step.handler.ref,
          semanticHash: step.handler.semanticHash,
          handlerId: step.handler.handlerId,
          handlerSha256: step.handler.handlerSha256,
          mode: step.handler.mode,
          declaredEffects: step.handler.declaredEffects,
          replay: step.handler.replay,
        },
      }
    : step;
}

export function exactHostPlanBinding<
  T extends { readonly authoredPath: string }
>(bindings: readonly T[], authoredPath: string): T | undefined {
  const matches = bindings.filter((item) => item.authoredPath === authoredPath);
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveHostPlanPrimitive(
  request: V2InactiveLocalHostRequest,
  ref: PrimitiveDefinitionV2["ref"]
): PrimitiveDefinitionV2 | undefined {
  return (
    request.compilerOptions.primitiveRegistry?.get(ref) ??
    BUILT_IN_PRIMITIVE_REGISTRY_V2.get(ref)
  );
}

export function invalidHostPlan(
  path: string,
  message: string,
  causes?: readonly string[]
) {
  return {
    ok: false as const,
    error: {
      code: "V2_LOCAL_HOST_PLAN_INVALID" as const,
      message,
      path,
      ...(causes === undefined ? {} : { causes }),
    },
  };
}

export function invalidHostPlanBinding(path: string, message: string) {
  return {
    ok: false as const,
    error: {
      code: "V2_LOCAL_HOST_HANDLER_BINDING_INVALID" as const,
      message,
      path,
    },
  };
}

export function cloneHostPlanRecord(
  value: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

export function isPlainHostPlanRecord(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
