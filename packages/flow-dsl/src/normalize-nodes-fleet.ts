import type {
  FleetContractNetNode,
  FleetDispatchNode,
  FleetGatherNode,
  KnowledgeQueryNode,
  KnowledgeWriteNode,
} from "@dzupagent/flow-ast";

import type { DslDiagnostic } from "./types.js";

const FLEET_TYPES = new Set<string>([
  "fleet.dispatch",
  "fleet.gather",
  "fleet.contract-net",
  "knowledge.write",
  "knowledge.query",
]);
const VALID_MODES = new Set<string>([
  "supervisor",
  "contract-net",
  "fan-out",
  "dependency",
]);

/**
 * Result of {@link normalizeFleetNode}.
 *
 * - `ok: true`  — a fleet/knowledge node was recognised and normalised.
 * - `ok: false` — a fleet/knowledge node was recognised but invalid; carries
 *    one or more normalize-phase diagnostics.
 * - `ok: null`  — the input is not a fleet/knowledge node; callers should fall
 *    through to their own handling (e.g. unknown-node-type error).
 *
 * The success branch narrows `node` to the fleet/knowledge subset so callers
 * (and tests) can read discriminant-specific fields such as `mode` after a
 * `result.ok` check plus a `result.node.type` narrowing.
 */
export type NormalizeResult =
  | {
      ok: true;
      node:
        | FleetDispatchNode
        | FleetGatherNode
        | FleetContractNetNode
        | KnowledgeWriteNode
        | KnowledgeQueryNode;
    }
  | { ok: false; diagnostics: DslDiagnostic[] }
  | { ok: null };

/**
 * Standalone normalizer for fleet.* and knowledge.* nodes authored in the flat
 * `{ id, type, ... }` form. Returns `ok: null` for any input that is not a
 * recognised fleet/knowledge node so the document pipeline can fall through to
 * its own unknown-node-type handling.
 */
export function normalizeFleetNode(raw: unknown): NormalizeResult {
  if (raw === null || typeof raw !== "object") return { ok: null };
  const r = raw as Record<string, unknown>;
  const type = r["type"];
  if (typeof type !== "string" || !FLEET_TYPES.has(type)) return { ok: null };
  if (typeof r["id"] !== "string" || r["id"].length === 0) {
    return fail(r, "fleet.missing-id", "node id is required");
  }

  switch (type) {
    case "fleet.dispatch": {
      if (typeof r["mode"] !== "string" || !VALID_MODES.has(r["mode"])) {
        return fail(
          r,
          "fleet.invalid-mode",
          `mode must be one of ${[...VALID_MODES].join("|")}`
        );
      }
      if (r["repos"] === undefined) {
        return fail(r, "fleet.missing-repos", "repos is required");
      }
      if (r["task"] === undefined) {
        return fail(r, "fleet.missing-task", "task is required");
      }
      return { ok: true, node: r as unknown as FleetDispatchNode };
    }
    case "fleet.gather": {
      if (typeof r["source"] !== "string") {
        return fail(r, "fleet.missing-source", "source is required");
      }
      return { ok: true, node: r as unknown as FleetGatherNode };
    }
    case "fleet.contract-net": {
      if (r["repos"] === undefined) {
        return fail(r, "fleet.missing-repos", "repos is required");
      }
      if (r["task"] === undefined) {
        return fail(r, "fleet.missing-task", "task is required");
      }
      return { ok: true, node: r as unknown as FleetContractNetNode };
    }
    case "knowledge.write": {
      if (typeof r["scope"] !== "string") {
        return fail(r, "knowledge.missing-scope", "scope is required");
      }
      if (r["entry"] === undefined) {
        return fail(r, "knowledge.missing-entry", "entry is required");
      }
      return { ok: true, node: r as unknown as KnowledgeWriteNode };
    }
    case "knowledge.query": {
      if (r["filter"] === undefined || typeof r["filter"] !== "object") {
        return fail(r, "knowledge.missing-filter", "filter is required");
      }
      if (typeof r["output"] !== "string") {
        return fail(r, "knowledge.missing-output", "output is required");
      }
      return { ok: true, node: r as unknown as KnowledgeQueryNode };
    }
    default:
      return { ok: null };
  }
}

function fail(
  r: Record<string, unknown>,
  code: string,
  message: string
): NormalizeResult {
  const id = r["id"];
  return {
    ok: false,
    diagnostics: [
      {
        phase: "normalize",
        code,
        message,
        path: `nodes.${typeof id === "string" ? id : "?"}`,
      },
    ],
  };
}
