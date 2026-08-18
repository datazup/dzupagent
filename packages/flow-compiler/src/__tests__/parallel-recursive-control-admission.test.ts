import { describe, expect, it } from "vitest";

import { PipelineDefinitionSchema } from "@dzupagent/core/orchestration";
import type { FlowNode } from "@dzupagent/flow-ast";

import { createFlowCompiler } from "../index.js";

const toolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

const setNode = (id: string): Record<string, unknown> => ({
  type: "set",
  id,
  assign: { [id]: true },
});

function documentWithParallelBranch(
  nested: Record<string, unknown>
): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1",
    id: "parallel-recursive-admission",
    version: 1,
    root: {
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "parallel",
          id: "fork",
          branches: [[nested], [setNode("sibling")]],
        },
        setNode("after"),
      ],
    },
  };
}

async function expectDenied(
  nested: Record<string, unknown>,
  expected: { code: string; nodePath: string }
): Promise<void> {
  const result = await createFlowCompiler({ toolResolver }).compileDocument(
    documentWithParallelBranch(nested)
  );

  expect("errors" in result).toBe(true);
  if (!("errors" in result)) return;
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        stage: 2,
        code: expected.code,
        nodePath: expected.nodePath,
      }),
    ])
  );
}

describe("Packet 24-B parallel recursive-control admission", () => {
  it("retains flat leaf-only parallel branches", async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDocument(
      documentWithParallelBranch({
        type: "sequence",
        id: "flat-sequence",
        nodes: [setNode("first"), setNode("second")],
      })
    );

    expect("errors" in result ? JSON.stringify(result.errors) : "ok").toBe(
      "ok"
    );
    if ("errors" in result) return;
    expect(PipelineDefinitionSchema.safeParse(result.artifact).success).toBe(
      true
    );
  });

  it("admits one direct normal-only conditional branch under parallel", async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDocument(
      documentWithParallelBranch({
        type: "branch",
        id: "nested-branch",
        condition: "true",
        then: [setNode("then")],
        else: [setNode("else")],
      })
    );

    expect("errors" in result ? JSON.stringify(result.errors) : "ok").toBe(
      "ok"
    );
    if ("errors" in result) return;
    expect(PipelineDefinitionSchema.safeParse(result.artifact).success).toBe(
      true
    );
    expect(result.artifact.nodes.filter((node) => node.type === "fork")).toHaveLength(1);
    expect(result.artifact.nodes.filter((node) => node.type === "gate")).toHaveLength(1);
  });

  it.each([
    [
      "try/catch",
      {
        type: "try_catch",
        id: "nested-catch",
        body: [setNode("try")],
        catch: [setNode("catch")],
      },
      "root.nodes[0].branches[0][0]",
    ],
    [
      "nested parallel",
      {
        type: "parallel",
        id: "nested-fork",
        branches: [[setNode("inner-left")], [setNode("inner-right")]],
      },
      "root.nodes[0].branches[0][0]",
    ],
    [
      "for_each",
      {
        type: "for_each",
        id: "nested-items",
        source: "items",
        as: "item",
        body: [setNode("item")],
      },
      "root.nodes[0].branches[0][0]",
    ],
    [
      "loop",
      {
        type: "loop",
        id: "nested-loop",
        condition: "true",
        body: [setNode("iteration")],
      },
      "root.nodes[0].branches[0][0]",
    ],
  ] as const)("denies %s before lowering", async (_name, node, nodePath) => {
    await expectDenied(node, {
      code: "PARALLEL_RECURSIVE_CONTROL_UNSUPPORTED",
      nodePath,
    });
  });

  it("denies terminal completion even when it is hidden inside a branch", async () => {
    await expectDenied(
      {
        type: "branch",
        id: "terminal-branch",
        condition: "true",
        then: [{ type: "complete", id: "stop", result: "done" }],
        else: [setNode("continue")],
      },
      {
        code: "PARALLEL_TERMINAL_UNSUPPORTED",
        nodePath: "root.nodes[0].branches[0][0].then[0]",
      }
    );
  });

  it.each([
    [
      "persona",
      {
        type: "persona",
        id: "persona-boundary",
        personaId: "reviewer",
        body: [setNode("persona-body")],
      },
    ],
    [
      "route",
      {
        type: "route",
        id: "route-boundary",
        strategy: "capability",
        tags: ["review"],
        body: [setNode("route-body")],
      },
    ],
  ] as const)("denies %s suspension ownership", async (_name, node) => {
    await expectDenied(node, {
      code: "PARALLEL_SUSPENSION_UNSUPPORTED",
      nodePath: "root.nodes[0].branches[0][0]",
    });
  });

  it("preserves the exact nested interaction diagnostic", async () => {
    await expectDenied(
      {
        type: "try_catch",
        id: "interaction-catch",
        body: [
          {
            type: "clarification",
            id: "question",
            question: "Which path?",
            outputKey: "answer",
          },
        ],
        catch: [setNode("recover")],
      },
      {
        code: "PARALLEL_INTERACTION_UNSUPPORTED",
        nodePath: "root.nodes[0].branches[0][0].body[0]",
      }
    );
  });

  it("denies a parallel body whose branch failures would bypass an authored catch", async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDocument({
      dsl: "dzupflow/v1",
      id: "parallel-catch-propagation",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "try_catch",
            id: "outer-catch",
            body: [
              {
                type: "parallel",
                id: "fork",
                branches: [[setNode("left")], [setNode("right")]],
              },
            ],
            catch: [setNode("recover")],
          },
        ],
      },
    });

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 2,
          code: "PARALLEL_ERROR_PROPAGATION_UNSUPPORTED",
          nodePath: "root.nodes[0].body[0]",
        }),
      ])
    );
  });

  it("applies the exact admission through raw-flow and DSL frontends", async () => {
    const compiler = createFlowCompiler({ toolResolver });
    const document = documentWithParallelBranch({
      type: "branch",
      id: "nested-branch",
      condition: "true",
      then: [setNode("then")],
      else: [setNode("else")],
    });
    const rawFlow = document.root as FlowNode;
    const dsl = [
      "dsl: dzupflow/v1",
      "id: recursive-parallel-dsl",
      "version: 1",
      "steps:",
      "  - parallel:",
      "      id: fork",
      "      branches:",
      "        first:",
      "          - if:",
      "              id: nested-branch",
      '              condition: "true"',
      "              then:",
      "                - set:",
      "                    id: then",
      "                    assign:",
      "                      then: true",
      "              else:",
      "                - set:",
      "                    id: else",
      "                    assign:",
      "                      else: true",
      "        second:",
      "          - set:",
      "              id: sibling",
      "              assign:",
      "                sibling: true",
    ].join("\n");

    const results = [
      await compiler.compile(rawFlow),
      await compiler.compileDsl(dsl),
    ];
    for (const result of results) {
      expect("errors" in result ? JSON.stringify(result.errors) : "ok").toBe(
        "ok"
      );
    }
  });

  it("retains the recursive diagnostic when two parallel children branch", async () => {
    const branch = (id: string) => ({
      type: "branch",
      id,
      condition: "true",
      then: [setNode(`${id}-then`)],
      else: [setNode(`${id}-else`)],
    });
    const result = await createFlowCompiler({ toolResolver }).compileDocument({
      dsl: "dzupflow/v1",
      id: "two-recursive-children",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "parallel",
            id: "fork",
            branches: [[branch("first")], [branch("second")]],
          },
        ],
      },
    });

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 2,
          code: "PARALLEL_RECURSIVE_CONTROL_UNSUPPORTED",
          nodePath: "root.nodes[0].branches[0][0]",
        }),
        expect.objectContaining({
          stage: 2,
          code: "PARALLEL_RECURSIVE_CONTROL_UNSUPPORTED",
          nodePath: "root.nodes[0].branches[1][0]",
        }),
      ])
    );
  });
});
