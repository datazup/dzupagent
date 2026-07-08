import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PipelineDefinition, LoopNode } from "@dzupagent/core/pipeline";
import type {
  FlowFragmentV1,
  ResolvedTool,
  ToolResolver,
} from "@dzupagent/flow-ast";
import {
  createFragmentRegistry,
  parseDslToDocument,
  parseYamlSubset,
} from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../flow-dsl/src/__tests__/fixtures/golden-expansion/for-each-aggregate-export"
);

function readFixture(fileName: string): string {
  return readFileSync(join(fixtureDir, fileName), "utf8");
}

function makeResolver(refs: string[]): ToolResolver {
  const map = new Map<string, ResolvedTool>();
  for (const ref of refs) {
    map.set(ref, {
      ref,
      kind: "skill",
      inputSchema: { type: "object" },
      handle: { skillId: ref },
    });
  }
  return {
    resolve(ref: string): ResolvedTool | null {
      return map.get(ref) ?? null;
    },
    listAvailable(): string[] {
      return [...map.keys()];
    },
  };
}

describe("compileDocument — fragment for_each runtime contract", () => {
  it("compiles the aggregate-export DSL fixture into a LoopNode.forEach contract", async () => {
    const fragmentDefinitions = parseYamlSubset(readFixture("fragments.yaml"));
    expect(fragmentDefinitions.ok).toBe(true);
    if (!fragmentDefinitions.ok) return;

    const registry = createFragmentRegistry([
      fragmentDefinitions.value as FlowFragmentV1,
    ]);
    const parsed = parseDslToDocument(readFixture("invocation.yaml"), {
      fragmentRegistry: registry,
      requirePinnedFragmentUses: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["validate.schema"]),
    });
    const result = await compiler.compileDocument(parsed.document);

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;

    expect(result.target).toBe("pipeline");
    const pipeline = result.artifact as PipelineDefinition;
    const loopNode = pipeline.nodes.find(
      (node): node is LoopNode => node.type === "loop"
    );

    expect(loopNode?.forEach).toEqual({
      source: "batch__validationItems",
      as: "validationItem",
      order: "input",
      collect: {
        from: "batch__validationStatus",
        into: "batch__validationStatuses",
        order: "input",
      },
      concurrency: 1,
      failFast: false,
      empty: {
        body: "skip",
        aggregate: "empty-array",
      },
    });
  });
});
