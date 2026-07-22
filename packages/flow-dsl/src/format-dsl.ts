import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";
import {
  formatScalar,
  pushField,
  quote,
  type FormatContext,
} from "./format-nodes/format-helpers.js";
import { formatStructuralNode } from "./format-nodes/format-structural-nodes.js";
import { formatInteractionNode } from "./format-nodes/format-interaction-nodes.js";
import { formatAgentNode } from "./format-nodes/format-agent-nodes.js";
import { formatFleetNode } from "./format-nodes/format-fleet-nodes.js";
import { formatSpddNode } from "./format-nodes/format-spdd-nodes.js";

export function formatDocumentToDsl(document: FlowDocumentV1): string {
  const lines: string[] = [];
  pushField(lines, 0, "dsl", "dzupflow/v1");
  pushField(lines, 0, "id", document.id);
  if (document.title) pushField(lines, 0, "title", document.title);
  if (document.description)
    pushField(
      lines,
      0,
      "description",
      document.description.includes("\n") ? "|" : document.description
    );
  if (document.description?.includes("\n")) {
    for (const line of document.description.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  pushField(lines, 0, "version", document.version);
  if (document.inputs && Object.keys(document.inputs).length > 0) {
    lines.push("inputs:");
    for (const [key, spec] of Object.entries(document.inputs)) {
      if (
        spec.required === true &&
        spec.description === undefined &&
        spec.default === undefined
      ) {
        lines.push(`  ${key}: ${spec.type}`);
      } else {
        lines.push(`  ${key}:`);
        lines.push(`    type: ${spec.type}`);
        if (spec.required !== undefined)
          lines.push(`    required: ${String(spec.required)}`);
        if (spec.description !== undefined)
          lines.push(`    description: ${quote(spec.description)}`);
      }
    }
  }
  if (document.defaults && Object.keys(document.defaults).length > 0) {
    lines.push("defaults:");
    if (document.defaults.personaRef)
      lines.push(`  persona: ${document.defaults.personaRef}`);
    if (document.defaults.timeoutMs !== undefined)
      lines.push(`  timeout_ms: ${document.defaults.timeoutMs}`);
    if (document.defaults.retry) {
      lines.push("  retry:");
      lines.push(`    attempts: ${document.defaults.retry.attempts}`);
      if (document.defaults.retry.delayMs !== undefined) {
        lines.push(`    delayMs: ${document.defaults.retry.delayMs}`);
      }
    }
  }
  if (document.tags && document.tags.length > 0) {
    lines.push(`tags: [${document.tags.map(quote).join(", ")}]`);
  }
  if (document.meta && Object.keys(document.meta).length > 0) {
    lines.push("meta:");
    for (const [key, value] of Object.entries(document.meta)) {
      lines.push(`  ${key}: ${formatScalar(value)}`);
    }
  }

  lines.push("steps:");
  for (const node of document.root.nodes) {
    formatNode(lines, node, 1);
  }
  return lines.join("\n");
}

/**
 * Route a single flow node to the formatter for its category. Recursion into
 * child nodes is threaded through the {@link FormatContext} so leaf modules do
 * not import this coordinator (avoiding a circular import).
 */
function formatNode(
  lines: string[],
  node: FlowNode,
  indentLevel: number
): void {
  const ctx: FormatContext = { lines, formatNode };
  switch (node.type) {
    case "action":
    case "branch":
    case "parallel":
    case "for_each":
    case "sequence":
    case "loop":
    case "try_catch":
    case "wait":
    case "return_to":
      formatStructuralNode(ctx, node, indentLevel);
      return;
    case "approval":
    case "clarification":
    case "persona":
    case "route":
    case "complete":
    case "spawn":
    case "classify":
    case "emit":
    case "memory":
    case "set":
    case "checkpoint":
    case "restore":
    case "http":
    case "subflow":
    case "prompt":
      formatInteractionNode(ctx, node, indentLevel);
      return;
    case "agent":
    case "validate":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
      formatAgentNode(ctx, node, indentLevel);
      return;
    case "worker.dispatch":
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.write":
    case "knowledge.query":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
      formatFleetNode(ctx, node, indentLevel);
      return;
    case "spdd.import_sources":
    case "spdd.build_source_pack":
    case "spdd.run_analysis":
    case "spdd.generate_canvas":
    case "spdd.validate_canvas":
    case "spdd.review_canvas":
    case "spdd.project_plan":
    case "spdd.arm_dispatch":
    case "spdd.run_validation":
    case "spdd.collect_proof":
    case "spdd.scan_drift":
    case "spdd.create_sync_proposal":
    case "spdd.agent_swarm":
      formatSpddNode(ctx, node, indentLevel);
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}
