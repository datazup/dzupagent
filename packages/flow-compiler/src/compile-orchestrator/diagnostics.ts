/**
 * @dzupagent/flow-compiler — compile diagnostics + telemetry helpers (internal).
 *
 * Pure, dependency-light helpers shared across the compile pipeline
 * ({@link ../compile-orchestrator/pipeline}) and the document/dsl entry points
 * ({@link ../compile-orchestrator/document}). Extracted verbatim from the former
 * monolithic `compile-orchestrator.ts` — structural move only, no behavior
 * change. See MJ-01 deferred-decomposition track.
 *
 * Concerns owned here:
 *   - Diagnostic category counting for result summaries.
 *   - Telemetry-safe node/edge counting on lowered artifacts.
 *   - JSON-pointer → node-path conversion for parse-stage diagnostics.
 *   - Suggestion extraction from resolver error messages.
 *   - Warning construction (lowering + conformance).
 *   - Target-routing reason construction from the route bitmask.
 *   - Default source-kind classification.
 */

import type { ParseInput } from "@dzupagent/flow-ast";

import { FLOW_NODE_CAPABILITY_REGISTRY } from "../capability-manifest.js";
import type { FlowRequirementSummary } from "../capability-manifest.js";

import type {
  CompilationTarget,
  CompilationTargetReason,
  CompilationWarning,
  FlowCompileSourceKind,
} from "../types.js";

export function defaultSourceKind(input: ParseInput): FlowCompileSourceKind {
  return typeof input === "string" ? "flow-json-string" : "flow-object";
}

export function countDiagnosticsByCategory(
  diagnostics: Array<{ category?: string }>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const category = diagnostic.category ?? "internal";
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

/**
 * Count nodes/edges on a lowered artifact for telemetry. Returns zeroes
 * defensively on unexpected shapes — telemetry must never crash a compile.
 */
export function countArtifact(
  target: "skill-chain" | "workflow-builder" | "pipeline" | "planning-dag",
  artifact: unknown
): { nodeCount: number; edgeCount: number } {
  if (artifact === null || typeof artifact !== "object") {
    return { nodeCount: 0, edgeCount: 0 };
  }
  const obj = artifact as { nodes?: unknown; edges?: unknown; steps?: unknown };
  if (target === "skill-chain") {
    return {
      nodeCount: Array.isArray(obj.steps) ? obj.steps.length : 0,
      edgeCount: 0,
    };
  }
  return {
    nodeCount: Array.isArray(obj.nodes) ? obj.nodes.length : 0,
    edgeCount: Array.isArray(obj.edges) ? obj.edges.length : 0,
  };
}

export function jsonPointerToNodePath(pointer: string): string | undefined {
  if (pointer.length === 0) return "root";

  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let path = "root";
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      path += `[${part}]`;
    } else {
      path += `.${part}`;
    }
  }
  return path;
}

export function extractSuggestionFromMessage(message: string): {
  suggestion?: string;
} {
  const match = /Did you mean:\s*"([^"]+)"/.exec(message);
  return match ? { suggestion: match[1] } : {};
}

export function toCompilationWarnings(
  warnings: string[]
): CompilationWarning[] {
  return warnings.map((message) => ({
    stage: 4 as const,
    code: "LOWERING_WARNING",
    category: "lowering",
    message,
  }));
}

export function conformanceWarnings(
  requirements: FlowRequirementSummary
): CompilationWarning[] {
  return requirements.partialNodeKinds.map((kind) => {
    const descriptor = FLOW_NODE_CAPABILITY_REGISTRY[kind];
    return {
      stage: 4,
      code: "PARTIAL_NODE_SUPPORT",
      category: "lowering",
      message:
        `Node type "${kind}" has ${descriptor.lowering} compiler support and requires ` +
        `host capability confirmation.${
          descriptor.notes ? ` ${descriptor.notes}` : ""
        }`,
    };
  });
}

export function targetReasons(
  target: CompilationTarget,
  bitmask: number
): CompilationTargetReason[] {
  const reasons: CompilationTargetReason[] = [];

  if (bitmask === 0 && target === "skill-chain") {
    reasons.push({
      code: "SEQUENTIAL_ONLY",
      message:
        "No branching, suspend, or loop features were detected; routed to skill-chain.",
    });
    return reasons;
  }

  if ((bitmask & (1 << 0)) !== 0) {
    reasons.push({
      code: "BRANCH_PRESENT",
      message: "Branch control flow is present; skill-chain is not sufficient.",
    });
  }
  if ((bitmask & (1 << 1)) !== 0) {
    reasons.push({
      code: "PARALLEL_PRESENT",
      message:
        "Parallel control flow is present; graph-style lowering is required.",
    });
  }
  if ((bitmask & (1 << 2)) !== 0) {
    reasons.push({
      code: "SUSPEND_PRESENT",
      message: "Suspend-capable nodes are present; routed beyond skill-chain.",
    });
  }
  if ((bitmask & (1 << 3)) !== 0) {
    reasons.push({
      code: "FOR_EACH_PRESENT",
      message: "Loop semantics are present; routed to pipeline.",
    });
  }
  if ((bitmask & (1 << 4)) !== 0) {
    reasons.push({
      code: "RUNTIME_LEAF_PRESENT",
      message:
        "Runtime-executed leaf nodes are present; routed to planning-dag.",
    });
  }

  return reasons;
}
