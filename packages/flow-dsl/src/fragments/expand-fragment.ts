import type {
  FragmentInvocationExpansion,
  FragmentInvocationInput,
} from "./types.js";
import {
  privateKey,
  rewriteFragmentNode,
  rewriteFragmentValue,
} from "./hygiene.js";

function assertInvocation(raw: unknown): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("fragment invocation must be an object");
  }
}

function toStepWrapper(node: Record<string, unknown>): Record<string, unknown> {
  const { type, ...body } = node;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("fragment node must declare a string type");
  }
  return { [type]: body };
}

function invocationControlKeys(): Set<string> {
  return new Set(["id", "type", "output"]);
}

function sanitizeInstancePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function defaultInstanceId(kind: string, path: string): string {
  const kindPart = sanitizeInstancePart(kind);
  const pathPart = sanitizeInstancePart(path);
  return pathPart.length > 0 ? `${kindPart}_${pathPart}` : kindPart;
}

function normalizeExportMap(
  exports: Record<string, unknown> | undefined,
  instanceId: string,
  params: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(exports ?? {}).map(([name, value]) => {
      const expression =
        typeof value === "string"
          ? value
          : value &&
              typeof value === "object" &&
              typeof (value as { expression?: unknown }).expression === "string"
            ? (value as { expression: string }).expression
            : `{{ state.${name} }}`;
      return [name, rewriteExportExpression(expression, instanceId, params)];
    }),
  );
}

function rewriteExportExpression(
  expression: string,
  instanceId: string,
  params: Record<string, unknown>,
): string {
  const rewritten = rewriteFragmentValue(expression, instanceId, params);
  if (typeof rewritten !== "string") {
    throw new Error("fragment export expression must resolve to string");
  }
  return rewritten;
}

function validateParamType(
  name: string,
  type: string,
  value: unknown,
): void {
  const ok =
    type === "any" ||
    (type === "array"
      ? Array.isArray(value)
      : type === "object"
        ? Boolean(value && typeof value === "object" && !Array.isArray(value))
        : typeof value === type);
  if (!ok) {
    throw new Error(`fragment param "${name}" must be ${type}`);
  }
}

function resolveParams(input: FragmentInvocationInput): Record<string, unknown> {
  assertInvocation(input.raw);
  const entry = input.registry.get(input.kind);
  if (!entry) throw new Error(`unknown fragment ${input.kind}`);

  const params: Record<string, unknown> = { ...input.raw };
  const declaredParams = new Set(Object.keys(entry.fragment.params ?? {}));
  for (const key of Object.keys(params)) {
    if (!declaredParams.has(key) && !invocationControlKeys().has(key)) {
      throw new Error(`unknown fragment param "${key}"`);
    }
  }
  for (const [name, spec] of Object.entries(entry.fragment.params ?? {})) {
    if (params[name] === undefined && spec.default !== undefined) {
      params[name] = spec.default;
    }
    if (spec.required === true && params[name] === undefined) {
      throw new Error(`missing required fragment param "${name}"`);
    }
    if (params[name] !== undefined) validateParamType(name, spec.type, params[name]);
  }
  return params;
}

function bindParentOutput(
  raw: Record<string, unknown>,
  instanceId: string,
  exports: Record<string, string>,
): Record<string, unknown>[] {
  const entries = Object.entries(exports);
  if (typeof raw.output === "string") {
    if (entries.length !== 1) {
      throw new Error(
        "multi-export fragment output binding requires explicit output mapping",
      );
    }
    const [name, expression] = entries[0]!;
    return [
      {
        set: {
          id: privateKey(instanceId, `export_${name}`),
          assign: { [raw.output]: expression },
        },
      },
    ];
  }

  if (!raw.output || typeof raw.output !== "object" || Array.isArray(raw.output)) {
    return [];
  }

  const outputMap = raw.output as Record<string, unknown>;
  return Object.entries(outputMap).map(([name, outputKey]) => {
    if (!(name in exports)) {
      throw new Error(`fragment output mapping references unknown export "${name}"`);
    }
    if (typeof outputKey !== "string" || outputKey.length === 0) {
      throw new Error(`fragment output mapping for export "${name}" must be a string`);
    }
    return {
      set: {
        id: privateKey(instanceId, `export_${name}`),
        assign: { [outputKey]: exports[name] },
      },
    };
  });
}

function rewriteNestedFragmentOutputMapping(
  node: Record<string, unknown>,
  instanceId: string,
): Record<string, unknown> {
  if (!node.output || typeof node.output !== "object" || Array.isArray(node.output)) {
    return node;
  }
  if ("key" in node.output) return node;

  const outputMap = node.output as Record<string, unknown>;
  return {
    ...node,
    output: Object.fromEntries(
      Object.entries(outputMap).map(([name, outputKey]) => [
        name,
        typeof outputKey === "string" ? privateKey(instanceId, outputKey) : outputKey,
      ]),
    ),
  };
}

interface ExpandedNode {
  steps: Record<string, unknown>[];
  fragmentExpansions: FragmentInvocationExpansion["fragmentExpansions"];
}

function expandNode(
  node: Record<string, unknown>,
  input: FragmentInvocationInput,
  instanceId: string,
  params: Record<string, unknown>,
  index: number,
): ExpandedNode {
  const rewritten = rewriteFragmentNode(
    node,
    instanceId,
    params,
  );
  if (typeof rewritten.type === "string" && input.registry.has(rewritten.type)) {
    const expanded = expandFragmentInvocation({
      registry: input.registry,
      kind: rewritten.type,
      raw: rewriteNestedFragmentOutputMapping(rewritten, instanceId),
      path: `${input.path}.fragment[${index}]`,
    });
    return {
      steps: expanded.steps,
      fragmentExpansions: expanded.fragmentExpansions,
    };
  }
  return { steps: [toStepWrapper(rewritten)], fragmentExpansions: [] };
}

export function expandFragmentInvocation(
  input: FragmentInvocationInput,
): FragmentInvocationExpansion {
  assertInvocation(input.raw);
  const entry = input.registry.get(input.kind);
  if (!entry) throw new Error(`unknown fragment ${input.kind}`);

  const instanceId =
    typeof input.raw.id === "string" && input.raw.id.length > 0
      ? input.raw.id
      : defaultInstanceId(input.kind, input.path);
  const params = resolveParams(input);
  const exports = normalizeExportMap(entry.fragment.exports, instanceId, params);
  const expandedNodes = entry.fragment.root.nodes.map((node, index) =>
    expandNode(
      node as unknown as Record<string, unknown>,
      input,
      instanceId,
      params,
      index,
    ),
  );
  const steps = expandedNodes.flatMap((node) => node.steps);
  const nestedFragmentExpansions = expandedNodes.flatMap(
    (node) => node.fragmentExpansions,
  );
  steps.push(...bindParentOutput(input.raw, instanceId, exports));
  const sourceMap = steps.map((_, index) => ({
    parentPath: input.path,
    expandedPath: `${input.path}.fragment[${index}]`,
  }));
  const metadata = {
    id: entry.id,
    version: entry.version,
    namespace: entry.namespace,
    catalogRef: `dzup.${entry.namespace}@${entry.version}`,
    instanceId,
    invocationPath: input.path,
    expandedPaths: sourceMap.map((item) => item.expandedPath),
    exports,
  };

  return {
    steps,
    exports,
    sourceMap,
    metadata,
    fragmentExpansions: [metadata, ...nestedFragmentExpansions],
  };
}
