import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";

import type { DslSourceMapEntry, DslSourceSpan } from "./types.js";

const NODE_KIND_TO_TYPE: Readonly<Record<string, string>> = Object.freeze({
  action: "action",
  if: "branch",
  parallel: "parallel",
  for_each: "for_each",
  approval: "approval",
  clarify: "clarification",
  persona: "persona",
  route: "route",
  complete: "complete",
  classify: "classify",
  checkpoint: "checkpoint",
  restore: "restore",
  spawn: "spawn",
  emit: "emit",
  memory: "memory",
  set: "set",
  try_catch: "try_catch",
  loop: "loop",
  http: "http",
  wait: "wait",
  subflow: "subflow",
  prompt: "prompt",
  return_to: "return_to",
  agent: "agent",
  validate: "validate",
  "worker.dispatch": "worker.dispatch",
  "fleet.dispatch": "fleet.dispatch",
  "fleet.gather": "fleet.gather",
  "fleet.contract-net": "fleet.contract-net",
  "knowledge.write": "knowledge.write",
  "knowledge.query": "knowledge.query",
  "adapter.run": "adapter.run",
  "adapter.race": "adapter.race",
  "adapter.parallel": "adapter.parallel",
  "adapter.supervisor": "adapter.supervisor",
  "shell.run": "shell.run",
  "evidence.write": "evidence.write",
  "validate.schema": "validate.schema",
});

const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  toolRef: ["ref", "toolRef"],
  personaRef: ["persona", "personaRef"],
  approvalClass: ["approval_class", "approvalClass"],
  onApprove: ["on_approve", "onApprove"],
  onReject: ["on_reject", "onReject"],
  errorVar: ["errorVar", "error_var"],
  maxIterations: ["maxIterations", "max_iterations"],
});

const CHILD_FIELDS = new Set([
  "nodes",
  "body",
  "then",
  "else",
  "catch",
  "branches",
  "onApprove",
  "onReject",
]);

export interface MutableDslSourceEntry {
  authoredPath: string;
  keySpan?: DslSourceSpan;
  valueSpan?: DslSourceSpan;
  contentOffsets?: readonly number[];
}

export function projectDslDocumentEntries(
  document: FlowDocumentV1,
  raw: Record<string, unknown>,
  authored: Map<string, MutableDslSourceEntry>,
  entries: Map<string, DslSourceMapEntry>,
): void {
  for (const key of Object.keys(raw)) {
    if (key === "steps") continue;
    projectValue(
      (document as unknown as Record<string, unknown>)[key],
      raw[key],
      `root.${key}`,
      `root.${key}`,
      authored,
      entries,
    );
  }
  projectNodeList(
    document.root.nodes,
    Array.isArray(raw["steps"]) ? raw["steps"] : [],
    "root.nodes",
    "root.steps",
    authored,
    entries,
  );
}

function projectNodeList(
  nodes: readonly FlowNode[],
  rawSteps: readonly unknown[],
  canonicalPrefix: string,
  authoredPrefix: string,
  authored: Map<string, MutableDslSourceEntry>,
  entries: Map<string, DslSourceMapEntry>,
): void {
  const used = new Set<number>();
  nodes.forEach((node, index) => {
    const match = findRawStep(node, rawSteps, index, used);
    if (match === undefined) return;
    used.add(match);
    projectNode(
      node,
      rawSteps[match],
      `${canonicalPrefix}[${index}]`,
      `${authoredPrefix}[${match}]`,
      authored,
      entries,
    );
  });
}

function projectNode(
  node: FlowNode,
  rawWrapper: unknown,
  canonicalPath: string,
  authoredWrapperPath: string,
  authored: Map<string, MutableDslSourceEntry>,
  entries: Map<string, DslSourceMapEntry>,
): void {
  const wrapper = unwrapNode(rawWrapper);
  if (wrapper === undefined) return;
  const authoredNodePath = `${authoredWrapperPath}.${wrapper.kind}`;
  projectEntry(canonicalPath, authoredNodePath, authored, entries);

  for (const [field, value] of Object.entries(node)) {
    if (field === "type" || CHILD_FIELDS.has(field)) continue;
    const rawKey = resolveRawKey(field, wrapper.value);
    if (rawKey === undefined) continue;
    projectValue(
      value,
      wrapper.value[rawKey],
      `${canonicalPath}.${field}`,
      `${authoredNodePath}.${rawKey}`,
      authored,
      entries,
      `${authoredWrapperPath}.${rawKey}`,
    );
  }

  switch (node.type) {
    case "sequence":
      projectNodeList(
        node.nodes,
        arrayValue(wrapper.value["steps"] ?? wrapper.value["nodes"]),
        `${canonicalPath}.nodes`,
        `${authoredNodePath}.${wrapper.value["steps"] !== undefined ? "steps" : "nodes"}`,
        authored,
        entries,
      );
      break;
    case "branch":
      projectNodeList(node.then, arrayValue(wrapper.value["then"]), `${canonicalPath}.then`, `${authoredNodePath}.then`, authored, entries);
      if (node.else !== undefined) {
        projectNodeList(node.else, arrayValue(wrapper.value["else"]), `${canonicalPath}.else`, `${authoredNodePath}.else`, authored, entries);
      }
      break;
    case "parallel": {
      const branches = isRecord(wrapper.value["branches"]) ? wrapper.value["branches"] : {};
      const names = Array.isArray(node.meta?.["branchNames"])
        ? node.meta["branchNames"].filter((name): name is string => typeof name === "string")
        : Object.keys(branches);
      node.branches.forEach((branch, index) => {
        const name = names[index];
        if (name === undefined) return;
        projectNodeList(branch, arrayValue(branches[name]), `${canonicalPath}.branches[${index}]`, `${authoredNodePath}.branches.${name}`, authored, entries);
      });
      break;
    }
    case "approval":
      projectAliasedChildren(node.onApprove, wrapper.value, canonicalPath, authoredNodePath, "onApprove", authored, entries);
      if (node.onReject !== undefined) {
        projectAliasedChildren(node.onReject, wrapper.value, canonicalPath, authoredNodePath, "onReject", authored, entries);
      }
      break;
    case "try_catch":
      projectNodeList(node.body, arrayValue(wrapper.value["body"]), `${canonicalPath}.body`, `${authoredNodePath}.body`, authored, entries);
      projectNodeList(node.catch, arrayValue(wrapper.value["catch"]), `${canonicalPath}.catch`, `${authoredNodePath}.catch`, authored, entries);
      break;
    case "for_each":
    case "loop":
    case "persona":
    case "route":
      projectNodeList(node.body, arrayValue(wrapper.value["body"]), `${canonicalPath}.body`, `${authoredNodePath}.body`, authored, entries);
      break;
  }
}

function projectAliasedChildren(
  children: readonly FlowNode[],
  raw: Record<string, unknown>,
  canonicalPath: string,
  authoredNodePath: string,
  field: "onApprove" | "onReject",
  authored: Map<string, MutableDslSourceEntry>,
  entries: Map<string, DslSourceMapEntry>,
): void {
  const rawKey = resolveRawKey(field, raw);
  if (rawKey === undefined) return;
  projectNodeList(children, arrayValue(raw[rawKey]), `${canonicalPath}.${field}`, `${authoredNodePath}.${rawKey}`, authored, entries);
}

function projectValue(
  canonicalValue: unknown,
  rawValue: unknown,
  canonicalPath: string,
  authoredPath: string,
  authored: Map<string, MutableDslSourceEntry>,
  entries: Map<string, DslSourceMapEntry>,
  normalizationAlias?: string,
): void {
  projectEntry(canonicalPath, authoredPath, authored, entries);
  if (normalizationAlias !== undefined) {
    projectEntry(normalizationAlias, authoredPath, authored, entries);
  }
  if (Array.isArray(canonicalValue) && Array.isArray(rawValue)) {
    canonicalValue.forEach((value, index) =>
      projectValue(value, rawValue[index], `${canonicalPath}[${index}]`, `${authoredPath}[${index}]`, authored, entries),
    );
  } else if (isRecord(canonicalValue) && isRecord(rawValue)) {
    for (const [field, value] of Object.entries(canonicalValue)) {
      const rawKey = resolveRawKey(field, rawValue);
      if (rawKey === undefined) continue;
      projectValue(value, rawValue[rawKey], `${canonicalPath}.${field}`, `${authoredPath}.${rawKey}`, authored, entries);
    }
  }
}

function projectEntry(
  canonicalPath: string,
  authoredPath: string,
  authored: Map<string, MutableDslSourceEntry>,
  entries: Map<string, DslSourceMapEntry>,
): void {
  const source = authored.get(authoredPath);
  if (source === undefined) return;
  entries.set(canonicalPath, Object.freeze({
    canonicalPath,
    authoredPath: source.authoredPath,
    ...(source.keySpan !== undefined ? { keySpan: source.keySpan } : {}),
    ...(source.valueSpan !== undefined ? { valueSpan: source.valueSpan } : {}),
    ...(source.contentOffsets !== undefined
      ? { contentOffsets: Object.freeze([...source.contentOffsets]) }
      : {}),
  }));
}

function findRawStep(
  node: FlowNode,
  rawSteps: readonly unknown[],
  preferredIndex: number,
  used: ReadonlySet<number>,
): number | undefined {
  const preferred = rawSteps[preferredIndex];
  if (!used.has(preferredIndex) && rawStepMatches(node, preferred)) {
    return preferredIndex;
  }
  for (let index = 0; index < rawSteps.length; index += 1) {
    if (used.has(index) || !rawStepMatches(node, rawSteps[index])) continue;
    const wrapper = unwrapNode(rawSteps[index]);
    if (wrapper?.value["id"] === node.id) return index;
  }
  return undefined;
}

function rawStepMatches(node: FlowNode, rawStep: unknown): boolean {
  const wrapper = unwrapNode(rawStep);
  return wrapper !== undefined && NODE_KIND_TO_TYPE[wrapper.kind] === node.type;
}

function unwrapNode(
  value: unknown,
): { kind: string; value: Record<string, unknown> } | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const kind = keys[0];
  const nested = kind === undefined ? undefined : value[kind];
  return kind !== undefined && isRecord(nested)
    ? { kind, value: nested }
    : undefined;
}

function resolveRawKey(
  field: string,
  raw: Record<string, unknown>,
): string | undefined {
  const candidates = [
    ...(FIELD_ALIASES[field] ?? []),
    field,
    field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  ];
  return candidates.find((candidate) =>
    Object.prototype.hasOwnProperty.call(raw, candidate),
  );
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
