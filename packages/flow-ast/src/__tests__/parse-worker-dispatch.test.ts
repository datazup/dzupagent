/**
 * Parser-level coverage for the `worker.dispatch` node
 * (`parse/worker-dispatch.ts`). Covers the happy path with all required
 * fields, each optional field, and rejection of malformed required/optional
 * fields. Mirrors the fixture style of `parse-memory-search.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { parseFlow } from "../index.js";
import type { WorkerDispatchNode } from "../index.js";

function baseDispatch(overrides: Record<string, unknown> = {}) {
  return {
    type: "worker.dispatch",
    dispatchId: "d1",
    provider: "claude",
    instructions: "Do the thing.",
    outputKey: "result",
    ...overrides,
  };
}

describe("parseFlow — worker.dispatch node", () => {
  it("parses a minimal valid node with only required fields", () => {
    const result = parseFlow(baseDispatch());
    expect(result.errors).toHaveLength(0);
    const node = result.ast as WorkerDispatchNode;
    expect(node?.type).toBe("worker.dispatch");
    expect(node?.dispatchId).toBe("d1");
    expect(node?.provider).toBe("claude");
    expect(node?.instructions).toBe("Do the thing.");
    expect(node?.outputKey).toBe("result");
  });

  it.each(["claude", "codex", "gemini", "qwen", "goose", "crush"] as const)(
    "accepts provider %s",
    (provider) => {
      const result = parseFlow(baseDispatch({ provider }));
      expect(result.errors).toHaveLength(0);
      const node = result.ast as WorkerDispatchNode;
      expect(node?.provider).toBe(provider);
    },
  );

  it("parses all optional fields together", () => {
    const result = parseFlow(
      baseDispatch({
        model: "claude-sonnet-4-6",
        systemPrompt: "You are a careful worker.",
        input: { topic: "flow runtime" },
        commandSurface: "code",
        commandAllowlist: ["git status", "yarn test"],
        validationCommand: "yarn typecheck",
        resultSchema: "result.v1",
        resultFormat: "json",
      }),
    );
    expect(result.errors).toHaveLength(0);
    const node = result.ast as WorkerDispatchNode;
    expect(node?.model).toBe("claude-sonnet-4-6");
    expect(node?.systemPrompt).toBe("You are a careful worker.");
    expect(node?.input).toEqual({ topic: "flow runtime" });
    expect(node?.commandSurface).toBe("code");
    expect(node?.commandAllowlist).toEqual(["git status", "yarn test"]);
    expect(node?.validationCommand).toBe("yarn typecheck");
    expect(node?.resultSchema).toBe("result.v1");
    expect(node?.resultFormat).toBe("json");
  });

  it("rejects a missing dispatchId", () => {
    const result = parseFlow(baseDispatch({ dispatchId: undefined }));
    expect(result.ast).toBeNull();
    expect(result.errors.some((e) => e.message.includes("dispatchId"))).toBe(
      true,
    );
  });

  it("rejects an empty-string dispatchId", () => {
    const result = parseFlow(baseDispatch({ dispatchId: "" }));
    expect(result.ast).toBeNull();
    expect(result.errors.some((e) => e.message.includes("dispatchId"))).toBe(
      true,
    );
  });

  it("rejects an unknown provider", () => {
    const result = parseFlow(baseDispatch({ provider: "bogus-provider" }));
    expect(result.ast).toBeNull();
    expect(result.errors.some((e) => e.message.includes("provider"))).toBe(
      true,
    );
  });

  it("rejects a missing instructions field", () => {
    const result = parseFlow(baseDispatch({ instructions: undefined }));
    expect(result.ast).toBeNull();
    expect(result.errors.some((e) => e.message.includes("instructions"))).toBe(
      true,
    );
  });

  it("rejects a missing outputKey", () => {
    const result = parseFlow(baseDispatch({ outputKey: undefined }));
    expect(result.ast).toBeNull();
    expect(result.errors.some((e) => e.message.includes("outputKey"))).toBe(
      true,
    );
  });

  it("rejects a non-object input", () => {
    const result = parseFlow(baseDispatch({ input: "not-an-object" }));
    expect(result.ast).toBeNull();
    expect(result.errors.some((e) => e.message.includes("input"))).toBe(true);
  });

  it("rejects an array input (object check excludes arrays)", () => {
    const result = parseFlow(baseDispatch({ input: ["a", "b"] }));
    expect(result.ast).toBeNull();
    expect(result.errors.some((e) => e.message.includes("input"))).toBe(true);
  });

  it("rejects an invalid commandSurface", () => {
    const result = parseFlow(baseDispatch({ commandSurface: "shell" }));
    expect(result.ast).toBeNull();
    expect(
      result.errors.some((e) => e.message.includes("commandSurface")),
    ).toBe(true);
  });

  it("rejects a non-array commandAllowlist", () => {
    const result = parseFlow(baseDispatch({ commandAllowlist: "git status" }));
    expect(result.ast).toBeNull();
    expect(
      result.errors.some((e) => e.message.includes("commandAllowlist")),
    ).toBe(true);
  });

  it("rejects a commandAllowlist with non-string entries", () => {
    const result = parseFlow(
      baseDispatch({ commandAllowlist: ["git status", 42] }),
    );
    expect(result.ast).toBeNull();
    expect(
      result.errors.some((e) => e.message.includes("commandAllowlist")),
    ).toBe(true);
  });

  it("rejects an invalid resultFormat", () => {
    const result = parseFlow(baseDispatch({ resultFormat: "xml" }));
    expect(result.ast).toBeNull();
    expect(result.errors.some((e) => e.message.includes("resultFormat"))).toBe(
      true,
    );
  });

  it("types a WorkerDispatchNode literal with reasoningEffort (compile-time contract)", () => {
    // flow-ast has no runtime allowlist gap to exercise here beyond the type:
    // parseFlow's per-kind parser only copies fields it explicitly knows
    // about, so this is a type-level contract check — it fails `tsc` (and
    // therefore this test file) if `reasoningEffort` is not a recognized,
    // correctly-typed member of `WorkerDispatchNode`.
    const node: WorkerDispatchNode = {
      type: "worker.dispatch",
      id: "n1",
      dispatchId: "d1",
      provider: "codex",
      reasoningEffort: "high",
      instructions: "do the thing",
      outputKey: "out",
    };
    expect(node.reasoningEffort).toBe("high");
  });
});
