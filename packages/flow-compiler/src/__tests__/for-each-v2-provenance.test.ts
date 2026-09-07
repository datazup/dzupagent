import { describe, expect, it } from "vitest";
import { parseDslToDocument, validateDocument } from "@dzupagent/flow-dsl";
import { checkOutputKeyUniqueness } from "@dzupagent/flow-ast";
import type { FlowNode, ResolvedTool } from "@dzupagent/flow-ast";
import { PipelineDefinitionSchema } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type { PipelineDefinition } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { createFlowCompiler } from "../index.js";
import { lowerPipelineLoop } from "../lower/lower-pipeline-loop.js";
import { PipelineRuntime } from "../../../agent/src/pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../../../agent/src/pipeline/in-memory-checkpoint-store.js";

const source = `dsl: dzupflow/v1
id: conditional-items-provenance
version: 1
steps:
  - for_each:
      id: items
      source: items
      as: item
      concurrency: 2
      collect:
        from: answer
        into: answers
      body:
        - set:
            id: prefix
            assign:
              answer: skipped
        - if:
            id: decide
            condition: isEven
            then:
              - set:
                  id: yes
                  assign:
                    answer: accepted
            else:
              - set:
                  id: no
                  assign:
                    answer: rejected
        - set:
            id: suffix
            assign:
              itemFinished: true
  - set:
      id: done
      assign:
        finished: true
`;

function documentFor(text: string) {
  const parsed = parseDslToDocument(text);
  expect(parsed.diagnostics).toEqual([]);
  if (!parsed.ok) throw new Error("fixture must parse");
  const validation = validateDocument(parsed.document);
  expect(validation.diagnostics).toEqual([]);
  expect(validation.valid).toBe(true);
  if (!validation.valid) throw new Error("fixture must validate");
  expect(checkOutputKeyUniqueness(parsed.document.root)).toEqual([]);
  return parsed.document;
}

const toolResolver = { resolve: () => null, listAvailable: () => [] };

async function compile(text: string, enabled?: boolean) {
  const result = await createFlowCompiler({
    toolResolver,
    ...(enabled !== undefined ? { includeForEachEconomicsV2Provenance: enabled } : {}),
  }).compileDocument(documentFor(text));
  expect("errors" in result ? result.errors : []).toEqual([]);
  if ("errors" in result) throw new Error("fixture must compile");
  return { result, definition: result.artifact as PipelineDefinition };
}

function lower(ast: FlowNode, enabled?: boolean, resolved = new Map<string, ResolvedTool>()) {
  let nextId = 0;
  return lowerPipelineLoop({
    ast, resolved, resolvedPersonas: new Map(), idGen: () => `generated-${nextId++}`,
    ...(enabled !== undefined ? { includeForEachEconomicsV2Provenance: enabled } : {}),
  });
}

describe("opt-in for_each V2 provenance", () => {
  it("maps public DSL loop, gate and leaves to exact authored paths and independent runtime IDs", async () => {
    const { definition } = await compile(source, true);
    expect(PipelineDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(definition.nodes.map((node) => [node.type, node.source])).toEqual([
      ["loop", { kind: "flow-node", path: "root.nodes[0]", nodeType: "for_each", nodeId: "items" }],
      ["tool", { kind: "flow-node", path: "root.nodes[0].body[0]", nodeType: "set", nodeId: "prefix" }],
      ["gate", { kind: "flow-node", path: "root.nodes[0].body[1]", nodeType: "branch", nodeId: "decide" }],
      ["tool", { kind: "flow-node", path: "root.nodes[0].body[1].then[0]", nodeType: "set", nodeId: "yes" }],
      ["tool", { kind: "flow-node", path: "root.nodes[0].body[1].else[0]", nodeType: "set", nodeId: "no" }],
      ["tool", { kind: "flow-node", path: "root.nodes[0].body[2]", nodeType: "set", nodeId: "suffix" }],
      ["tool", { kind: "flow-node", path: "root.nodes[1]", nodeType: "set", nodeId: "done" }],
    ]);
    expect(new Set(definition.nodes.map((node) => node.id)).size).toBe(7);
    for (const node of definition.nodes) expect(node.id).not.toBe(node.source?.nodeId);
    const loop = definition.nodes[0];
    if (loop?.type !== "loop") throw new Error("expected loop");
    expect(loop.bodyNodeIds).toEqual(definition.nodes.slice(1, -1).map((node) => node.id));
    expect(loop.bodyGraph?.entryNodeId).toBe(definition.nodes[1]?.id);
  });

  it("keeps omitted and false profiles byte-identical, with only deliberate control-node source additions when enabled", () => {
    const ast = documentFor(source).root;
    const omitted = lower(ast);
    const disabled = lower(ast, false);
    const enabled = lower(ast, true);
    expect(JSON.stringify(disabled)).toBe(JSON.stringify(omitted));
    expect(omitted.artifact.nodes.filter((node) => node.type === "loop" || node.type === "gate").map((node) => node.source)).toEqual([undefined, undefined]);
    expect(JSON.stringify(enabled.artifact)).not.toBe(JSON.stringify(omitted.artifact));
    const stripped = structuredClone(enabled);
    for (const node of stripped.artifact.nodes) {
      if (node.type === "loop" || node.type === "gate") delete node.source;
    }
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(omitted));
  });

  it.each([undefined, false])("keeps the public compiler default profile disabled (%s)", async (enabled) => {
    const { definition } = await compile(source, enabled);
    expect(definition.nodes.filter((node) => node.type === "loop" || node.type === "gate").map((node) => node.source)).toEqual([undefined, undefined]);
  });

  it("retains structural identities for the raw AST API's optional IDs", () => {
    const { artifact: definition } = lower({
      type: "for_each", source: "items", as: "item", body: [{
        type: "branch", condition: "check", then: [{ type: "set", assign: { ready: true } }],
      }],
    }, true);
    expect(definition.nodes).toHaveLength(3);
    expect(definition.nodes.map((node) => node.source?.path)).toEqual(["root", "root.body[0]", "root.body[0].then[0]"]);
    for (const node of definition.nodes) {
      expect(node.source).not.toHaveProperty("nodeId");
    }
    expect(definition.nodes[0]?.source?.nodeType).toBe("for_each");
    expect(definition.nodes[1]?.source?.nodeType).toBe("branch");
  });

  it("preserves resolved agent/tool class and authored prompt, adapter and local identities", () => {
    const body: FlowNode[] = [
      { type: "action", id: "agent-action", toolRef: "worker", input: {} },
      { type: "action", id: "tool-action", toolRef: "tool", input: {} },
      { type: "prompt", id: "prompt", userPrompt: "Inspect the item." },
      { type: "adapter.run", id: "adapter", provider: "codex", instructions: "Inspect the item.", output: "adapterResult" },
      { type: "set", id: "local", assign: { ready: true } },
      { type: "validate.schema", id: "schema", source: "item", schema: { type: "object" }, output: "valid" },
    ];
    const resolved = new Map<string, ResolvedTool>([
      ["root.body[0]", { ref: "worker", kind: "agent", inputSchema: { type: "object" }, handle: {} }],
      ["root.body[1]", { ref: "tool", kind: "skill", inputSchema: { type: "object" }, handle: {} }],
    ]);
    const { artifact } = lower({ type: "for_each", source: "items", as: "item", body }, true, resolved);
    expect(artifact.nodes.slice(1).map((node) => [node.type, node.source])).toEqual(body.map((node, index) => [
      index === 0 ? "agent" : "tool",
      { kind: "flow-node", path: `root.body[${index}]`, nodeType: node.type, nodeId: node.id },
    ]));
    expect(artifact.nodes[1]).toMatchObject({ type: "agent", agentId: "worker" });
    expect(artifact.nodes[2]).toMatchObject({ type: "tool", toolName: "tool" });
    expect(artifact.nodes[3]).toMatchObject({ type: "tool", toolName: "dzup.runtime.prompt" });
    expect(artifact.nodes[4]).toMatchObject({ type: "tool", toolName: "dzup.runtime.adapter.run" });
  });

  it.each([true, false])("executes multiple items with prefix/suffix and an authored else=%s", async (withElse) => {
    const text = withElse ? source : source.replace(`            else:
              - set:
                  id: no
                  assign:
                    answer: rejected
`, "");
    const { definition, result: compiled } = await compile(text, true);
    const store = new InMemoryPipelineCheckpointStore();
    const seen: string[] = [];
    const predicates = Object.fromEntries(definition.edges.filter((edge) => edge.type === "conditional")
      .map((edge) => [edge.predicateName, (state: Record<string, unknown>) => Number(state.item) % 2 === 0]));
    const result = await new PipelineRuntime({
      definition, predicates, checkpointStore: store,
      onEvent: (event) => {
        if (event.type !== "pipeline:node_completed") return;
        const node = definition.nodes.find((candidate) => candidate.id === event.nodeId);
        if (node?.type === "tool" && node.source?.nodeId) seen.push(node.source.nodeId);
      },
      nodeExecutor: async (id) => ({ nodeId: id, output: null, durationMs: 0 }),
    }).execute({ items: [0, 1, 2] });
    expect(result.state, result.error).toBe("completed");
    expect(seen.sort()).toEqual([
      "done", ...(withElse ? ["no"] : []), "prefix", "prefix", "prefix", "suffix", "suffix", "suffix", "yes", "yes",
    ]);
    expect((await store.load(result.runId))?.state.answers).toEqual(["accepted", withElse ? "rejected" : "skipped", "accepted"]);
    expect(definition.schemaVersion).toBe("1.0.0");
    expect(compiled.requirements.requiredCapabilities.filter((capability) => /economic/i.test(capability))).toEqual([]);
  });

  it("does not enable provenance on the flat target", async () => {
    const { result, definition } = await compile(`dsl: dzupflow/v1
id: flat-branch
version: 1
steps:
  - if:
      id: decide
      condition: check
      then:
        - set:
            id: ready
            assign:
              ready: true
`, true);
    expect(result.target).not.toBe("pipeline");
    expect(definition.nodes.filter((node) => node.type === "gate").map((node) => node.source)).toEqual([undefined]);
  });

  const progressLoop = (progressKey: string): FlowNode => ({
    type: "loop", condition: "check", maxIterations: 2, progressKey,
    typedCondition: {
      schema: "dzupagent.flowTypedCondition/v1",
      expression: { op: "literal", value: true },
    },
    body: [
      { type: "for_each", id: "fanout", source: "items", as: "item", body: [
        { type: "set", id: "progress", assign: { ready: true } },
      ] },
      { type: "branch", id: "decide", condition: "check", then: [
        { type: "set", id: "selected", assign: { selected: true } },
      ] },
    ],
  });

  it.each(["fanout", "decide"])("does not admit a control node as typed-loop progress (%s)", (id) => {
    for (const enabled of [undefined, false, true]) {
      expect(() => lower(progressLoop(id), enabled)).toThrow("must resolve to exactly one executable body node; resolved 0");
    }
  });

  it("keeps existing typed-loop leaf progress bound to the same generated ID", () => {
    const enabled = lower(progressLoop("progress"), true).artifact;
    const disabled = lower(progressLoop("progress"), false).artifact;
    const loop = enabled.nodes[0];
    const oldLoop = disabled.nodes[0];
    if (loop?.type !== "loop" || oldLoop?.type !== "loop") throw new Error("expected typed loops");
    const leaf = enabled.nodes.find((node) => node.source?.nodeId === "progress");
    expect(leaf?.type).toBe("tool");
    expect(loop.typedWhile?.progressKey).toBe(leaf?.id);
    expect(loop.typedWhile?.progressKey).toBe(oldLoop.typedWhile?.progressKey);
  });
});
