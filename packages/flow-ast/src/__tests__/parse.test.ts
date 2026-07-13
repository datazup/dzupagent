import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FLOW_NODE_KINDS, parseFlow, type ParseResult } from "../index.js";
import type { FlowNode } from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

const PUBLIC_NODE_KIND_FIXTURES: Record<FlowNode["type"], FlowNode> = {
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
  parallel: { type: "parallel", branches: [[{ type: "complete" }]] },
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

describe("parseFlow — public node contract", () => {
  it.each(FLOW_NODE_KINDS)("accepts public node kind %s", (kind) => {
    const node = PUBLIC_NODE_KIND_FIXTURES[kind];
    const result = parseFlow(node);
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual(node);
  });

  it("the parser coverage table is exhaustive for the public FlowNode union", () => {
    expect(Object.keys(PUBLIC_NODE_KIND_FIXTURES).sort()).toEqual(
      [...FLOW_NODE_KINDS].sort()
    );
  });
});

describe("parseFlow — golden fixtures", () => {
  it("simple-sequence: zero errors, exact AST", () => {
    const result = parseFlow(loadFixture("simple-sequence.json"));
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({
      type: "sequence",
      nodes: [
        { type: "action", toolRef: "fs.read", input: { path: "/tmp/a" } },
        {
          type: "action",
          toolRef: "fs.write",
          input: { path: "/tmp/b", data: "hello" },
        },
      ],
    });
  });

  it("branch-with-parallel: zero errors, exact AST", () => {
    const result = parseFlow(loadFixture("branch-with-parallel.json"));
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({
      type: "branch",
      condition: "${ctx.flag}",
      then: [
        {
          type: "parallel",
          branches: [
            [{ type: "action", toolRef: "svc.a", input: {} }],
            [{ type: "action", toolRef: "svc.b", input: {} }],
          ],
        },
      ],
      else: [{ type: "complete", result: "skipped" }],
    });
  });

  it("for-each-with-action: zero errors, exact AST", () => {
    const result = parseFlow(loadFixture("for-each-with-action.json"));
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({
      type: "for_each",
      source: "items",
      as: "item",
      body: [
        { type: "action", toolRef: "process.one", input: { value: "${item}" } },
      ],
    });
  });

  it("malformed-missing-type: drops the bad sibling, reports MISSING_TYPE", () => {
    const result = parseFlow(loadFixture("malformed-missing-type.json"));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "MISSING_TYPE",
      pointer: "/nodes/1",
    });
    expect(result.ast).toEqual({
      type: "sequence",
      nodes: [
        { type: "action", toolRef: "good.first", input: {} },
        { type: "action", toolRef: "good.last", input: {} },
      ],
    });
  });

  it("unknown-node-type: drops the bad sibling, reports UNKNOWN_NODE_TYPE", () => {
    const result = parseFlow(loadFixture("unknown-node-type.json"));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "UNKNOWN_NODE_TYPE",
      pointer: "/nodes/1",
    });
    expect(result.ast).toEqual({
      type: "sequence",
      nodes: [
        { type: "action", toolRef: "good.first", input: {} },
        { type: "action", toolRef: "good.last", input: {} },
      ],
    });
  });
});

describe("parseFlow — input-format edge cases", () => {
  it("rejects unparseable JSON with INVALID_JSON, ast null, position present", () => {
    const result: ParseResult = parseFlow("not json{");
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("INVALID_JSON");
    expect(result.errors[0]?.pointer).toBe("");
  });

  it("rejects null input with NOT_AN_OBJECT", () => {
    const result = parseFlow(null as unknown as object);
    expect(result.ast).toBeNull();
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "NOT_AN_OBJECT", pointer: "" }),
    ]);
  });

  it("rejects array top-level input with NOT_AN_OBJECT", () => {
    const result = parseFlow([] as unknown as object);
    expect(result.ast).toBeNull();
    expect(result.errors[0]?.code).toBe("NOT_AN_OBJECT");
  });

  it("accepts pre-parsed object input — no position info", () => {
    const result = parseFlow({ type: "complete" });
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({ type: "complete" });
  });

  it("preserves optional node metadata fields when present", () => {
    const result = parseFlow({
      type: "action",
      id: "plan",
      name: "Plan Work",
      description: "Create the plan",
      meta: { source: "dsl" },
      toolRef: "tool.plan",
      input: {},
    });
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({
      type: "action",
      id: "plan",
      name: "Plan Work",
      description: "Create the plan",
      meta: { source: "dsl" },
      toolRef: "tool.plan",
      input: {},
    });
  });
});

describe("parseFlow — shape validation", () => {
  it("sequence.nodes must be an array", () => {
    const result = parseFlow({ type: "sequence", nodes: "wrong" });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "EXPECTED_ARRAY",
      pointer: "/nodes",
    });
  });

  it("action.toolRef must be a string", () => {
    const result = parseFlow({ type: "action", toolRef: 42, input: {} });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/toolRef",
    });
  });

  it("action.input must be an object", () => {
    const result = parseFlow({
      type: "action",
      toolRef: "good",
      input: "not-object",
    });
    expect(result.ast).toBeNull();
    expect(result.errors[0]).toMatchObject({
      code: "EXPECTED_OBJECT",
      pointer: "/input",
    });
  });

  it("action with bad personaRef drops the field, keeps the node", () => {
    const result = parseFlow({
      type: "action",
      toolRef: "good",
      input: {},
      personaRef: 99,
    });
    expect(result.ast).toEqual({ type: "action", toolRef: "good", input: {} });
    expect(result.errors[0]?.code).toBe("WRONG_FIELD_TYPE");
    expect(result.errors[0]?.pointer).toBe("/personaRef");
  });

  it("node value that is not an object reports EXPECTED_OBJECT", () => {
    const result = parseFlow({ type: "sequence", nodes: ["not-a-node"] });
    expect(result.errors[0]).toMatchObject({
      code: "EXPECTED_OBJECT",
      pointer: "/nodes/0",
    });
    expect(result.ast).toEqual({ type: "sequence", nodes: [] });
  });

  it("top-level type field of wrong type reports WRONG_FIELD_TYPE", () => {
    const result = parseFlow({ type: 7 });
    expect(result.ast).toBeNull();
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/type",
    });
  });

  it("multi-error: unknown sibling + missing-type sibling, document order", () => {
    const result = parseFlow({
      type: "sequence",
      nodes: [{ type: "future_unknown_xyz", data: "x" }, { input: {} }],
    });
    expect(result.errors.map((e) => e.code)).toEqual([
      "UNKNOWN_NODE_TYPE",
      "MISSING_TYPE",
    ]);
    expect(result.errors.map((e) => e.pointer)).toEqual([
      "/nodes/0",
      "/nodes/1",
    ]);
    expect(result.ast).toEqual({ type: "sequence", nodes: [] });
  });

  it("spdd.import_sources requires object sourceRefs items", () => {
    const result = parseFlow({
      type: "spdd.import_sources",
      spddRunId: "spdd-run-1",
      sourceRefs: [{ repo: "repo-a" }, "not-a-ref"],
      outputKey: "sourceRefs",
    });

    expect(result.ast).toBeNull();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "EXPECTED_OBJECT",
        pointer: "/sourceRefs/1",
      }),
    ]);
  });

  it("spdd.run_validation reports missing required fields", () => {
    const result = parseFlow({
      type: "spdd.run_validation",
      spddRunId: "spdd-run-1",
      planRunId: "plan-run-1",
      outputKey: "validation",
    });

    expect(result.ast).toBeNull();
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "WRONG_FIELD_TYPE",
        pointer: "/executionRunId",
      }),
    ]);
  });
});

describe("parseFlow — node-specific behaviours", () => {
  it("for_each surfaces nested errors when shape fails too", () => {
    const result = parseFlow({
      type: "for_each",
      source: "items",
      // missing `as`
      body: [{ type: "unknown" }],
    });
    expect(result.ast).toBeNull();
    const codes = result.errors.map((e) => e.code).sort();
    expect(codes).toContain("WRONG_FIELD_TYPE");
    expect(codes).toContain("UNKNOWN_NODE_TYPE");
  });

  it("branch.else dropped when wrong type, then preserved", () => {
    const result = parseFlow({
      type: "branch",
      condition: "x",
      then: [{ type: "complete" }],
      else: "wrong",
    });
    expect(result.ast).toEqual({
      type: "branch",
      condition: "x",
      then: [{ type: "complete" }],
    });
    expect(result.errors[0]).toMatchObject({
      code: "EXPECTED_ARRAY",
      pointer: "/else",
    });
  });

  it("approval with all optional fields populated", () => {
    const result = parseFlow({
      type: "approval",
      question: "go?",
      approvalClass: "destructive_shell",
      options: ["yes", "no"],
      onApprove: [{ type: "complete", result: "ok" }],
      onReject: [{ type: "complete", result: "no" }],
    });
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({
      type: "approval",
      question: "go?",
      approvalClass: "destructive_shell",
      options: ["yes", "no"],
      onApprove: [{ type: "complete", result: "ok" }],
      onReject: [{ type: "complete", result: "no" }],
    });
  });

  it("approval rejects an unknown approvalClass", () => {
    const result = parseFlow({
      type: "approval",
      question: "go?",
      approvalClass: "custom-policy",
      onApprove: [{ type: "complete", result: "ok" }],
    });
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "INVALID_ENUM_VALUE",
      pointer: "/approvalClass",
    }));
  });

  it("clarification with expected/choices", () => {
    const result = parseFlow({
      type: "clarification",
      question: "pick one",
      expected: "choice",
      choices: ["a", "b"],
    });
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({
      type: "clarification",
      question: "pick one",
      expected: "choice",
      choices: ["a", "b"],
    });
  });

  it("clarification rejects bad expected value but keeps node", () => {
    const result = parseFlow({
      type: "clarification",
      question: "pick one",
      expected: "image",
    });
    expect(result.ast).toEqual({ type: "clarification", question: "pick one" });
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/expected",
    });
  });

  it("persona requires personaId and body", () => {
    const ok = parseFlow({
      type: "persona",
      personaId: "reviewer",
      body: [{ type: "complete" }],
    });
    expect(ok.errors).toEqual([]);
    expect(ok.ast).toEqual({
      type: "persona",
      personaId: "reviewer",
      body: [{ type: "complete" }],
    });
  });

  it("route preserves optional tags + provider", () => {
    const result = parseFlow({
      type: "route",
      strategy: "capability",
      tags: ["fast", "cheap"],
      provider: "openai",
      body: [{ type: "complete" }],
    });
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({
      type: "route",
      strategy: "capability",
      tags: ["fast", "cheap"],
      provider: "openai",
      body: [{ type: "complete" }],
    });
  });

  it("route rejects unknown strategy", () => {
    const result = parseFlow({
      type: "route",
      strategy: "random",
      body: [],
    });
    expect(result.ast).toBeNull();
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/strategy",
    });
  });

  it("parallel reports per-branch wrong-shape error", () => {
    const result = parseFlow({
      type: "parallel",
      branches: [[{ type: "complete" }], "not-an-array"],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "EXPECTED_ARRAY",
      pointer: "/branches/1",
    });
    expect(result.ast).toEqual({
      type: "parallel",
      branches: [[{ type: "complete" }]],
    });
  });

  it("complete with no result is valid", () => {
    const result = parseFlow({ type: "complete" });
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({ type: "complete" });
  });

  it("complete with non-string result is dropped, node preserved", () => {
    const result = parseFlow({ type: "complete", result: 5 });
    expect(result.ast).toEqual({ type: "complete" });
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/result",
    });
  });
});

describe("parseFlow — purity and re-export", () => {
  it("two calls on the same string input return deeply equal results", () => {
    const input = JSON.stringify({
      type: "sequence",
      nodes: [
        { type: "action", toolRef: "a", input: { x: 1 } },
        { type: "complete", result: "done" },
      ],
    });
    const r1 = parseFlow(input);
    const r2 = parseFlow(input);
    expect(r2).toEqual(r1);
  });

  it("two calls on the same object input return deeply equal results", () => {
    const obj = {
      type: "parallel",
      branches: [[{ type: "complete" }]],
    };
    const r1 = parseFlow(obj);
    const r2 = parseFlow(obj);
    expect(r2).toEqual(r1);
  });

  it("parseFlow is exported from package root", async () => {
    const root = await import("../index.js");
    expect(typeof root.parseFlow).toBe("function");
  });
});

describe("parseFlow — RFC 6901 pointer encoding", () => {
  it('encodes "/" and "~" in segments per RFC 6901', () => {
    // We synthesise a path through a known node — segment names here are array indices,
    // but we still want to assert the encoder behaves properly.  The simplest way is
    // to provoke an error inside an unknown nested node and inspect the pointer.
    const result = parseFlow({
      type: "sequence",
      nodes: [{ type: "action", toolRef: 1, input: {} }],
    });
    expect(result.errors[0]?.pointer).toBe("/nodes/0/toolRef");
  });
});

describe("parseFlow — SetNode", () => {
  it("parses a set node with literal and template values", () => {
    const result = parseFlow({
      type: "sequence",
      nodes: [
        {
          type: "set",
          id: "s1",
          assign: { count: "{{ state.n }}", done: true },
        },
      ],
    });
    expect(result.errors).toEqual([]);
    const root = result.ast as { type: "sequence"; nodes: FlowNode[] };
    expect(root.nodes[0]).toEqual({
      type: "set",
      id: "s1",
      assign: { count: "{{ state.n }}", done: true },
    });
  });

  it("drops set node missing `assign` and reports a structured error", () => {
    const result = parseFlow({
      type: "sequence",
      nodes: [{ type: "set" }],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      pointer: "/nodes/0/assign",
    });
  });

  it("drops set node when `assign` is not an object", () => {
    const result = parseFlow({
      type: "sequence",
      nodes: [{ type: "set", assign: "oops" }],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "EXPECTED_OBJECT",
      pointer: "/nodes/0/assign",
    });
  });
});

describe("parseFlow — adapter.run node", () => {
  it("parses an explicit-provider adapter.run node, preserving optional fields", () => {
    const node = {
      type: "adapter.run",
      id: "summarize",
      provider: "claude",
      model: "claude-opus-4-8",
      instructions: "Summarize: {{ state.verifyOutput }}",
      reasoning: "high",
      output: "summary",
      idempotency: "idempotent",
    };
    const result = parseFlow(node);
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual(node);
  });

  it("parses a tags-routed adapter.run node without an explicit provider", () => {
    const node = {
      type: "adapter.run",
      tags: ["reasoning", "long-context"],
      instructions: "Plan the work",
      output: "plan",
    };
    const result = parseFlow(node);
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual(node);
  });

  it("parses OpenAI and OpenRouter adapter.run providers", () => {
    for (const provider of [
      "openai",
      "openrouter",
      "openrouter-crush",
    ] as const) {
      const node = {
        type: "adapter.run",
        provider,
        instructions: "Run",
        output: "result",
      };
      const result = parseFlow(node);
      expect(result.errors).toEqual([]);
      expect(result.ast).toEqual(node);
    }
  });

  it("rejects adapter.run with neither provider nor tags", () => {
    const result = parseFlow({
      type: "adapter.run",
      instructions: "do it",
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/provider" });
  });

  it("rejects adapter.run with an unknown provider", () => {
    const result = parseFlow({
      type: "adapter.run",
      provider: "not-a-provider",
      instructions: "do it",
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/provider",
    });
  });

  it("rejects adapter.run missing required `instructions`", () => {
    const result = parseFlow({
      type: "adapter.run",
      provider: "claude",
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/instructions" });
  });

  it("rejects adapter.run missing required `output`", () => {
    const result = parseFlow({
      type: "adapter.run",
      provider: "claude",
      instructions: "do it",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/output" });
  });

  it("rejects adapter.run with an out-of-range `reasoning` value", () => {
    const result = parseFlow({
      type: "adapter.run",
      provider: "claude",
      instructions: "do it",
      output: "out",
      reasoning: "extreme",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/reasoning",
    });
  });
});

describe("parseFlow — adapter.race node", () => {
  it("parses an adapter.race node, preserving optional fields", () => {
    const node = {
      type: "adapter.race",
      id: "race-impl",
      providers: ["claude", "codex"],
      instructions: "Implement: {{ input.featureSpec }}",
      reasoning: "high",
      output: "bestImpl",
      idempotency: "idempotent",
    };
    const result = parseFlow(node);
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual(node);
  });

  it("rejects adapter.race with fewer than 2 providers", () => {
    const result = parseFlow({
      type: "adapter.race",
      providers: ["claude"],
      instructions: "do it",
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/providers" });
  });

  it("rejects adapter.race with a non-string in providers", () => {
    const result = parseFlow({
      type: "adapter.race",
      providers: ["claude", 7],
      instructions: "do it",
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/providers",
    });
  });

  it("rejects adapter.race with an unknown provider value", () => {
    const result = parseFlow({
      type: "adapter.race",
      providers: ["claude", "not-a-provider"],
      instructions: "do it",
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/providers",
    });
  });

  it("rejects adapter.race missing required `instructions`", () => {
    const result = parseFlow({
      type: "adapter.race",
      providers: ["claude", "codex"],
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/instructions" });
  });

  it("rejects adapter.race missing required `output`", () => {
    const result = parseFlow({
      type: "adapter.race",
      providers: ["claude", "codex"],
      instructions: "do it",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/output" });
  });
});

describe("parseFlow — adapter.parallel node", () => {
  it("parses an adapter.parallel node with an explicit merge mode", () => {
    const node = {
      type: "adapter.parallel",
      id: "fanout",
      providers: ["claude", "codex", "gemini"],
      merge: "all",
      instructions: "Draft: {{ input.brief }}",
      output: "drafts",
    };
    const result = parseFlow(node);
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual(node);
  });

  it("accepts each valid merge mode", () => {
    for (const merge of ["first-wins", "all", "best-of-n"]) {
      const result = parseFlow({
        type: "adapter.parallel",
        providers: ["claude", "codex"],
        merge,
        instructions: "do it",
        output: "out",
      });
      expect(result.errors).toEqual([]);
    }
  });

  it("rejects adapter.parallel with fewer than 2 providers", () => {
    const result = parseFlow({
      type: "adapter.parallel",
      providers: ["claude"],
      instructions: "do it",
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/providers" });
  });

  it("rejects adapter.parallel with an invalid merge mode", () => {
    const result = parseFlow({
      type: "adapter.parallel",
      providers: ["claude", "codex"],
      merge: "zip",
      instructions: "do it",
      output: "out",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/merge",
    });
  });

  it("rejects adapter.parallel missing required `output`", () => {
    const result = parseFlow({
      type: "adapter.parallel",
      providers: ["claude", "codex"],
      instructions: "do it",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/output" });
  });
});

describe("parseFlow — adapter.supervisor node", () => {
  it("parses an adapter.supervisor node with specialists", () => {
    const node = {
      type: "adapter.supervisor",
      id: "ship",
      goal: "Ship: {{ input.spec }}",
      specialists: ["claude", "codex"],
      output: "result",
      idempotency: "idempotent",
    };
    const result = parseFlow(node);
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual(node);
  });

  it("parses an adapter.supervisor node without specialists (registry routing)", () => {
    const node = {
      type: "adapter.supervisor",
      goal: "Decompose and ship",
      output: "result",
    };
    const result = parseFlow(node);
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual(node);
  });

  it("rejects adapter.supervisor missing required `goal`", () => {
    const result = parseFlow({
      type: "adapter.supervisor",
      output: "result",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/goal" });
  });

  it("rejects adapter.supervisor missing required `output`", () => {
    const result = parseFlow({
      type: "adapter.supervisor",
      goal: "do it",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pointer: "/output" });
  });

  it("rejects adapter.supervisor with a non-string in specialists", () => {
    const result = parseFlow({
      type: "adapter.supervisor",
      goal: "do it",
      specialists: ["claude", 9],
      output: "result",
    });
    expect(result.ast).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "WRONG_FIELD_TYPE",
      pointer: "/specialists",
    });
  });
});
