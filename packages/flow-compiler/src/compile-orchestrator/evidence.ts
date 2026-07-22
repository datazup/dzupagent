/**
 * @dzupagent/flow-compiler — compile evidence + source hashing (internal).
 *
 * Owns construction of the `FlowCompileEvidence` record attached to a
 * successful compile, plus the deterministic source-hashing used to key it.
 * Extracted verbatim from the former monolithic `compile-orchestrator.ts` —
 * structural move only, no behavior change. See MJ-01 decomposition track.
 */

import { createHash } from "node:crypto";
import type { FlowNode } from "@dzupagent/flow-ast";

import { collectFlowArtifactMetadata } from "../flow-artifact-metadata.js";

import type {
  CompileInvocationOptions,
  CompilationTarget,
  FlowCompileEvidence,
  FlowCompileSourceKind,
  FlowCompileFragmentEvidence,
  FlowCompileSubflowEvidence,
} from "../types.js";

export function hashSource(source: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(source))
    .digest("hex")}`;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "function") return JSON.stringify("[Function]");
  if (typeof value === "symbol") return JSON.stringify(value.toString());
  if (typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (seen.has(value)) return JSON.stringify("[Circular]");

  seen.add(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`
    );
  return `{${entries.join(",")}}`;
}

export function buildCompileEvidence(args: {
  ast: FlowNode;
  compileId: string;
  target: CompilationTarget;
  sourceKind: FlowCompileSourceKind;
  sourceHash: string;
  semanticHash: string;
  correlation?: CompileInvocationOptions["correlation"];
  subflows?: FlowCompileSubflowEvidence[];
  fragments?: FlowCompileFragmentEvidence[];
}): FlowCompileEvidence {
  const metadata = collectFlowArtifactMetadata(args.ast);
  const canonicalNodePaths: FlowCompileEvidence["canonicalNodePaths"] = {};
  const canonicalNodeIds = new Set<string>();

  for (const [path, node] of Object.entries(metadata.nodes)) {
    canonicalNodePaths[path] = {
      type: node.type,
      ...(node.id !== undefined ? { id: node.id } : {}),
    };
    if (node.id !== undefined && node.id.length > 0) {
      canonicalNodeIds.add(node.id);
    }
  }

  const eventCorrelationId =
    args.correlation?.eventCorrelationId ?? args.compileId;

  const evidence: FlowCompileEvidence = {
    schema: "dzupagent.flowCompileEvidence/v1",
    sourceKind: args.sourceKind,
    sourceHash: args.sourceHash,
    semanticHash: args.semanticHash,
    compileId: args.compileId,
    canonicalNodeIds: [...canonicalNodeIds].sort(),
    canonicalNodePaths,
    loweredTarget: args.target,
    correlationIds: {
      compileId: args.compileId,
      eventCorrelationId,
      ...(args.correlation?.runId ? { runId: args.correlation.runId } : {}),
    },
  };
  const composition = {
    ...(args.subflows && args.subflows.length > 0
      ? { subflows: args.subflows }
      : {}),
    ...(args.fragments && args.fragments.length > 0
      ? { fragments: args.fragments }
      : {}),
  };
  if (Object.keys(composition).length > 0) {
    evidence.composition = composition;
  }
  return evidence;
}

function isFragmentEvidence(
  value: unknown
): value is FlowCompileFragmentEvidence {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<FlowCompileFragmentEvidence>;
  return (
    typeof item.id === "string" &&
    typeof item.version === "number" &&
    typeof item.namespace === "string" &&
    typeof item.catalogRef === "string" &&
    typeof item.instanceId === "string" &&
    typeof item.invocationPath === "string" &&
    Array.isArray(item.expandedPaths) &&
    item.expandedPaths.every((path) => typeof path === "string") &&
    typeof item.exports === "object" &&
    item.exports !== null &&
    !Array.isArray(item.exports)
  );
}

export function extractFragmentExpansions(
  document: unknown
): FlowCompileFragmentEvidence[] | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const meta = (document as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const expansions = (meta as { fragmentExpansions?: unknown })
    .fragmentExpansions;
  if (!Array.isArray(expansions)) return undefined;
  const filtered = expansions.filter(isFragmentEvidence);
  return filtered.length > 0 ? filtered : undefined;
}
