/**
 * DSL normalization coverage for the `worker.dispatch` wrapper
 * (Worker-Orchestrated Dashboard Feature Flow — Phase P1).
 */
import { describe, expect, it } from "vitest";

import { normalizeDslDocument } from "../normalize.js";
import type { WorkerDispatchNode } from "@dzupagent/flow-ast";

function makeRaw(
  steps: unknown[],
  extra: Record<string, unknown> = {}
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
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".dispatchId")
      )
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
          d.path?.endsWith(".instructions")
      )
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
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".outputKey")
      )
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
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".provider")
      )
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
        (d) => d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".provider")
      )
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
          d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".commandSurface")
      )
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
          d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".resultFormat")
      )
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
        (d) => d.code === "UNSUPPORTED_FIELD" && d.path?.endsWith(".nonsense")
      )
    ).toBe(true);
  });
});
