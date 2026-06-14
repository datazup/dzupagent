import type {
  FleetContractNetNode,
  FleetDispatchNode,
  FleetGatherNode,
  KnowledgeQueryNode,
  KnowledgeWriteNode,
} from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
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
          `mode must be one of ${[...VALID_MODES].join("|")}`,
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
  message: string,
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

// ---------------------------------------------------------------------------
// Wrapper-key normalizers (dzupflow/v1 DSL form).
//
// These mirror `normalizeWorkerDispatch`: they receive the INNER value object
// of a single-wrapper-key step (`- fleet.dispatch:` etc.) where the node kind
// is carried by the wrapper key, NOT a sibling `type` field. They run the
// unsupported-field guard, normalize the common base, validate the kind's
// required fields, and return a fully-formed node with `type` set. This is the
// form the formatter emits, so format -> parse round-trips losslessly.
// ---------------------------------------------------------------------------

const FLEET_DISPATCH_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "mode",
  "repos",
  "task",
  "on_contract_change",
  "output",
]);

const FLEET_GATHER_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "source",
  "strategy",
  "output",
]);

const FLEET_CONTRACT_NET_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "repos",
  "task",
  "output",
]);

const KNOWLEDGE_WRITE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "scope",
  "entry",
]);

const KNOWLEDGE_QUERY_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "filter",
  "output",
]);

function isReposRef(value: unknown): value is FleetDispatchNode["repos"] {
  return typeof value === "string" || Array.isArray(value);
}

export function normalizeFleetDispatch(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): FleetDispatchNode {
  reportUnsupportedFields(raw, FLEET_DISPATCH_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  let mode: FleetDispatchNode["mode"] = "supervisor";
  if (typeof raw.mode === "string" && VALID_MODES.has(raw.mode)) {
    mode = raw.mode as FleetDispatchNode["mode"];
  } else {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_ENUM_VALUE,
      message: `fleet.dispatch.mode must be one of ${[...VALID_MODES].join(
        "|",
      )}`,
      path: `${path}.mode`,
    });
  }

  if (!isReposRef(raw.repos)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "fleet.dispatch.repos is required (string or array)",
      path: `${path}.repos`,
    });
  }
  if (raw.task === undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "fleet.dispatch.task is required",
      path: `${path}.task`,
    });
  }

  const node: FleetDispatchNode = {
    type: "fleet.dispatch",
    ...base,
    mode,
    repos: isReposRef(raw.repos) ? raw.repos : "",
    task: raw.task,
  };
  if (typeof raw.on_contract_change === "string")
    node.on_contract_change = raw.on_contract_change;
  if (typeof raw.output === "string") node.output = raw.output;
  return node;
}

export function normalizeFleetGather(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): FleetGatherNode {
  reportUnsupportedFields(raw, FLEET_GATHER_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const source = typeof raw.source === "string" ? raw.source : "";
  if (source.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "fleet.gather.source is required (non-empty string)",
      path: `${path}.source`,
    });
  }

  const node: FleetGatherNode = { type: "fleet.gather", ...base, source };
  if (typeof raw.strategy === "string") node.strategy = raw.strategy;
  if (typeof raw.output === "string") node.output = raw.output;
  return node;
}

export function normalizeFleetContractNet(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): FleetContractNetNode {
  reportUnsupportedFields(raw, FLEET_CONTRACT_NET_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  if (!isReposRef(raw.repos)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "fleet.contract-net.repos is required (string or array)",
      path: `${path}.repos`,
    });
  }
  if (raw.task === undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "fleet.contract-net.task is required",
      path: `${path}.task`,
    });
  }

  const node: FleetContractNetNode = {
    type: "fleet.contract-net",
    ...base,
    repos: isReposRef(raw.repos) ? raw.repos : "",
    task: raw.task,
  };
  if (typeof raw.output === "string") node.output = raw.output;
  return node;
}

export function normalizeKnowledgeWrite(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): KnowledgeWriteNode {
  reportUnsupportedFields(raw, KNOWLEDGE_WRITE_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const scope = typeof raw.scope === "string" ? raw.scope : "";
  if (scope.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "knowledge.write.scope is required (non-empty string)",
      path: `${path}.scope`,
    });
  }
  if (raw.entry === undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "knowledge.write.entry is required",
      path: `${path}.entry`,
    });
  }

  return {
    type: "knowledge.write",
    ...base,
    scope,
    entry: raw.entry,
  };
}

export function normalizeKnowledgeQuery(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): KnowledgeQueryNode {
  reportUnsupportedFields(raw, KNOWLEDGE_QUERY_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  let filter: Record<string, unknown> | undefined;
  if (raw.filter === undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "knowledge.query.filter is required (object)",
      path: `${path}.filter`,
    });
  } else {
    // Reports INVALID_NODE_SHAPE for a present-but-non-object filter.
    filter = normalizeObject(raw.filter, `${path}.filter`, diagnostics);
  }

  const output = typeof raw.output === "string" ? raw.output : "";
  if (output.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "knowledge.query.output is required (non-empty string)",
      path: `${path}.output`,
    });
  }

  return {
    type: "knowledge.query",
    ...base,
    filter: filter ?? {},
    output,
  };
}
