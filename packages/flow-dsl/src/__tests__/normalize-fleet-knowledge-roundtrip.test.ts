/**
 * YAML round-trip coverage for fleet.* and knowledge.* nodes.
 *
 * Regression: the formatter used to emit these five kinds in the flat
 * `- type: <kind>` form with sibling field lines, which the mini-yaml subset
 * parser cannot consume (it does not read sibling keys after an inline first
 * entry), so format -> parse failed with INVALID_YAML_SUBSET. The formatter now
 * emits the nested single-wrapper-key form (`- fleet.dispatch:` with children),
 * matching worker.dispatch/action, and the normalizer routes the wrapper key to
 * a dedicated per-kind normalizer. These tests prove format -> parse is now
 * lossless for each kind.
 */
import { describe, expect, it } from "vitest";

import { canonicalizeDsl } from "../canonicalize-dsl.js";
import { formatDocumentToDsl } from "../format-dsl.js";
import type {
  FleetContractNetNode,
  FleetDispatchNode,
  FleetGatherNode,
  FlowDocumentV1,
  FlowNode,
  KnowledgeQueryNode,
  KnowledgeWriteNode,
} from "@dzupagent/flow-ast";

function wrap(node: FlowNode): FlowDocumentV1 {
  return {
    dsl: "dzupflow/v1",
    id: "fleet-flow",
    version: 1,
    root: { type: "sequence", id: "root", nodes: [node] },
  };
}

function roundTrip(node: FlowNode): {
  ok: boolean;
  diagnostics: unknown[];
  node: FlowNode | undefined;
} {
  const yaml = formatDocumentToDsl(wrap(node));
  const result = canonicalizeDsl(yaml);
  return {
    ok: result.ok,
    diagnostics: result.diagnostics,
    node: result.document?.root.nodes[0],
  };
}

describe("fleet.* / knowledge.* — YAML round-trip", () => {
  it("preserves a full fleet.dispatch node", () => {
    const original: FleetDispatchNode = {
      type: "fleet.dispatch",
      id: "dispatch-1",
      mode: "supervisor",
      repos: ["repo-a", "repo-b"],
      task: { goal: "ship feature", priority: 1 },
      on_contract_change: "rebuild",
      output: "fleetResult",
    };
    const result = roundTrip(original);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.node).toEqual(original);
  });

  it("preserves a fleet.dispatch node with a string repos + string task", () => {
    const original: FleetDispatchNode = {
      type: "fleet.dispatch",
      id: "dispatch-2",
      mode: "fan-out",
      repos: "mono-repo",
      task: "run the audit",
    };
    const result = roundTrip(original);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.node).toEqual(original);
  });

  it("preserves a fleet.gather node", () => {
    const original: FleetGatherNode = {
      type: "fleet.gather",
      id: "gather-1",
      source: "fleetResult",
      strategy: "merge",
      output: "gathered",
    };
    const result = roundTrip(original);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.node).toEqual(original);
  });

  it("preserves a fleet.contract-net node", () => {
    const original: FleetContractNetNode = {
      type: "fleet.contract-net",
      id: "contract-1",
      repos: ["repo-x", "repo-y"],
      task: { bid: "lowest" },
      output: "awarded",
    };
    const result = roundTrip(original);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.node).toEqual(original);
  });

  it("preserves a knowledge.write node", () => {
    const original: KnowledgeWriteNode = {
      type: "knowledge.write",
      id: "kwrite-1",
      scope: "tenant",
      entry: { key: "lesson", value: "always round-trip" },
    };
    const result = roundTrip(original);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.node).toEqual(original);
  });

  it("preserves a knowledge.query node", () => {
    const original: KnowledgeQueryNode = {
      type: "knowledge.query",
      id: "kquery-1",
      filter: { scope: "tenant", topic: "deploys" },
      output: "knowledgeHits",
    };
    const result = roundTrip(original);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.node).toEqual(original);
  });
});
