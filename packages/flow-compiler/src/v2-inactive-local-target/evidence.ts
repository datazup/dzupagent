import { canonicalize, sha256Prefixed } from "@dzupagent/canonical-json";

import { compareCodeUnits } from "../canonical-order.js";
import type { FlowNode } from "@dzupagent/flow-ast";
import type { FlowTypedCondition } from "@dzupagent/flow-ast/expressions";
import type { DslV2FrontendMetadata } from "@dzupagent/flow-dsl";
import { FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY } from "@dzupagent/flow-dsl/v2-multi-port-save";
import { FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY } from "@dzupagent/flow-dsl/v2-policy-narrowing";
import {
  FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY,
  type PrimitiveRetryBackoff,
} from "@dzupagent/flow-dsl/v2-retry-policy";
import { FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY } from "@dzupagent/flow-dsl/v2-terminal-catch";

import type {
  V2InactiveLocalTargetContractEvidence,
  V2InactiveLocalTargetQualificationError,
} from "./contracts.js";

export function validatePrimitiveContractIdentities(
  frontend: DslV2FrontendMetadata,
): V2InactiveLocalTargetQualificationError[] {
  const declared = new Map(
    frontend.primitiveBindings.map(
      (binding) => [binding.ref, binding.semanticHash] as const,
    ),
  );
  const errors: V2InactiveLocalTargetQualificationError[] = [];
  for (const item of primitiveContractItems(frontend)) {
    if (declared.get(item.primitiveRef) === item.primitiveSemanticHash)
      continue;
    errors.push({
      code: "V2_LOCAL_TARGET_PRIMITIVE_IDENTITY_DRIFT",
      message: `${item.capability} at ${item.authoredPath} is not bound to the exact frontend primitive ref/hash`,
      path: item.authoredPath,
    });
  }
  return errors;
}

export function collectPrimitiveContractEvidence(
  frontend: DslV2FrontendMetadata,
): readonly V2InactiveLocalTargetContractEvidence[] {
  return Object.freeze(
    primitiveContractItems(frontend)
      .map((item) =>
        Object.freeze({
          capability: item.capability,
          authoredPath: item.authoredPath,
          primitiveRef: item.primitiveRef,
          primitiveSemanticHash: item.primitiveSemanticHash,
          contractSha256: digest(stableStringify(item.contract)),
        }),
      )
      .sort((left, right) =>
        compareCodeUnits(
          `${left.authoredPath}:${left.capability}`,
          `${right.authoredPath}:${right.capability}`,
        ),
      ),
  );
}

function primitiveContractItems(frontend: DslV2FrontendMetadata) {
  return [
    ...frontend.policyNarrowings.map((binding) => ({
      capability: FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY,
      authoredPath: binding.authoredPath,
      primitiveRef: binding.primitiveRef,
      primitiveSemanticHash: binding.primitiveSemanticHash,
      contract: binding.narrowing,
    })),
    ...frontend.retryPolicies.map((binding) => ({
      capability: FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY,
      authoredPath: binding.authoredPath,
      primitiveRef: binding.primitiveRef,
      primitiveSemanticHash: binding.primitiveSemanticHash,
      contract: binding.retry,
    })),
    ...frontend.terminalCatches.map((binding) => ({
      capability: FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY,
      authoredPath: binding.authoredPath,
      primitiveRef: binding.primitiveRef,
      primitiveSemanticHash: binding.primitiveSemanticHash,
      contract: binding.catch,
    })),
    ...frontend.multiPortSaves.map((binding) => ({
      capability: FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY,
      authoredPath: binding.authoredPath,
      primitiveRef: binding.primitiveRef,
      primitiveSemanticHash: binding.primitiveSemanticHash,
      contract: binding.save,
    })),
  ];
}

export function collectTypedConditions(root: FlowNode): readonly {
  readonly path: string;
  readonly condition: FlowTypedCondition;
}[] {
  const result: Array<{ path: string; condition: FlowTypedCondition }> = [];
  visit(root, "root", result);
  return Object.freeze(result);
}

function visit(
  node: FlowNode,
  path: string,
  result: Array<{ path: string; condition: FlowTypedCondition }>,
): void {
  if (
    (node.type === "branch" || node.type === "loop") &&
    node.typedCondition !== undefined
  ) {
    result.push({
      path: `${path}.typedCondition`,
      condition: node.typedCondition,
    });
  }
  for (const [child, childPath] of childNodes(node, path)) {
    visit(child, childPath, result);
  }
}

function childNodes(node: FlowNode, path: string): Array<[FlowNode, string]> {
  switch (node.type) {
    case "sequence":
      return node.nodes.map((child, index) => [
        child,
        `${path}.nodes[${index}]`,
      ]);
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      return node.body.map((child, index) => [child, `${path}.body[${index}]`]);
    case "branch":
      return [
        ...node.then.map(
          (child, index) =>
            [child, `${path}.then[${index}]`] as [FlowNode, string],
        ),
        ...(node.else ?? []).map(
          (child, index) =>
            [child, `${path}.else[${index}]`] as [FlowNode, string],
        ),
      ];
    case "parallel":
      return node.branches.flatMap((branch, branchIndex) =>
        branch.map(
          (child, index) =>
            [child, `${path}.branches[${branchIndex}][${index}]`] as [
              FlowNode,
              string,
            ],
        ),
      );
    case "approval":
      return [
        ...node.onApprove.map(
          (child, index) =>
            [child, `${path}.onApprove[${index}]`] as [FlowNode, string],
        ),
        ...(node.onReject ?? []).map(
          (child, index) =>
            [child, `${path}.onReject[${index}]`] as [FlowNode, string],
        ),
      ];
    case "try_catch":
      return [
        ...node.body.map(
          (child, index) =>
            [child, `${path}.body[${index}]`] as [FlowNode, string],
        ),
        ...node.catch.map(
          (child, index) =>
            [child, `${path}.catch[${index}]`] as [FlowNode, string],
        ),
      ];
    default:
      return [];
  }
}

export function digest(value: string): `sha256:${string}` {
  return sha256Prefixed(value);
}

// The one agreed seed derivation for retry jitter. The simulator and the host
// must both derive their seed from the primitive's semantic hash and the
// step's authored path so that, for the same flow, step, and attempt, a
// simulation reproduces the host's exact backoff delays.
export function backoffSeed(
  primitiveSemanticHash: string,
  authoredPath: string,
): string {
  return `${primitiveSemanticHash}:${authoredPath}`;
}

export function seededBackoff(
  seed: string,
  attempt: number,
  backoff: PrimitiveRetryBackoff | undefined,
): number {
  if (backoff === undefined) return 0;
  const uncapped =
    backoff.strategy === "fixed"
      ? backoff.initialMs
      : backoff.initialMs * 2 ** (attempt - 1);
  const maximum = Math.min(uncapped, backoff.maxMs);
  if (backoff.jitter === "none") return maximum;
  const entropy = digest(`${seed}:${attempt}`).slice(7, 15);
  return Number.parseInt(entropy, 16) % (maximum + 1);
}

// Delegates to @dzupagent/canonical-json's `authoring-v1` preset — the same
// semantic family as the local copy this file used to carry (undefined
// object entries kept as bare tokens, undefined array items elided,
// default UTF-16 key sort), so local-target receipt and evidence digests
// are byte-identical for the JSON-shaped values this subtree hashes.
export function stableStringify(value: unknown): string {
  return canonicalize(value, "authoring-v1");
}

export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    Object.values(value).forEach((nested) => deepFreeze(nested));
    return Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
