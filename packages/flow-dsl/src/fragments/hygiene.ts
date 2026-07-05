const STATE_KEY_FIELDS = new Set([
  "output",
  "outputKey",
  "outputVar",
  "source",
  "progressKey",
  "sourceRefsKey",
  "driftFindingIdsKey",
  "errorVar",
]);
const SOURCE_IS_STATE_NODE_TYPES = new Set([
  "evidence.write",
  "validate.schema",
  "validate",
  "memory.write",
]);
const STRUCTURAL_PARAM_RE = /^\{\{\s*params\.([A-Za-z0-9_]+)\s*\}\}$/;
const PARAM_RE = /\{\{\s*params\.([A-Za-z0-9_]+)\s*\}\}/g;
const STATE_TEMPLATE_RE =
  /\{\{\s*state\.([A-Za-z0-9_]+)((?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
export const CHILD_NODE_FIELDS = new Set([
  "nodes",
  "body",
  "then",
  "else",
  "catch",
  "branches",
  "onApprove",
  "onReject",
]);

export interface FragmentReferenceScope {
  nodeIds?: ReadonlySet<string>;
  checkpointLabels?: ReadonlySet<string>;
}

export function hasParentReferenceScope(
  node: Record<string, unknown>,
): boolean {
  const meta = node.meta;
  return Boolean(
    meta &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      (meta as { referenceScope?: unknown }).referenceScope === "parent",
  );
}

export function privateKey(instanceId: string, key: string): string {
  return `${instanceId}__${key}`;
}

function substituteParams(value: string, params: Record<string, unknown>): unknown {
  const structuralMatch = STRUCTURAL_PARAM_RE.exec(value);
  if (structuralMatch) {
    const key = structuralMatch[1]!;
    if (!(key in params)) throw new Error(`unbound fragment param "${key}"`);
    return params[key];
  }

  return value.replace(PARAM_RE, (_match, key: string) => {
    if (!(key in params)) throw new Error(`unbound fragment param "${key}"`);
    const replacement = params[key];
    if (typeof replacement !== "string") {
      throw new Error(`fragment param "${key}" must be string for interpolation`);
    }
    return replacement;
  });
}

function rewriteStateTemplates(value: string, instanceId: string): string {
  return value.replace(
    STATE_TEMPLATE_RE,
    (_match, key: string, pathRest: string) =>
      `{{ state.${privateKey(instanceId, key)}${pathRest} }}`,
  );
}

function shouldRewriteStateKeyField(
  nodeType: string | undefined,
  key: string,
  value: string,
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
  referenceScope: FragmentReferenceScope,
): boolean {
  if (value.includes("{{")) return false;
  if (
    nodeType === "return_to" &&
    key === "targetId" &&
    referenceScope.nodeIds?.has(value)
  ) {
    return true;
  }
  if (
    nodeType === "checkpoint" &&
    key === "captureOutputOf" &&
    referenceScope.nodeIds?.has(value)
  ) {
    return true;
  }
  if (
    nodeType === "checkpoint" &&
    key === "label" &&
    referenceScope.checkpointLabels?.has(value)
  ) {
    return true;
  }
  return Boolean(
    nodeType === "restore" &&
      key === "checkpointLabel" &&
      referenceScope.checkpointLabels?.has(value),
  );
}

export function rewriteFragmentValue(
  value: unknown,
  instanceId: string,
  params: Record<string, unknown> = {},
  nodeType?: string,
  stateKeyFieldDepth = 0,
  nodeScopeEligible = false,
  referenceScope: FragmentReferenceScope = {},
): unknown {
  if (typeof value === "string") {
    if (STRUCTURAL_PARAM_RE.test(value)) return substituteParams(value, params);
    return substituteParams(rewriteStateTemplates(value, instanceId), params);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteFragmentValue(
        item,
        instanceId,
        params,
        nodeType,
        stateKeyFieldDepth + 1,
        nodeScopeEligible,
        referenceScope,
      ),
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
    const parentReferenceScope =
      isFlowNodeObject && hasParentReferenceScope(objectValue);
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
            rewriteFragmentValue(
              assignValue,
              instanceId,
              params,
              currentNodeType,
              currentStateKeyFieldDepth + 1,
              false,
              referenceScope,
            ),
          ],
        ),
      );
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
    if (
      !parentReferenceScope &&
      currentStateKeyFieldDepth === 0 &&
      typeof child === "string" &&
      shouldRewriteNodeReferenceField(
        currentNodeType,
        key,
        child,
        referenceScope,
      )
    ) {
      output[key] = privateKey(instanceId, child);
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
          : rewriteFragmentValue(
              child,
              instanceId,
              params,
              currentNodeType,
              currentStateKeyFieldDepth + 1,
              false,
              referenceScope,
            );
      continue;
    }
    output[key] = rewriteFragmentValue(
      child,
      instanceId,
      params,
      currentNodeType,
      currentStateKeyFieldDepth + 1,
      CHILD_NODE_FIELDS.has(key),
      referenceScope,
    );
  }
  return output;
}

export function rewriteFragmentNode(
  node: Record<string, unknown>,
  instanceId: string,
  params: Record<string, unknown> = {},
  referenceScope: FragmentReferenceScope = {},
): Record<string, unknown> {
  const nodeType = typeof node.type === "string" ? node.type : undefined;
  return rewriteFragmentValue(
    node,
    instanceId,
    params,
    nodeType,
    0,
    true,
    referenceScope,
  ) as Record<string, unknown>;
}
