/**
 * DSL normalization coverage for the `worker.dispatch` wrapper
 * (Worker-Orchestrated Dashboard Feature Flow — Phase P1).
 */
import { describe, expect, it } from "vitest";

import { normalizeDslDocument } from "../normalize.js";
import { formatDocumentToDsl } from "../format-dsl.js";
import { canonicalizeDsl } from "../canonicalize-dsl.js";
import type { FlowDocumentV1, WorkerDispatchNode } from "@dzupagent/flow-ast";

function makeRaw(
  steps: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1alpha-agent",
    id: "worker-flow",
    version: 1,
    steps,
    ...extra,
  };
}

function workerStep(node: Record<string, unknown>): Record<string, unknown> {
  return { "worker.dispatch": node };
}

describe("normalizeDslDocument — worker.dispatch wrapper", () => {
  it("round-trips a full worker.dispatch node with all fields", () => {
    const raw = makeRaw([
      workerStep({
        id: "dispatch-build",
        dispatchId: "build-dashboard",
        provider: "claude",
        model: "claude-sonnet-4-6",
        systemPrompt: "You are a worker",
        instructions: "Build the dashboard feature",
        input: { feature: "flags" },
        commandSurface: "code",
        commandAllowlist: ["yarn build", "yarn test"],
        validationCommand: "yarn typecheck",
        outputKey: "workerResult",
        resultFormat: "json",
        resultSchema: "dashboard-plan",
      }),
    ]);
    const { document, diagnostics } = normalizeDslDocument(raw);
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as WorkerDispatchNode | undefined;
    expect(node?.type).toBe("worker.dispatch");
    expect(node?.dispatchId).toBe("build-dashboard");
    expect(node?.provider).toBe("claude");
    expect(node?.model).toBe("claude-sonnet-4-6");
    expect(node?.systemPrompt).toBe("You are a worker");
    expect(node?.instructions).toBe("Build the dashboard feature");
    expect(node?.input).toEqual({ feature: "flags" });
    expect(node?.commandSurface).toBe("code");
    expect(node?.commandAllowlist).toEqual(["yarn build", "yarn test"]);
    expect(node?.validationCommand).toBe("yarn typecheck");
    expect(node?.outputKey).toBe("workerResult");
    expect(node?.resultFormat).toBe("json");
    expect(node?.resultSchema).toBe("dashboard-plan");
  });

  it("omits resultSchema when absent and reports INVALID_NODE_SHAPE for a non-string", () => {
    const ok = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        provider: "claude",
        instructions: "Run",
        outputKey: "result",
      }),
    ]);
    const okResult = normalizeDslDocument(ok);
    expect(okResult.diagnostics).toEqual([]);
    const okNode = okResult.document?.root.nodes[0] as
      | WorkerDispatchNode
      | undefined;
    expect(okNode?.resultSchema).toBeUndefined();

    const bad = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        provider: "claude",
        instructions: "Run",
        outputKey: "result",
        resultSchema: 42,
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(bad);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "INVALID_NODE_SHAPE" && d.path?.endsWith(".resultSchema"),
      ),
    ).toBe(true);
  });

  it("applies defaults: commandSurface=none, resultFormat=text", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "minimal",
        provider: "codex",
        instructions: "Do the thing",
        outputKey: "result",
      }),
    ]);
    const { document, diagnostics } = normalizeDslDocument(raw);
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as WorkerDispatchNode | undefined;
    expect(node?.commandSurface).toBe("none");
    expect(node?.resultFormat).toBe("text");
  });

  it("accepts every supported provider value", () => {
    for (const provider of [
      "claude",
      "codex",
      "gemini",
      "qwen",
      "goose",
      "crush",
    ] as const) {
      const raw = makeRaw([
        workerStep({
          id: `d-${provider}`,
          dispatchId: `dispatch-${provider}`,
          provider,
          instructions: "Run",
          outputKey: "result",
        }),
      ]);
      const { document, diagnostics } = normalizeDslDocument(raw);
      expect(diagnostics).toEqual([]);
      const node = document?.root.nodes[0] as WorkerDispatchNode | undefined;
      expect(node?.provider).toBe(provider);
    }
  });

  it("reports MISSING_REQUIRED_FIELD for missing dispatchId", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        provider: "claude",
        instructions: "Run",
        outputKey: "result",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" &&
          d.path?.endsWith(".dispatchId"),
      ),
    ).toBe(true);
  });

  it("reports MISSING_REQUIRED_FIELD for missing instructions", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        provider: "claude",
        outputKey: "result",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" &&
          d.path?.endsWith(".instructions"),
      ),
    ).toBe(true);
  });

  it("reports MISSING_REQUIRED_FIELD for missing outputKey", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        provider: "claude",
        instructions: "Run",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".outputKey"),
      ),
    ).toBe(true);
  });

  it("reports MISSING_REQUIRED_FIELD for missing provider", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        instructions: "Run",
        outputKey: "result",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".provider"),
      ),
    ).toBe(true);
  });

  it("reports INVALID_ENUM_VALUE for an unknown provider", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        provider: "cursor",
        instructions: "Run",
        outputKey: "result",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) => d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".provider"),
      ),
    ).toBe(true);
  });

  it("reports INVALID_ENUM_VALUE for an unknown commandSurface", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        provider: "claude",
        instructions: "Run",
        outputKey: "result",
        commandSurface: "shell",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "INVALID_ENUM_VALUE" &&
          d.path?.endsWith(".commandSurface"),
      ),
    ).toBe(true);
  });

  it("reports INVALID_ENUM_VALUE for an unknown resultFormat", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        provider: "claude",
        instructions: "Run",
        outputKey: "result",
        resultFormat: "yaml",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".resultFormat"),
      ),
    ).toBe(true);
  });

  it("reports UNSUPPORTED_FIELD for an unknown field", () => {
    const raw = makeRaw([
      workerStep({
        id: "d1",
        dispatchId: "x",
        provider: "claude",
        instructions: "Run",
        outputKey: "result",
        nonsense: true,
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) => d.code === "UNSUPPORTED_FIELD" && d.path?.endsWith(".nonsense"),
      ),
    ).toBe(true);
  });
});

describe("worker.dispatch — YAML round-trip", () => {
  // Regression: the formatter used to emit a single dotted wrapper KEY
  // (`- worker.dispatch:`) that the mini-yaml subset parser rejected because
  // `.` was not allowed in mapping keys, so a DSL-authored worker.dispatch flow
  // could not be parsed back (INVALID_YAML_SUBSET). This proves format -> parse
  // is lossless for a fully-populated worker.dispatch node.
  it("format -> parse preserves a full worker.dispatch node", () => {
    const original: WorkerDispatchNode = {
      type: "worker.dispatch",
      id: "dispatch-build",
      dispatchId: "build-dashboard",
      provider: "claude",
      model: "claude-sonnet-4-6",
      systemPrompt: "You are a worker",
      instructions: "Build the dashboard feature",
      input: { feature: "flags" },
      commandSurface: "code",
      commandAllowlist: ["yarn build", "yarn test"],
      validationCommand: "yarn typecheck",
      outputKey: "workerResult",
      resultFormat: "json",
      resultSchema: "dashboard-plan",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "worker-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const yaml = formatDocumentToDsl(document);
    const result = canonicalizeDsl(yaml);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    const roundTripped = result.document?.root.nodes[0] as
      | WorkerDispatchNode
      | undefined;
    expect(roundTripped).toEqual(original);
  });

  it("format -> parse preserves a minimal worker.dispatch node with defaults", () => {
    const original: WorkerDispatchNode = {
      type: "worker.dispatch",
      id: "d1",
      dispatchId: "minimal",
      provider: "codex",
      instructions: "Do the thing",
      outputKey: "result",
      commandSurface: "none",
      resultFormat: "text",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "worker-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });
});
