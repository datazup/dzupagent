/**
 * DSL-06 field-reachability matrix, generated from the registries:
 * `FLOW_NODE_KINDS` (kind axis) x `FLOW_EXECUTION_CONTRACT_FIELDS` (field
 * axis), judged by the fail-closed round-trip oracle
 * `formatDocumentToDslChecked` (normalize -> parse -> validate -> print ->
 * reparse -> loss diff).
 *
 * The matrix does not assume the codec is complete — it MEASURES it. Kinds
 * or (kind, field) pairs that do not round-trip today are pinned in the
 * KNOWN_* debt registers below. The registers are shrink-only ratchets: a
 * new entry means a regression (fail), a fixed entry must be deleted
 * (stale-entry check fails otherwise). DSL-06's original defect class —
 * "authored, validated, silently dropped" — cannot reappear unlisted.
 *
 * The per-kind minimal fixtures mirror flow-ast's PUBLIC_NODE_KIND_FIXTURES
 * (parse.test.ts); the exhaustiveness pin below catches drift between the
 * two copies.
 */
import { describe, expect, it } from "vitest";
import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";
import {
  FLOW_EXECUTION_CONTRACT_FIELDS,
  FLOW_NODE_KINDS,
} from "@dzupagent/flow-ast";

import { formatDocumentToDslChecked } from "../src/format-dsl.js";

const MATRIX_NODE_FIXTURES: Record<FlowNode["type"], FlowNode> = {
  sequence: { type: "sequence", nodes: [{ type: "complete" }] },
  action: { type: "action", toolRef: "tool.run", input: {} },
  for_each: {
    type: "for_each",
    source: "items",
    as: "item",
    body: [{ type: "complete" }],
  },
  branch: { type: "branch", condition: "ok", then: [{ type: "complete" }] },
  approval: {
    type: "approval",
    question: "go?",
    onApprove: [{ type: "complete" }],
  },
  clarification: { type: "clarification", question: "need input?" },
  persona: {
    type: "persona",
    personaId: "reviewer",
    body: [{ type: "complete" }],
  },
  route: {
    type: "route",
    strategy: "fixed-provider",
    provider: "openai",
    body: [{ type: "complete" }],
  },
  // Two branches on purpose: `normalizeParallel` rejects a single-branch
  // parallel (INVALID_NODE_SHAPE), so a one-branch fixture would fail the
  // round trip for a fixture-validity reason rather than a codec-loss one.
  parallel: {
    type: "parallel",
    branches: [[{ type: "complete" }], [{ type: "complete" }]],
  },
  complete: { type: "complete", result: "done" },
  spawn: {
    type: "spawn",
    templateRef: "templates.codegen",
    input: { task: "build" },
    waitForCompletion: true,
  },
  classify: {
    type: "classify",
    prompt: "classify request",
    choices: ["bug", "feature"],
    outputKey: "intent",
    defaultChoice: "bug",
  },
  emit: { type: "emit", event: "flow.completed", payload: { ok: true } },
  memory: {
    type: "memory",
    operation: "write",
    tier: "session",
    key: "intent",
    valueExpr: "${intent}",
  },
  set: { type: "set", assign: { count: "{{ state.n }}", done: true } },
  checkpoint: {
    type: "checkpoint",
    label: "after-plan",
    captureOutputOf: "plan",
  },
  restore: {
    type: "restore",
    checkpointLabel: "after-plan",
    onNotFound: "skip",
  },
  try_catch: {
    type: "try_catch",
    body: [{ type: "complete" }],
    catch: [{ type: "complete" }],
  },
  loop: { type: "loop", condition: "${running}", body: [{ type: "complete" }] },
  http: { type: "http", url: "https://example.com/api", method: "GET" },
  wait: { type: "wait", durationMs: 1000 },
  subflow: { type: "subflow", flowRef: "my-subflow-id" },
  prompt: { type: "prompt", userPrompt: "Summarize the diff." },
  return_to: {
    type: "return_to",
    targetId: "attempt-repair",
    condition: "{{ state.needsRetry }}",
  },
  agent: {
    type: "agent",
    agentId: "planner",
    instructions: "Plan the task",
    output: { key: "plan", schemaRef: "plan.v1" },
  },
  validate: {
    type: "validate",
    commands: [{ command: "yarn typecheck" }],
  },
  "worker.dispatch": {
    type: "worker.dispatch",
    dispatchId: "build-dashboard",
    provider: "claude",
    instructions: "Build the dashboard feature",
    outputKey: "workerResult",
  },
  "fleet.dispatch": {
    type: "fleet.dispatch",
    mode: "fan-out",
    repos: ["repo-a", "repo-b"],
    task: { run: "yarn test" },
  },
  "fleet.gather": {
    type: "fleet.gather",
    source: "fleet.dispatch",
  },
  "fleet.contract-net": {
    type: "fleet.contract-net",
    repos: ["repo-a"],
    task: { run: "yarn build" },
  },
  "knowledge.write": {
    type: "knowledge.write",
    scope: "project",
    entry: { key: "plan", value: "do stuff" },
  },
  "knowledge.query": {
    type: "knowledge.query",
    filter: { scope: "project" },
    output: "knowledgeResults",
  },
  "shell.run": {
    type: "shell.run",
    command: "node --test scripts/mpco/*.test.mjs",
    output: "shellResult",
    effectClass: "code_change",
    idempotency: "at-least-once",
  },
  "evidence.write": {
    type: "evidence.write",
    source: "{{ state.shellResult }}",
    output: "evidenceRef",
    redact: true,
  },
  "validate.schema": {
    type: "validate.schema",
    source: "{{ state.summary }}",
    schema: { type: "object" },
    output: "schemaResult",
  },
  "adapter.run": {
    type: "adapter.run",
    provider: "claude",
    instructions: "Summarize the verification output: {{ state.verifyOutput }}",
    output: "summary",
  },
  "adapter.race": {
    type: "adapter.race",
    providers: ["claude", "codex"],
    instructions: "Implement: {{ input.featureSpec }}",
    output: "bestImpl",
  },
  "adapter.parallel": {
    type: "adapter.parallel",
    providers: ["claude", "codex"],
    instructions: "Draft: {{ input.brief }}",
    output: "drafts",
  },
  "adapter.supervisor": {
    type: "adapter.supervisor",
    goal: "Ship the feature end to end",
    output: "result",
  },
  "spdd.import_sources": {
    type: "spdd.import_sources",
    spddRunId: "run-1",
    sourceRefs: [],
    outputKey: "importedSources",
  },
  "spdd.build_source_pack": {
    type: "spdd.build_source_pack",
    spddRunId: "run-1",
    sourceRefsKey: "importedSources",
    outputKey: "sourcePack",
  },
  "spdd.run_analysis": {
    type: "spdd.run_analysis",
    spddRunId: "run-1",
    planArtifactId: "artifact-1",
    outputKey: "analysisResult",
  },
  "spdd.generate_canvas": {
    type: "spdd.generate_canvas",
    spddRunId: "run-1",
    promptAssetVersionId: "ver-1",
    outputKey: "canvasResult",
  },
  "spdd.validate_canvas": {
    type: "spdd.validate_canvas",
    spddRunId: "run-1",
    promptAssetVersionId: "ver-1",
    outputKey: "canvasValidation",
  },
  "spdd.review_canvas": {
    type: "spdd.review_canvas",
    spddRunId: "run-1",
    promptAssetVersionId: "ver-1",
    outputKey: "canvasReview",
  },
  "spdd.project_plan": {
    type: "spdd.project_plan",
    spddRunId: "run-1",
    promptAssetVersionId: "ver-1",
    outputKey: "planResult",
  },
  "spdd.arm_dispatch": {
    type: "spdd.arm_dispatch",
    spddRunId: "run-1",
    planRunId: "plan-1",
    outputKey: "dispatchResult",
  },
  "spdd.run_validation": {
    type: "spdd.run_validation",
    spddRunId: "run-1",
    planRunId: "plan-1",
    executionRunId: "exec-1",
    outputKey: "validationResult",
  },
  "spdd.collect_proof": {
    type: "spdd.collect_proof",
    spddRunId: "run-1",
    planRunId: "plan-1",
    outputKey: "proofResult",
  },
  "spdd.scan_drift": {
    type: "spdd.scan_drift",
    spddRunId: "run-1",
    promptAssetVersionId: "ver-1",
    outputKey: "driftResult",
  },
  "spdd.create_sync_proposal": {
    type: "spdd.create_sync_proposal",
    spddRunId: "run-1",
    driftFindingIdsKey: "driftResult",
    outputKey: "syncProposal",
  },
  "spdd.agent_swarm": {
    type: "spdd.agent_swarm",
    spddRunId: "run-1",
    subTasks: [{ role: "review", input: { artifactRef: "artifact-1" } }],
    outputKey: "swarmResult",
  },
};

/** A defined sample per contract field (varies the accepting dimension). */
const CONTRACT_FIELD_SAMPLES: Record<string, unknown> = {
  effectClass: "compute",
  idempotency: "at-least-once",
  resumePoint: true,
};

/**
 * Canonical documents require a non-empty id on every node; the mirrored
 * flow-ast fixtures are low-level (id optional). Deep-assign deterministic
 * ids without touching the shared fixture shapes.
 */
const CHILD_LIST_KEYS = [
  "nodes",
  "body",
  "then",
  "else",
  "onApprove",
  "onReject",
  "catch",
] as const;

function withIds(node: FlowNode, path: string): FlowNode {
  const copy: Record<string, unknown> = { ...node };
  if (typeof copy.id !== "string" || copy.id.length === 0) {
    copy.id = `id-${path}`;
  }
  for (const key of CHILD_LIST_KEYS) {
    const list = copy[key];
    if (Array.isArray(list)) {
      copy[key] = list.map((child, idx) =>
        withIds(child as FlowNode, `${path}-${key}${idx}`)
      );
    }
  }
  if (Array.isArray(copy.branches)) {
    copy.branches = copy.branches.map((branch, bIdx) =>
      Array.isArray(branch)
        ? branch.map((child, idx) =>
            withIds(child as FlowNode, `${path}-b${bIdx}n${idx}`)
          )
        : branch
    );
  }
  return copy as FlowNode;
}

function docWith(node: FlowNode): FlowDocumentV1 {
  return {
    dsl: "dzupflow/v1",
    id: "matrix-fixture",
    version: 1,
    root: { type: "sequence", id: "root", nodes: [node] },
  } as FlowDocumentV1;
}

interface MatrixOutcome {
  ok: boolean;
  lossPaths: string[];
}

function roundTrip(node: FlowNode): MatrixOutcome {
  const result = formatDocumentToDslChecked(docWith(withIds(node, "n0")));
  return result.ok
    ? { ok: true, lossPaths: [] }
    : { ok: false, lossPaths: result.lossPaths };
}

// ---------------------------------------------------------------------------
// Debt registers (shrink-only). Measured 2026-08-06; each entry is a REAL,
// currently-lossy surface pinned so it can only be closed deliberately.
// ---------------------------------------------------------------------------

/** Kinds whose minimal fixture does not round-trip at all yet. */
const KNOWN_LOSSY_KINDS: Partial<Record<FlowNode["type"], true>> = {
  // Measured 2026-08-06: no spdd.* kind survives the round trip — the
  // formatter/normalizer pair does not carry the spdd field tails yet.
  // Closing these is registry work (F-R1 follow-up), one kind at a time.
  "spdd.import_sources": true,
  "spdd.build_source_pack": true,
  "spdd.run_analysis": true,
  "spdd.generate_canvas": true,
  "spdd.validate_canvas": true,
  "spdd.review_canvas": true,
  "spdd.project_plan": true,
  "spdd.arm_dispatch": true,
  "spdd.run_validation": true,
  "spdd.collect_proof": true,
  "spdd.scan_drift": true,
  "spdd.create_sync_proposal": true,
  "spdd.agent_swarm": true,
};

/** (kind, contract-field) pairs that do not round-trip yet. */
const KNOWN_LOSSY_CONTRACT_PAIRS: Partial<Record<FlowNode["type"], string[]>> =
  {};

describe("DSL-06 matrix — fixture table integrity", () => {
  it("covers every registered node kind exactly", () => {
    expect(Object.keys(MATRIX_NODE_FIXTURES).sort()).toEqual(
      [...FLOW_NODE_KINDS].sort()
    );
  });
});

describe("DSL-06 matrix — kind reachability (minimal fixture round-trip)", () => {
  it.each([...FLOW_NODE_KINDS])("%s", (kind) => {
    const outcome = roundTrip(MATRIX_NODE_FIXTURES[kind]);
    if (KNOWN_LOSSY_KINDS[kind]) {
      expect(
        outcome.ok,
        `stale debt entry: kind '${kind}' round-trips now — delete it from KNOWN_LOSSY_KINDS`
      ).toBe(false);
    } else {
      expect(outcome.ok, outcome.lossPaths.join(", ")).toBe(true);
    }
  });
});

describe("DSL-06 matrix — execution-contract fields per kind", () => {
  const cases = [...FLOW_NODE_KINDS].flatMap((kind) =>
    FLOW_EXECUTION_CONTRACT_FIELDS.map((spec) => [kind, spec.field] as const)
  );

  it.each(cases)("%s.%s", (kind, field) => {
    if (KNOWN_LOSSY_KINDS[kind]) return; // kind itself is still lossy
    const fixture = {
      ...MATRIX_NODE_FIXTURES[kind],
      [field]: CONTRACT_FIELD_SAMPLES[field],
    } as FlowNode;
    const outcome = roundTrip(fixture);
    if (KNOWN_LOSSY_CONTRACT_PAIRS[kind]?.includes(field)) {
      expect(
        outcome.ok,
        `stale debt entry: '${kind}.${field}' round-trips now — delete it from KNOWN_LOSSY_CONTRACT_PAIRS`
      ).toBe(false);
    } else {
      expect(outcome.ok, outcome.lossPaths.join(", ")).toBe(true);
    }
  });
});
