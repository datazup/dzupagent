import { describe, expect, it } from "vitest";
import { parseDslToDocument, validateDocument } from "@dzupagent/flow-dsl";
import { checkOutputKeyUniqueness } from "@dzupagent/flow-ast";
import type { PipelineDefinition } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { createFlowCompiler } from "../index.js";
import { PipelineRuntime } from "../../../agent/src/pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../../../agent/src/pipeline/in-memory-checkpoint-store.js";

const source = `dsl: dzupflow/v1
id: conditional-items
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
      id: done
      assign:
        finished: true
`;
describe("authored for_each branch public runtime", () => {
  it("parses, validates, compiles and executes only the selected branch", async () => {
    const parsed = parseDslToDocument(source);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(validateDocument(parsed.document).valid).toBe(true);
    expect(checkOutputKeyUniqueness(parsed.document.root)).toEqual([]);
    const compiled = await createFlowCompiler({ toolResolver: { resolve: () => null, listAvailable: () => [] } }).compileDocument(parsed.document);
    expect("errors" in compiled ? compiled.errors : []).toEqual([]);
    if ("errors" in compiled) throw new Error("fixture must compile");
    const definition = compiled.artifact as PipelineDefinition;
    const seen: string[] = [];
    const store = new InMemoryPipelineCheckpointStore();
    const predicates = Object.fromEntries(definition.edges.filter((edge) => edge.type === "conditional").map((edge) => [edge.predicateName, (state: Record<string, unknown>) => Number(state.item) % 2 === 0]));
    const result = await new PipelineRuntime({ definition, predicates, checkpointStore: store,
      onEvent: (event) => {
        if (event.type === "pipeline:node_completed") {
          const authoredId = definition.nodes.find((node) => node.id === event.nodeId)?.source?.nodeId;
          if (authoredId) seen.push(authoredId);
        }
      },
      nodeExecutor: async (id) => ({ nodeId: id, output: null, durationMs: 0 }),
    }).execute({ items: [0, 1, 2] });
    expect(result.state, result.error).toBe("completed");
    expect(seen.sort()).toEqual(["done", "no", "yes", "yes"]);
    expect((await store.load(result.runId))?.state.answers).toEqual(["accepted", "rejected", "accepted"]);

  });
});
