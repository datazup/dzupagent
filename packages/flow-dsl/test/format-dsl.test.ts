import { describe, expect, it } from "vitest";
import type { FlowDocumentV1 } from "@dzupagent/flow-ast";

import {
  formatDocumentToDsl,
  formatDocumentToDslChecked,
} from "../src/format-dsl.js";
import { parseDslToDocument } from "../src/parse-dsl.js";

describe("formatDocumentToDsl", () => {
  it("formats a canonical document deterministically", () => {
    const output = formatDocumentToDsl({
      dsl: "dzupflow/v1",
      id: "flow",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [{ type: "complete", id: "done", result: "ok" }],
      },
    });

    expect(output).toContain("dsl: dzupflow/v1");
    expect(output).toContain("id: flow");
    expect(output).toContain("steps:");
    expect(output).toContain("- complete:");
    expect(output).toContain("id: done");
  });

  it("formats classify.defaultChoice as an explicit default branch", () => {
    const output = formatDocumentToDsl({
      dsl: "dzupflow/v1",
      id: "classify-flow",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "classify",
            id: "pick_tier",
            prompt: "Which implementation tier?",
            choices: ["frontend", "backend", "infra"],
            outputKey: "tier",
            defaultChoice: "infra",
          },
        ],
      },
    });

    expect(output).toContain("- classify:");
    expect(output).toContain("output: tier");
    expect(output).toContain("default: infra");
  });

  it("formats spdd.agent_swarm nodes", () => {
    const output = formatDocumentToDsl({
      dsl: "dzupflow/v1alpha-agent",
      id: "spdd-flow",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "spdd.agent_swarm",
            id: "swarm",
            spddRunId: "run-1",
            subTasks: [
              {
                role: "review",
                personaRef: "reviewer",
                input: { artifactRef: "artifact-1" },
              },
            ],
            outputKey: "swarmResult",
          },
        ],
      },
    });

    expect(output).toContain("- spdd.agent_swarm:");
    expect(output).toContain("spddRunId: run-1");
    expect(output).toContain(
      'subTasks: [{"role":"review","personaRef":"reviewer","input":{"artifactRef":"artifact-1"}}]'
    );
    expect(output).toContain("outputKey: swarmResult");
  });

  it("emits the document dsl version instead of hardcoding dzupflow/v1", () => {
    const output = formatDocumentToDsl({
      dsl: "dzupflow/v1alpha-agent",
      id: "alpha-flow",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [{ type: "complete", id: "done" }],
      },
    });
    expect(output).toContain("dsl: dzupflow/v1alpha-agent");
    expect(output).not.toContain("dsl: dzupflow/v1\n");
  });
});

describe("formatDocumentToDsl round-trip", () => {
  it("round-trips every for_each execution field and loop.progressKey", () => {
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "exec-fields",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "for_each",
            id: "fan_out",
            source: "{{ state.items }}",
            as: "item",
            attachAs: "enriched",
            collect: { from: "result", into: "results" },
            accumulator: { key: "tally", window: 5, initialValue: 0 },
            concurrency: 4,
            failFast: true,
            body: [{ type: "set", id: "mark", assign: { seen: true } }],
          },
          {
            type: "loop",
            id: "retry",
            condition: "{{ state.pending }}",
            maxIterations: 3,
            progressKey: "pending",
            body: [{ type: "set", id: "tick", assign: { pending: false } }],
          },
        ],
      },
    };

    const result = formatDocumentToDslChecked(document);
    expect(result.ok).toBe(true);

    const reparsed = parseDslToDocument(formatDocumentToDsl(document));
    const forEach = reparsed.document?.root.nodes[0];
    expect(forEach).toMatchObject({
      type: "for_each",
      attachAs: "enriched",
      collect: { from: "result", into: "results" },
      accumulator: { key: "tally", window: 5, initialValue: 0 },
      concurrency: 4,
      failFast: true,
    });
    const loop = reparsed.document?.root.nodes[1];
    expect(loop).toMatchObject({
      type: "loop",
      maxIterations: 3,
      progressKey: "pending",
    });
  });

  it("reports lost paths fail-closed instead of returning unfaithful output", () => {
    const document = {
      dsl: "dzupflow/v1",
      id: "lossy",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "action",
            id: "act",
            toolRef: "test.run",
            input: {},
            // The codec has no syntax for unknown vendor keys: the formatter
            // drops them, so the checked formatter must refuse. (effectClass,
            // the previous example here, round-trips since the field registry
            // admits it on every kind.)
            vendorExtension: "not-representable",
          },
        ],
      },
    } as unknown as FlowDocumentV1;

    const result = formatDocumentToDslChecked(document);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.lossPaths).toContain(
      "document.root.nodes[0].vendorExtension"
    );
  });

  it("round-trips multiline prose fields as literal block scalars", () => {
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "multiline-prose",
      description: "Document line one\nDocument line two",
      version: 1,
      inputs: {
        request: {
          type: "string",
          required: true,
          description: "Input line one\nInput line two",
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "approval",
            id: "approve",
            question: "Approve line one?\nApprove line two?",
            onApprove: [
              { type: "complete", id: "approved", result: "approved" },
            ],
            onReject: [
              { type: "complete", id: "rejected", result: "rejected" },
            ],
          },
          {
            type: "clarification",
            id: "clarify",
            question: "Clarify line one?\nClarify line two?",
            outputKey: "clarificationAnswer",
          },
          {
            type: "classify",
            id: "classify",
            prompt: "Classify line one\nClassify line two",
            choices: ["a", "b"],
            outputKey: "class",
          },
          {
            type: "prompt",
            id: "prompt",
            description: "Node line one\nNode line two",
            userPrompt: "User line one\nUser line two",
            systemPrompt: "System line one\nSystem line two",
            outputKey: "promptResult",
          },
          {
            type: "agent",
            id: "agent",
            agentId: "reviewer",
            instructions: "Agent line one\nAgent line two",
            output: { key: "agentResult", schemaRef: "review.v1" },
          },
          {
            type: "adapter.run",
            id: "run",
            provider: "claude",
            systemPrompt: "Run system one\nRun system two",
            instructions: "Run line one\nRun line two",
            output: "runResult",
          },
          {
            type: "adapter.race",
            id: "race",
            providers: ["claude", "codex"],
            systemPrompt: "Race system one\nRace system two",
            instructions: "Race line one\nRace line two",
            output: "raceResult",
          },
          {
            type: "adapter.parallel",
            id: "parallel",
            providers: ["claude", "codex"],
            systemPrompt: "Parallel system one\nParallel system two",
            instructions: "Parallel line one\nParallel line two",
            output: "parallelResult",
          },
          {
            type: "adapter.supervisor",
            id: "supervisor",
            goal: "Goal line one\nGoal line two",
            systemPrompt: "Supervisor system one\nSupervisor system two",
            output: "supervisorResult",
          },
          {
            type: "worker.dispatch",
            id: "worker",
            dispatchId: "worker-dispatch",
            provider: "codex",
            systemPrompt: "Worker system one\nWorker system two",
            instructions: "Worker line one\nWorker line two",
            outputKey: "workerResult",
          },
        ],
      },
    };

    const result = formatDocumentToDslChecked(document);
    if (!result.ok) {
      throw new Error(
        `${result.lossPaths.join(", ")}: ${JSON.stringify(result.diagnostics)}`
      );
    }
    expect(result.ok).toBe(true);
    expect(result.dsl).toContain("userPrompt: |");
    expect(result.dsl).toContain("instructions: |");
    expect(result.dsl).toContain("question: |");
    expect(result.dsl).not.toContain("\\n");
  });

  // Known formatter gaps pinned as expected failures: each test goes red the
  // moment the gap is fixed, forcing the corpus to shrink honestly.
  // CLOSED 2026-08-06 by the `group:` authoring surface: a nested sequence
  // now emits its own `- group:` block instead of splicing its children into
  // the parent list, so the wrapper's type/id/nodes survive the round trip.
  it("round-trips a nested sequence node without flattening it", () => {
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "nested-seq",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "sequence",
            id: "inner",
            nodes: [{ type: "set", id: "s1", assign: { a: 1 } }],
          },
        ],
      },
    };
    expect(formatDocumentToDslChecked(document).ok).toBe(true);
  });

  it.fails("round-trips generic node effectClass", () => {
    const document = {
      dsl: "dzupflow/v1",
      id: "effect",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "action",
            id: "act",
            toolRef: "test.run",
            input: {},
            effectClass: "read_only",
          },
        ],
      },
    } as unknown as FlowDocumentV1;
    expect(formatDocumentToDslChecked(document).ok).toBe(true);
  });
});
