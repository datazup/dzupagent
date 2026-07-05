import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";

import type {
  CompilationDiagnostic,
  FlowCompileSubflowEvidence,
  FlowDocumentResolver,
} from "../types.js";

export interface InlineSubflowOptions {
  currentFlowRef?: string;
}

export interface InlineSubflowResult {
  root: FlowNode;
  diagnostics: CompilationDiagnostic[];
  subflows: FlowCompileSubflowEvidence[];
}

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

const STATE_TEMPLATE_RE = /\{\{\s*state\.([A-Za-z0-9_]+)((?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
const CHILD_NODE_FIELDS = new Set([
  "nodes",
  "body",
  "then",
  "else",
  "catch",
  "branches",
  "onApprove",
  "onReject",
]);

function privateKey(instanceId: string, key: string): string {
  return `${instanceId}__${key}`;
}

function rewriteStateTemplates(value: string, instanceId: string): string {
  return value.replace(
    STATE_TEMPLATE_RE,
    (_match, key: string, pathRest: string) => `{{ state.${privateKey(instanceId, key)}${pathRest} }}`,
  );
}

function instanceIdFor(node: FlowNode): string {
  return node.id && node.id.length > 0
    ? node.id
    : node.type.replace(/[^A-Za-z0-9_]+/g, "_");
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

function rewriteValue(
  value: unknown,
  instanceId: string,
  nodeType?: string,
  stateKeyFieldDepth = 0,
  nodeScopeEligible = false,
): unknown {
  if (typeof value === "string") return rewriteStateTemplates(value, instanceId);
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteValue(
        item,
        instanceId,
        nodeType,
        stateKeyFieldDepth + 1,
        nodeScopeEligible,
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
            ),
          ],
        ),
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
    output[key] = rewriteValue(
      child,
      instanceId,
      currentNodeType,
      currentStateKeyFieldDepth + 1,
      CHILD_NODE_FIELDS.has(key),
    );
  }
  return output;
}

function diagnostic(
  code: "UNKNOWN_SUBFLOW_REF" | "SUBFLOW_CYCLE",
  message: string,
  nodePath: string,
): CompilationDiagnostic {
  return {
    stage: 2,
    code,
    message,
    nodePath,
    category: "resolution",
  };
}

async function inlineNode(
  node: FlowNode,
  resolver: FlowDocumentResolver,
  path: string,
  stack: string[],
  diagnostics: CompilationDiagnostic[],
  subflows: FlowCompileSubflowEvidence[],
): Promise<FlowNode[]> {
  if (node.type === "subflow") {
    if (stack.includes(node.flowRef)) {
      diagnostics.push(
        diagnostic(
          "SUBFLOW_CYCLE",
          `Subflow cycle detected: ${[...stack, node.flowRef].join(" -> ")}`,
          path,
        ),
      );
      return [];
    }

    const document = await resolver.resolve(node.flowRef);
    if (!document) {
      diagnostics.push(
        diagnostic(
          "UNKNOWN_SUBFLOW_REF",
          `Unknown subflow reference "${node.flowRef}"`,
          path,
        ),
      );
      return [];
    }

    const nested = await inlineSequence(
      document.root.nodes,
      resolver,
      `${path}.root.nodes`,
      [...stack, node.flowRef],
      diagnostics,
      subflows,
    );
    const instanceId = instanceIdFor(node);
    subflows.push({ flowRef: node.flowRef, instanceId, nodePath: path });
    return nested.map(
      (child) => rewriteValue(child, instanceId, child.type, 0, true) as FlowNode,
    );
  }

  if (node.type === "sequence") {
    return [
      {
        ...node,
        nodes: await inlineSequence(
          node.nodes,
          resolver,
          `${path}.nodes`,
          stack,
          diagnostics,
          subflows,
        ),
      },
    ];
  }

  if (node.type === "branch") {
    return [
      {
        ...node,
        then: await inlineSequence(
          node.then,
          resolver,
          `${path}.then`,
          stack,
          diagnostics,
          subflows,
        ),
        ...(node.else
          ? {
              else: await inlineSequence(
                node.else,
                resolver,
                `${path}.else`,
                stack,
                diagnostics,
                subflows,
              ),
            }
          : {}),
      },
    ];
  }

  if (node.type === "parallel") {
    const branches = await Promise.all(
      node.branches.map((branch, index) =>
        inlineSequence(
          branch,
          resolver,
          `${path}.branches[${index}]`,
          stack,
          diagnostics,
          subflows,
        ),
      ),
    );
    return [{ ...node, branches }];
  }

  if (node.type === "for_each") {
    return [
      {
        ...node,
        body: await inlineSequence(
          node.body,
          resolver,
          `${path}.body`,
          stack,
          diagnostics,
          subflows,
        ),
      },
    ];
  }

  if (node.type === "approval") {
    return [
      {
        ...node,
        onApprove: await inlineSequence(
          node.onApprove,
          resolver,
          `${path}.onApprove`,
          stack,
          diagnostics,
          subflows,
        ),
        ...(node.onReject
          ? {
              onReject: await inlineSequence(
                node.onReject,
                resolver,
                `${path}.onReject`,
                stack,
                diagnostics,
                subflows,
              ),
            }
          : {}),
      },
    ];
  }

  if (node.type === "persona" || node.type === "route" || node.type === "loop") {
    return [
      {
        ...node,
        body: await inlineSequence(
          node.body,
          resolver,
          `${path}.body`,
          stack,
          diagnostics,
          subflows,
        ),
      },
    ];
  }

  if (node.type === "try_catch") {
    return [
      {
        ...node,
        body: await inlineSequence(
          node.body,
          resolver,
          `${path}.body`,
          stack,
          diagnostics,
          subflows,
        ),
        catch: await inlineSequence(
          node.catch,
          resolver,
          `${path}.catch`,
          stack,
          diagnostics,
          subflows,
        ),
      },
    ];
  }

  return [node];
}

async function inlineSequence(
  nodes: readonly FlowNode[],
  resolver: FlowDocumentResolver,
  path: string,
  stack: string[],
  diagnostics: CompilationDiagnostic[],
  subflows: FlowCompileSubflowEvidence[],
): Promise<FlowNode[]> {
  const output: FlowNode[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    output.push(
      ...(await inlineNode(
        node,
        resolver,
        `${path}[${index}]`,
        stack,
        diagnostics,
        subflows,
      )),
    );
  }
  return output;
}

export async function inlineSubflows(
  root: FlowNode,
  resolver: FlowDocumentResolver,
  options: InlineSubflowOptions = {},
): Promise<InlineSubflowResult> {
  const diagnostics: CompilationDiagnostic[] = [];
  const subflows: FlowCompileSubflowEvidence[] = [];
  const stack = options.currentFlowRef ? [options.currentFlowRef] : [];
  const inlined = await inlineNode(
    root,
    resolver,
    "root",
    stack,
    diagnostics,
    subflows,
  );
  return {
    root: inlined.length === 1 ? inlined[0]! : { type: "sequence", nodes: inlined },
    diagnostics,
    subflows,
  };
}

export function currentFlowRefFromDocument(document: unknown): string | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const id = (document as Partial<FlowDocumentV1>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
