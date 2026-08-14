import { FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW } from "@dzupagent/flow-ast/expressions";

import type { DslDiagnostic } from "../types.js";
import {
  withV2SourceLineage,
  type V2SourceLineageMarker,
} from "./source-lineage.js";
import {
  parseV2TypedCondition,
  type ParsedV2TypedCondition,
} from "./typed-condition.js";
import type { V2LoweringContext } from "./lower-v2-context.js";

type LowerSteps = (
  raw: unknown,
  authoredPath: string,
  loweredPath: string,
  context: V2LoweringContext
) => readonly Readonly<Record<string, unknown>>[];

export function lowerV2CoreStep(
  kind: string,
  version: string,
  raw: Record<string, unknown>,
  input: Record<string, unknown>,
  base: Record<string, unknown>,
  authoredPath: string,
  loweredPath: string,
  context: V2LoweringContext,
  lowerSteps: LowerSteps
): Readonly<Record<string, unknown>> | null {
  if (version !== "1") {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_UNKNOWN_KERNEL",
      message: `P3a does not support ${kind}@${version}`,
      path: `${authoredPath}.use`,
    });
    return null;
  }
  if (raw.policy !== undefined) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_POLICY_REQUIRES_PRIMITIVE",
      message: `policy narrowing requires an exact primitive contract; ${kind}@${version} is a kernel step`,
      path: `${authoredPath}.policy`,
    });
  }
  if (raw.retry !== undefined) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_RETRY_REQUIRES_PRIMITIVE",
      message: `retry requires exact declared primitive errors; ${kind}@${version} is a kernel step`,
      path: `${authoredPath}.retry`,
    });
  }
  if (raw.catch !== undefined) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_CATCH_REQUIRES_PRIMITIVE",
      message: `catch requires exact declared primitive errors; ${kind}@${version} is a kernel step`,
      path: `${authoredPath}.catch`,
    });
  }
  if (raw.save !== undefined) {
    context.diagnostics.push(
      unsupported(
        `P3a does not support save on ${kind}@${version}`,
        `${authoredPath}.save`
      )
    );
  }
  if (kind === "core.set") {
    context.lineage.push({
      authoredPath,
      loweredPath,
      use: `${kind}@${version}`,
    });
    return {
      set: withV2SourceLineage(
        { ...base, ...input },
        coreSourceLineage(kind, version, authoredPath, loweredPath)
      ),
    };
  }
  if (kind === "core.complete") {
    context.lineage.push({
      authoredPath,
      loweredPath,
      use: `${kind}@${version}`,
    });
    return {
      complete: withV2SourceLineage(
        { ...base, ...input },
        coreSourceLineage(kind, version, authoredPath, loweredPath)
      ),
    };
  }
  if (kind === "core.branch") {
    return lowerBranch(
      raw,
      input,
      base,
      authoredPath,
      loweredPath,
      context,
      lowerSteps
    );
  }
  if (kind === "core.loop") {
    return lowerLoop(
      input,
      base,
      authoredPath,
      loweredPath,
      context,
      lowerSteps
    );
  }
  context.diagnostics.push({
    phase: "normalize",
    code: "V2_UNKNOWN_KERNEL",
    message: `P3a kernel does not contain ${kind}@${version}`,
    path: `${authoredPath}.use`,
  });
  return null;
}

export function wrapV2GuardedStep(
  lowered: Readonly<Record<string, unknown>>,
  guard: ParsedV2TypedCondition,
  id: string,
  use: string,
  authoredPath: string,
  loweredPath: string,
  context: V2LoweringContext
): Readonly<Record<string, unknown>> | null {
  const guardId = `${id}__when_guard`;
  if (
    context.authoredStepIds.has(guardId) ||
    context.generatedGuardIds.has(guardId)
  ) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_GUARD_ID_CONFLICT",
      message: `generated v2 when guard id "${guardId}" conflicts with another step`,
      path: `${authoredPath}.id`,
    });
    return null;
  }
  context.generatedGuardIds.add(guardId);
  for (let index = context.lineage.length - 1; index >= 0; index -= 1) {
    const entry = context.lineage[index];
    if (entry?.authoredPath !== authoredPath) continue;
    context.lineage[index] = {
      ...entry,
      guardId,
      guardLoweredPath: loweredPath,
    };
    break;
  }
  return {
    if: withV2SourceLineage(
      {
        id: guardId,
        condition: FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
        typedCondition: guard.condition,
        then: [lowered],
      },
      {
        authoredPath,
        loweredPath,
        use,
        generated: false,
        guardedStep: true,
        typedConditionBindings: guard.sourceBindings,
      }
    ),
  };
}

function lowerBranch(
  raw: Record<string, unknown>,
  input: Record<string, unknown>,
  base: Record<string, unknown>,
  authoredPath: string,
  loweredPath: string,
  context: V2LoweringContext,
  lowerSteps: LowerSteps
): Readonly<Record<string, unknown>> {
  const legacyCondition =
    typeof raw.when === "string" && raw.when.length > 0 ? raw.when : undefined;
  const typedCondition =
    legacyCondition !== undefined || raw.when === undefined
      ? undefined
      : parseV2TypedCondition(
          raw.when,
          `${authoredPath}.when`,
          context.diagnostics
        );
  if (legacyCondition === undefined && typedCondition == null) {
    context.diagnostics.push(
      required(
        "core.branch@1 requires a string or typed boolean when expression",
        `${authoredPath}.when`
      )
    );
  }
  const allowed = new Set(["then", "else"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      context.diagnostics.push(
        unsupported(
          `core.branch@1 with.${key} is unsupported`,
          `${authoredPath}.with.${key}`
        )
      );
    }
  }
  context.lineage.push({
    authoredPath,
    loweredPath,
    use: "core.branch@1",
  });
  const thenSteps = lowerSteps(
    input.then,
    `${authoredPath}.with.then`,
    `${loweredPath}.if.then`,
    context
  );
  const elseSteps =
    input.else === undefined
      ? undefined
      : lowerSteps(
          input.else,
          `${authoredPath}.with.else`,
          `${loweredPath}.if.else`,
          context
        );
  return {
    if: withV2SourceLineage(
      {
        ...base,
        condition: legacyCondition ?? FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
        ...(typedCondition == null
          ? {}
          : { typedCondition: typedCondition.condition }),
        then: thenSteps,
        ...(elseSteps === undefined ? {} : { else: elseSteps }),
      },
      {
        ...coreSourceLineage("core.branch", "1", authoredPath, loweredPath),
        ...(typedCondition == null
          ? {}
          : {
              typedConditionBindings: typedCondition.sourceBindings,
            }),
      }
    ),
  };
}

/**
 * Bounded iteration. Unlike core.branch the condition lives in `with`, matching
 * the v1 loop node, which evaluates it against state before each iteration.
 */
function lowerLoop(
  input: Record<string, unknown>,
  base: Record<string, unknown>,
  authoredPath: string,
  loweredPath: string,
  context: V2LoweringContext,
  lowerSteps: LowerSteps
): Readonly<Record<string, unknown>> {
  const condition =
    typeof input.condition === "string" && input.condition.length > 0
      ? input.condition
      : undefined;
  if (condition === undefined) {
    context.diagnostics.push(
      required(
        "core.loop@1 requires a non-empty string with.condition",
        `${authoredPath}.with.condition`
      )
    );
  }
  const allowed = new Set([
    "condition",
    "body",
    "maxIterations",
    "onExhausted",
    "iterationTimeoutMs",
    "iterationBudgetCents",
    "progressKey",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      context.diagnostics.push(
        unsupported(
          `core.loop@1 with.${key} is unsupported`,
          `${authoredPath}.with.${key}`
        )
      );
    }
  }
  if (
    input.onExhausted !== undefined &&
    input.onExhausted !== "fail" &&
    input.onExhausted !== "continue"
  ) {
    context.diagnostics.push({
      phase: "normalize",
      code: "INVALID_ENUM_VALUE",
      message:
        'core.loop@1 with.onExhausted must be "fail" or "continue"',
      path: `${authoredPath}.with.onExhausted`,
    });
  }
  if (
    input.iterationTimeoutMs !== undefined &&
    !(
      typeof input.iterationTimeoutMs === "number" &&
      Number.isInteger(input.iterationTimeoutMs) &&
      input.iterationTimeoutMs > 0
    )
  ) {
    context.diagnostics.push({
      phase: "normalize",
      code: "INVALID_NODE_SHAPE",
      message:
        "core.loop@1 with.iterationTimeoutMs must be a positive integer",
      path: `${authoredPath}.with.iterationTimeoutMs`,
    });
  }
  if (
    input.iterationBudgetCents !== undefined &&
    !(
      typeof input.iterationBudgetCents === "number" &&
      Number.isFinite(input.iterationBudgetCents) &&
      input.iterationBudgetCents > 0
    )
  ) {
    context.diagnostics.push({
      phase: "normalize",
      code: "INVALID_NODE_SHAPE",
      message:
        "core.loop@1 with.iterationBudgetCents must be a positive finite number",
      path: `${authoredPath}.with.iterationBudgetCents`,
    });
  }
  context.lineage.push({
    authoredPath,
    loweredPath,
    use: "core.loop@1",
  });
  const bodySteps = lowerSteps(
    input.body,
    `${authoredPath}.with.body`,
    `${loweredPath}.loop.body`,
    context
  );
  return {
    loop: withV2SourceLineage(
      {
        ...base,
        condition: condition ?? "",
        body: bodySteps,
        ...(typeof input.maxIterations === "number"
          ? { maxIterations: input.maxIterations }
          : {}),
        ...(input.onExhausted === "fail" || input.onExhausted === "continue"
          ? { onExhausted: input.onExhausted }
          : {}),
        ...(typeof input.iterationTimeoutMs === "number" &&
        Number.isInteger(input.iterationTimeoutMs) &&
        input.iterationTimeoutMs > 0
          ? { iterationTimeoutMs: input.iterationTimeoutMs }
          : {}),
        ...(typeof input.iterationBudgetCents === "number" &&
        Number.isFinite(input.iterationBudgetCents) &&
        input.iterationBudgetCents > 0
          ? { iterationBudgetCents: input.iterationBudgetCents }
          : {}),
        ...(typeof input.progressKey === "string"
          ? { progressKey: input.progressKey }
          : {}),
      },
      coreSourceLineage("core.loop", "1", authoredPath, loweredPath)
    ),
  };
}

function coreSourceLineage(
  kind: string,
  version: string,
  authoredPath: string,
  loweredPath: string
): V2SourceLineageMarker {
  return {
    authoredPath,
    loweredPath,
    use: `${kind}@${version}`,
    generated: false,
  };
}

function required(message: string, path: string): DslDiagnostic {
  return { phase: "normalize", code: "MISSING_REQUIRED_FIELD", message, path };
}

function unsupported(message: string, path: string): DslDiagnostic {
  return { phase: "normalize", code: "UNSUPPORTED_FIELD", message, path };
}
