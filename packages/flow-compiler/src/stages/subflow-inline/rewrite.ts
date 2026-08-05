import type { FlowNode } from "@dzupagent/flow-ast";

import {
  INPUT_TEMPLATE_RE,
  RAW_INPUT_REFERENCE_RE,
  RAW_STATE_REFERENCE_RE,
  inputStateKey,
  SOURCE_IS_STATE_NODE_TYPES,
  STATE_KEY_FIELDS,
  STATE_TEMPLATE_RE,
  CHILD_NODE_FIELDS,
} from "./constants.js";
import type { ReferenceScope } from "./reference-scope.js";

// ---------------------------------------------------------------------------
// Id / namespace remapping (rewrite)
// ---------------------------------------------------------------------------
// Rewrites a subflow's node tree so its ids, state keys, template refs, and
// cross-node references are namespaced under the subflow instance id. This is
// the substitution pass that lets the same subflow be inlined more than once
// without id or state-key collisions.

export function privateKey(instanceId: string, key: string): string {
  return `${instanceId}__${key}`;
}

export function rewriteStateTemplates(
  value: string,
  instanceId: string
): string {
  return value.replace(STATE_TEMPLATE_RE, (match, path: string) => {
    // `path` is the full dotted path (e.g. "foo.bar.baz"). The flat character
    // class in STATE_TEMPLATE_RE also admits malformed paths (leading/trailing/
    // doubled dots); only rewrite well-formed `ident(.ident)*` paths — anything
    // else is left exactly as matched, preserving the old grammar's behavior.
    const segments = path.split(".");
    if (segments.some((segment) => segment.length === 0)) return match;
    // Split off the head identifier; the remainder (with its leading dot) is
    // preserved verbatim.
    const [key, ...rest] = segments;
    const pathRest = rest.length > 0 ? `.${rest.join(".")}` : "";
    return `{{ state.${privateKey(instanceId, key!)}${pathRest} }}`;
  });
}

export function rewriteInputReferences(
  value: string,
  instanceId: string,
  inputKeys: ReadonlySet<string>,
): string {
  const templatesRewritten = value.replace(
    INPUT_TEMPLATE_RE,
    (match, path: string, suffix: string) => {
      const segments = path.split(".");
      if (segments.some((segment) => segment.length === 0)) return match;
      const [key, ...rest] = segments;
      if (key === undefined || !inputKeys.has(key)) return match;
      const pathRest = rest.length > 0 ? `.${rest.join(".")}` : "";
      const filterSuffix = suffix.trim();
      return `{{ state.${privateKey(instanceId, inputStateKey(key))}${pathRest}${filterSuffix.length > 0 ? ` ${filterSuffix}` : ""} }}`;
    },
  );

  return templatesRewritten.replace(
    RAW_INPUT_REFERENCE_RE,
    (match, key: string) =>
      inputKeys.has(key)
        ? `state.${privateKey(instanceId, inputStateKey(key))}`
        : match,
  );
}

export function rewriteRawStateReferences(
  value: string,
  instanceId: string,
): string {
  return value.replace(
    RAW_STATE_REFERENCE_RE,
    (_match, key: string) => `state.${privateKey(instanceId, key)}`,
  );
}

export function instanceIdFor(node: FlowNode): string {
  const authoredId = node.id && node.id.length > 0 ? node.id : node.type;
  return authoredId.replace(/[^A-Za-z0-9_]+/g, "_");
}

function shouldRewriteStateKeyField(
  nodeType: string | undefined,
  key: string,
  value: string
): boolean {
  if (value.includes("{{")) return false;
  if (key === "source") {
    return nodeType !== undefined && SOURCE_IS_STATE_NODE_TYPES.has(nodeType);
  }
  return STATE_KEY_FIELDS.has(key);
}

function shouldRewriteNodeReferenceField(
  nodeType: string | undefined,
  key: string,
  value: string,
  referenceScope: ReferenceScope
): boolean {
  if (value.includes("{{")) return false;
  if (
    nodeType === "return_to" &&
    key === "targetId" &&
    referenceScope.nodeIds.has(value)
  ) {
    return true;
  }
  if (
    nodeType === "checkpoint" &&
    key === "captureOutputOf" &&
    referenceScope.nodeIds.has(value)
  ) {
    return true;
  }
  if (
    nodeType === "checkpoint" &&
    key === "label" &&
    referenceScope.checkpointLabels.has(value)
  ) {
    return true;
  }
  return (
    nodeType === "restore" &&
    key === "checkpointLabel" &&
    referenceScope.checkpointLabels.has(value)
  );
}

export function rewriteValue(
  value: unknown,
  instanceId: string,
  nodeType?: string,
  stateKeyFieldDepth = 0,
  nodeScopeEligible = false,
  referenceScope: ReferenceScope = {
    nodeIds: new Set<string>(),
    checkpointLabels: new Set<string>(),
  },
  inputKeys: ReadonlySet<string> = new Set<string>(),
  fieldName?: string,
): unknown {
  if (typeof value === "string") {
    const stateRewritten =
      fieldName === "condition" && !value.includes("{{")
        ? rewriteRawStateReferences(value, instanceId)
        : rewriteStateTemplates(value, instanceId);
    return rewriteInputReferences(
      stateRewritten,
      instanceId,
      inputKeys,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteValue(
        item,
        instanceId,
        nodeType,
        stateKeyFieldDepth + 1,
        nodeScopeEligible,
        referenceScope,
        inputKeys,
        fieldName,
      )
    );
  }
  if (!value || typeof value !== "object") return value;

  const objectValue = value as Record<string, unknown>;
  const isFlowNodeObject =
    nodeScopeEligible && typeof objectValue.type === "string";
  const currentNodeType =
    isFlowNodeObject && typeof objectValue.type === "string"
      ? objectValue.type
      : nodeType;
  const currentStateKeyFieldDepth = isFlowNodeObject ? 0 : stateKeyFieldDepth;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(objectValue)) {
    if (isFlowNodeObject && key === "id" && typeof child === "string") {
      output[key] = privateKey(instanceId, child);
      continue;
    }
    if (
      currentStateKeyFieldDepth === 0 &&
      currentNodeType === "set" &&
      key === "assign" &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      output[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(
          ([assignKey, assignValue]) => [
            privateKey(instanceId, assignKey),
            rewriteValue(
              assignValue,
              instanceId,
              currentNodeType,
              currentStateKeyFieldDepth + 1,
              false,
              referenceScope,
              inputKeys,
              key,
            ),
          ]
        )
      );
      continue;
    }
    if (
      currentStateKeyFieldDepth === 0 &&
      key === "output" &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      const outputObj = child as Record<string, unknown>;
      output[key] =
        typeof outputObj.key === "string"
          ? { ...outputObj, key: privateKey(instanceId, outputObj.key) }
          : rewriteValue(
              child,
              instanceId,
              currentNodeType,
              currentStateKeyFieldDepth + 1,
              false,
              referenceScope,
              inputKeys,
              key,
            );
      continue;
    }
    if (
      currentStateKeyFieldDepth === 0 &&
      typeof child === "string" &&
      shouldRewriteNodeReferenceField(
        currentNodeType,
        key,
        child,
        referenceScope
      )
    ) {
      output[key] = privateKey(instanceId, child);
      continue;
    }
    if (
      currentStateKeyFieldDepth === 0 &&
      typeof child === "string" &&
      shouldRewriteStateKeyField(currentNodeType, key, child)
    ) {
      output[key] = privateKey(instanceId, child);
      continue;
    }
    output[key] = rewriteValue(
      child,
      instanceId,
      currentNodeType,
      currentStateKeyFieldDepth + 1,
      CHILD_NODE_FIELDS.has(key),
      referenceScope,
      inputKeys,
      key,
    );
  }
  return output;
}
