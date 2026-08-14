import type { FlowNode } from "@dzupagent/flow-ast";
import {
  FLOW_TYPED_CONDITION_CAPABILITY,
} from "@dzupagent/flow-ast/typed-condition-evaluator";
import {
  FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY,
} from "@dzupagent/flow-dsl/v2-policy-narrowing";
import {
  FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY,
} from "@dzupagent/flow-dsl/v2-retry-policy";
import {
  FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY,
} from "@dzupagent/flow-dsl/v2-terminal-catch";
import {
  FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY,
} from "@dzupagent/flow-dsl/v2-multi-port-save";
import { resolveDslSourceSpan } from "@dzupagent/flow-dsl/source-map";

import {
  collectUnsupportedTypedConditions,
} from "../route-target.js";
import type {
  CompilationError,
  CompilationTarget,
} from "../types.js";
import type { SourceReferenceSnapshot } from "./reference-snapshot.js";

/**
 * Stop V2-only semantics before generic artifact emission until a target has a
 * reviewed adoption contract. Authoring and semantic validation still run
 * first so users receive exact diagnostics instead of a lossy V1 projection.
 */
export function collectUnsupportedV2TargetErrors(
  ast: FlowNode,
  target: CompilationTarget,
  source: SourceReferenceSnapshot,
  targetCapabilities: readonly string[] = [],
): CompilationError[] {
  return [
    ...typedConditionErrors(ast, target, source, targetCapabilities),
    ...policyNarrowingErrors(target, source),
    ...retryPolicyErrors(target, source),
    ...terminalCatchErrors(target, source),
    ...multiPortSaveErrors(target, source),
  ];
}

function multiPortSaveErrors(
  target: CompilationTarget,
  source: SourceReferenceSnapshot,
): CompilationError[] {
  return (source.dslV2MultiPortSaves ?? []).map((binding) => {
    const path = `${binding.authoredPath}.save`;
    return {
      stage: 4 as const,
      code: "V2_MULTI_SAVE_TARGET_UNSUPPORTED",
      message:
        `Multi-port save for ${binding.primitiveRef} is valid, but the selected "${target}" target has no reviewed ` +
        `${FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY} typed state-write contract. Artifact emission is blocked.`,
      nodePath: path,
      category: "lowering" as const,
      ...sourceSpan(source, path),
    };
  });
}

function terminalCatchErrors(
  target: CompilationTarget,
  source: SourceReferenceSnapshot,
): CompilationError[] {
  return (source.dslV2TerminalCatches ?? []).map((binding) => {
    const path = `${binding.authoredPath}.catch`;
    return {
      stage: 4 as const,
      code: "V2_CATCH_TARGET_UNSUPPORTED",
      message:
        `Terminal catch for ${binding.primitiveRef} is valid, but the selected "${target}" target has no reviewed ` +
        `${FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY} terminal-result handler. Artifact emission is blocked.`,
      nodePath: path,
      category: "lowering" as const,
      ...sourceSpan(source, path),
    };
  });
}

function retryPolicyErrors(
  target: CompilationTarget,
  source: SourceReferenceSnapshot,
): CompilationError[] {
  return (source.dslV2RetryPolicies ?? []).map((binding) => {
    const path = `${binding.authoredPath}.retry`;
    return {
      stage: 4 as const,
      code: "V2_RETRY_TARGET_UNSUPPORTED",
      message:
        `Retry policy for ${binding.primitiveRef} is valid, but the selected "${target}" target has no reviewed ` +
        `${FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY} same-invocation scheduler. Artifact emission is blocked.`,
      nodePath: path,
      category: "lowering" as const,
      ...sourceSpan(source, path),
    };
  });
}

function typedConditionErrors(
  ast: FlowNode,
  target: CompilationTarget,
  source: SourceReferenceSnapshot,
  targetCapabilities: readonly string[],
): CompilationError[] {
  const typedLoopEvaluatorAdmitted = targetCapabilities.includes(
    FLOW_TYPED_CONDITION_CAPABILITY,
  ) && target === "pipeline";
  return collectUnsupportedTypedConditions(ast)
    .filter(
      (condition) =>
        condition.nodeType !== "loop" || !typedLoopEvaluatorAdmitted,
    )
    .map((condition) => ({
      stage: 4 as const,
      code: "TYPED_CONDITION_TARGET_UNSUPPORTED",
      message:
        `Typed condition at "${condition.path}" is valid, but the selected "${target}" target has no reviewed ` +
        `${FLOW_TYPED_CONDITION_CAPABILITY} evaluator. Artifact emission is blocked.`,
      nodePath: condition.path,
      category: "lowering" as const,
      ...sourceSpan(source, condition.path),
    }));
}

function policyNarrowingErrors(
  target: CompilationTarget,
  source: SourceReferenceSnapshot,
): CompilationError[] {
  return (source.dslV2PolicyNarrowings ?? []).map((binding) => {
    const path = `${binding.authoredPath}.policy`;
    return {
      stage: 4 as const,
      code: "V2_POLICY_TARGET_UNSUPPORTED",
      message:
        `Policy narrowing for ${binding.primitiveRef} is valid, but the selected "${target}" target has no reviewed ` +
        `${FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY} enforcement contract. Artifact emission is blocked.`,
      nodePath: path,
      category: "lowering" as const,
      ...sourceSpan(source, path),
    };
  });
}

function sourceSpan(
  source: SourceReferenceSnapshot,
  path: string,
): Pick<CompilationError, "span"> | Record<string, never> {
  if (source.dslSourceMap === undefined) return {};
  const span = resolveDslSourceSpan(source.dslSourceMap, path);
  return span === undefined
    ? {}
    : {
        span: {
          kind: "source-offsets" as const,
          ...span,
        },
      };
}
