const STATE_KEY_FIELDS = new Set(["output", "outputKey", "outputVar", "source"]);
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

export function rewriteFragmentValue(
  value: unknown,
  instanceId: string,
  params: Record<string, unknown> = {},
  nodeType?: string,
): unknown {
  if (typeof value === "string") {
    if (STRUCTURAL_PARAM_RE.test(value)) return substituteParams(value, params);
    return substituteParams(rewriteStateTemplates(value, instanceId), params);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteFragmentValue(item, instanceId, params, nodeType));
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "id" && typeof child === "string") {
      output[key] = privateKey(instanceId, child);
      continue;
    }
    if (
      typeof child === "string" &&
      shouldRewriteStateKeyField(nodeType, key, child)
    ) {
      output[key] = privateKey(instanceId, child);
      continue;
    }
    if (key === "output" && child && typeof child === "object" && !Array.isArray(child)) {
      const outputObj = child as Record<string, unknown>;
      output[key] =
        typeof outputObj.key === "string"
          ? { ...outputObj, key: privateKey(instanceId, outputObj.key) }
          : rewriteFragmentValue(child, instanceId, params, nodeType);
      continue;
    }
    output[key] = rewriteFragmentValue(child, instanceId, params, nodeType);
  }
  return output;
}

export function rewriteFragmentNode(
  node: Record<string, unknown>,
  instanceId: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  const nodeType = typeof node.type === "string" ? node.type : undefined;
  return rewriteFragmentValue(node, instanceId, params, nodeType) as Record<
    string,
    unknown
  >;
}
