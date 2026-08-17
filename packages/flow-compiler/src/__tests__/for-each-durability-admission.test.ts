import { describe, expect, it, vi } from "vitest";

import type { FlowNode } from "@dzupagent/flow-ast";

import { compileTextInput, createFlowCompiler } from "../index.js";

const resolver = {
  resolve: vi.fn(() => null),
  listAvailable: vi.fn(() => []),
};

const setNode = (id: string): Record<string, unknown> => ({
  type: "set",
  id,
  assign: { [id]: true },
});

function forEachNode(
  body: Record<string, unknown>[] = [setNode("item")],
  concurrency: number | undefined = 1
): Record<string, unknown> {
  return {
    type: "for_each",
    id: "items",
    source: "items",
    as: "item",
    collect: { from: "item", into: "itemResults" },
    body,
    ...(concurrency === undefined ? {} : { concurrency }),
  };
}

function document(node: Record<string, unknown>): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1",
    id: "for-each-durability-admission",
    version: 1,
    root: { type: "sequence", id: "root", nodes: [node] },
  };
}

describe("Packet 24-D for_each durability admission", () => {
  // 24-I: 2 and 8 are admitted now; the rest are still not positive integers.
  it.each([0, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects raw concurrency %s with no artifact or semantic resolution",
    async (concurrency) => {
      resolver.resolve.mockClear();
      const result = await createFlowCompiler({ toolResolver: resolver }).compile(
        forEachNode(undefined, concurrency) as unknown as FlowNode
      );

      expect("errors" in result).toBe(true);
      if (!("errors" in result)) return;
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 2,
            code: "FOR_EACH_CONCURRENCY_UNSUPPORTED",
            nodePath: "root.concurrency",
          }),
        ])
      );
      expect("artifact" in result).toBe(false);
      expect(resolver.resolve).not.toHaveBeenCalled();
    }
  );

  it("applies the exact concurrency denial through document and DSL frontends", async () => {
    const compiler = createFlowCompiler({ toolResolver: resolver });
    const dsl = [
      "dsl: dzupflow/v1",
      "id: for-each-durability-dsl",
      "version: 1",
      "steps:",
      "  - for_each:",
      "      id: items",
      "      source: items",
      "      as: item",
      "      concurrency: 0",
      "      body:",
      "        - set:",
      "            id: item",
      "            assign:",
      "              seen: true",
    ].join("\n");

    const results = [
      await compiler.compileDocument(document(forEachNode(undefined, 0))),
      await compiler.compileDsl(dsl),
    ];
    for (const result of results) {
      expect("errors" in result).toBe(true);
      if (!("errors" in result)) continue;
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 2,
            code: "FOR_EACH_CONCURRENCY_UNSUPPORTED",
          }),
        ])
      );
      expect("artifact" in result).toBe(false);
    }
  });

  it("applies the denial through every compileTextInput branch", async () => {
    const compiler = createFlowCompiler({ toolResolver: resolver });
    const dsl = [
      "dsl: dzupflow/v1",
      "id: for-each-text-dsl",
      "version: 1",
      "steps:",
      "  - for_each:",
      "      id: items",
      "      source: items",
      "      as: item",
      "      concurrency: 0",
      "      collect:",
      "        from: item",
      "        into: itemResults",
      "      body:",
      "        - set:",
      "            id: item",
      "            assign:",
      "              item: true",
    ].join("\n");
    const results = [
      await compileTextInput(compiler, JSON.stringify(forEachNode(undefined, 0))),
      await compileTextInput(
        compiler,
        JSON.stringify(document(forEachNode(undefined, 0)))
      ),
      await compileTextInput(compiler, dsl),
    ];

    for (const result of results) {
      expect("errors" in result).toBe(true);
      if (!("errors" in result)) continue;
      expect(result.errors.map((error) => error.code)).toContain(
        "FOR_EACH_CONCURRENCY_UNSUPPORTED"
      );
      expect("artifact" in result).toBe(false);
    }
  });

  it("applies the denial to every strict-migration source kind", async () => {
    const report = await createFlowCompiler({
      toolResolver: resolver,
    }).analyzeStrictReferenceMigration([
      { id: "flow", kind: "flow", input: forEachNode(undefined, 0) },
      {
        id: "document",
        kind: "document",
        input: document(forEachNode(undefined, 0)),
      },
      {
        id: "dsl",
        kind: "dsl",
        input: [
          "dsl: dzupflow/v1",
          "id: for-each-migration-dsl",
          "version: 1",
          "steps:",
          "  - for_each:",
          "      id: items",
          "      source: items",
          "      as: item",
          "      concurrency: 0",
          "      collect:",
          "        from: item",
          "        into: itemResults",
          "      body:",
          "        - set:",
          "            id: item",
          "            assign:",
          "              item: true",
        ].join("\n"),
      },
    ]);

    expect(report.items).toHaveLength(3);
    for (const item of report.items) {
      expect([
        ...item.compatibilityDiagnostics,
        ...item.strictDiagnostics,
      ].map((diagnostic) => diagnostic.code)).toContain(
        "FOR_EACH_CONCURRENCY_UNSUPPORTED"
      );
    }
  });

  it.each([
    [
      "recursive branch",
      {
        type: "branch",
        id: "decision",
        condition: "true",
        then: [setNode("left")],
        else: [setNode("right")],
      },
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "nested parallel",
      {
        type: "parallel",
        id: "parallel",
        branches: [[setNode("left")], [setNode("right")]],
      },
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "try/catch",
      {
        type: "try_catch",
        id: "attempt",
        body: [setNode("try")],
        catch: [setNode("catch")],
      },
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "nested for_each",
      forEachNode([setNode("nested-item")]),
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "nested loop",
      {
        type: "loop",
        id: "retry",
        condition: "true",
        body: [setNode("retry-item")],
      },
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "subflow",
      { type: "subflow", id: "child", flowRef: "child-flow" },
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "terminal hidden under a branch",
      {
        type: "branch",
        id: "decision",
        condition: "true",
        then: [{ type: "complete", id: "done" }],
        else: [setNode("continue")],
      },
      "FOR_EACH_TERMINAL_UNSUPPORTED",
      "root.body[0].then[0]",
    ],
    [
      "return_to terminal",
      {
        type: "return_to",
        id: "again",
        targetId: "item",
        condition: "true",
      },
      "FOR_EACH_TERMINAL_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "persona suspension",
      {
        type: "persona",
        id: "persona",
        personaId: "reviewer",
        body: [setNode("inside")],
      },
      "FOR_EACH_SUSPENSION_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "wait suspension",
      { type: "wait", id: "wait", durationMs: 100 },
      "FOR_EACH_SUSPENSION_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "interaction",
      {
        type: "clarification",
        id: "question",
        question: "Which item?",
        outputKey: "answer",
      },
      "FOR_EACH_INTERACTION_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "approval interaction",
      {
        type: "approval",
        id: "review",
        question: "Approve?",
        onApprove: [setNode("approved")],
        onReject: [setNode("rejected")],
      },
      "FOR_EACH_INTERACTION_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "zero-lowering body node",
      { type: "checkpoint", id: "snapshot", captureOutputOf: "item" },
      "FOR_EACH_BODY_NODE_UNSUPPORTED",
      "root.body[0]",
    ],
    [
      "deferred fleet body node",
      {
        type: "fleet.dispatch",
        id: "fleet",
        mode: "fan-out",
        repos: ["repo"],
        task: "work",
      },
      "FOR_EACH_BODY_NODE_UNSUPPORTED",
      "root.body[0]",
    ],
  ] as const)("rejects %s before lowering", async (_name, nested, code, path) => {
    const result = await createFlowCompiler({ toolResolver: resolver }).compile(
      forEachNode([nested]) as unknown as FlowNode
    );

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 2, code, nodePath: path }),
      ])
    );
    expect("artifact" in result).toBe(false);
  });

  it.each([undefined, 1])(
    "keeps sequential for_each executable for concurrency %s",
    async (concurrency) => {
      const result = await createFlowCompiler({ toolResolver: resolver }).compile(
        forEachNode(undefined, concurrency) as unknown as FlowNode
      );

      expect("errors" in result ? JSON.stringify(result.errors) : "ok").toBe("ok");
      if ("errors" in result) return;
      expect(
        (result.artifact as { nodes: Array<Record<string, unknown>> }).nodes.find(
          (node) => node.type === "loop"
        )
      ).toMatchObject({ forEach: { concurrency: 1 } });
    }
  );

  // 24-I: THE test the packet turns on. Before this change
  // `_shared-leaf.ts` emitted a hardcoded `concurrency: 1` into every lowered
  // artifact regardless of what the author wrote, so relaxing the five other
  // deny sites would have changed nothing observable at runtime. This asserts
  // the authored value actually survives lowering.
  it.each([2, 4, 16])(
    "lowers an authored concurrency %s into the artifact verbatim",
    async (concurrency) => {
      const result = await createFlowCompiler({ toolResolver: resolver }).compile(
        forEachNode(undefined, concurrency) as unknown as FlowNode
      );

      expect("errors" in result ? JSON.stringify(result.errors) : "ok").toBe("ok");
      if ("errors" in result) return;
      expect(
        (result.artifact as { nodes: Array<Record<string, unknown>> }).nodes.find(
          (node) => node.type === "loop"
        )
      ).toMatchObject({ forEach: { concurrency } });
    }
  );
});
