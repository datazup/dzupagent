import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";
import { parseDslToDocument } from "./parse-dsl.js";
import type { DslDiagnostic } from "./types.js";
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
  pushField(lines, 0, "dsl", document.dsl);
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
        spec.default === undefined &&
        spec.classification === undefined
      ) {
        lines.push(`  ${key}: ${spec.type}`);
      } else {
        lines.push(`  ${key}:`);
        lines.push(`    type: ${spec.type}`);
        if (spec.required !== undefined)
          lines.push(`    required: ${String(spec.required)}`);
        if (spec.description !== undefined)
          lines.push(`    description: ${quote(spec.description)}`);
        if (spec.default !== undefined)
          lines.push(`    default: ${formatScalar(spec.default)}`);
        if (spec.classification !== undefined)
          lines.push(`    classification: ${spec.classification}`);
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

export type FormatDslCheckedResult =
  | { ok: true; dsl: string }
  | {
      ok: false;
      /** Best-effort output; do NOT persist it as a faithful representation. */
      dsl: string;
      /** Document paths whose authored value did not survive format→parse. */
      lossPaths: string[];
      /** Parse/normalize diagnostics from the round-trip, if any. */
      diagnostics: DslDiagnostic[];
    };

/**
 * Fail-closed formatter: formats the document, re-parses the output, and
 * verifies every authored field survived the round trip. Fields the parser
 * adds (normalization defaults) are tolerated; fields the formatter dropped
 * or altered are reported as `lossPaths`. Use this instead of
 * {@link formatDocumentToDsl} anywhere the output is stored as a source of
 * truth (e.g. canonical templates).
 */
export function formatDocumentToDslChecked(
  document: FlowDocumentV1
): FormatDslCheckedResult {
  const dsl = formatDocumentToDsl(document);
  const reparsed = parseDslToDocument(dsl);
  if (reparsed.document === null) {
    return {
      ok: false,
      dsl,
      lossPaths: ["document"],
      diagnostics: [...reparsed.diagnostics],
    };
  }
  const lossPaths: string[] = [];
  collectLossPaths(document, reparsed.document, "document", lossPaths);
  if (lossPaths.length > 0) {
    return { ok: false, dsl, lossPaths, diagnostics: [...reparsed.diagnostics] };
  }
  return { ok: true, dsl };
}

/**
 * One-directional structural diff: every defined value in `original` must be
 * present and equal in `reparsed`; extra reparsed fields are fine. An empty
 * authored array/object matching an absent reparsed field counts as preserved
 * (formatters legitimately omit empty optional containers).
 */
function collectLossPaths(
  original: unknown,
  reparsed: unknown,
  path: string,
  out: string[]
): void {
  if (original === undefined) return;
  if (Array.isArray(original)) {
    if (original.length === 0 && reparsed === undefined) return;
    if (!Array.isArray(reparsed) || reparsed.length !== original.length) {
      out.push(path);
      return;
    }
    original.forEach((item, index) => {
      collectLossPaths(item, reparsed[index], `${path}[${index}]`, out);
    });
    return;
  }
  if (original !== null && typeof original === "object") {
    const entries = Object.entries(original).filter(
      ([, value]) => value !== undefined
    );
    if (entries.length === 0 && reparsed === undefined) return;
    if (
      reparsed === null ||
      typeof reparsed !== "object" ||
      Array.isArray(reparsed)
    ) {
      out.push(path);
      return;
    }
    for (const [key, value] of entries) {
      collectLossPaths(
        value,
        (reparsed as Record<string, unknown>)[key],
        `${path}.${key}`,
        out
      );
    }
    return;
  }
  if (original !== reparsed) out.push(path);
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
