import { describe, expect, it } from "vitest";

import { flowNodeSchema } from "../validate.js";

// ---------------------------------------------------------------------------
// DZUPAGENT-TEST-M1: these node validators (wait, try_catch, prompt, loop,
// persona, subflow, emit, return_to, spawn, clarification, memory, approval,
// knowledge.write, knowledge.query, http, worker.dispatch, fleet.*) were
// registered in FLOW_NODE_VALIDATOR_DESCRIPTORS but never exercised through
// flowNodeSchema.safeParse by any existing test file, leaving their
// validate/*.ts functions at ~0-15% coverage. This file drives each one
// through both the happy path and its documented required-field / optional
// -field-type error paths.
// ---------------------------------------------------------------------------

describe("flowNodeSchema — wait", () => {
  it("accepts a wait node with a non-negative durationMs", () => {
    const result = flowNodeSchema.safeParse({
      type: "wait",
      id: "pause",
      durationMs: 1000,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "wait") {
      expect(result.data.durationMs).toBe(1000);
    }
  });

  it("accepts durationMs of exactly zero", () => {
    const result = flowNodeSchema.safeParse({
      type: "wait",
      id: "pause",
      durationMs: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative durationMs", () => {
    const result = flowNodeSchema.safeParse({
      type: "wait",
      id: "pause",
      durationMs: -1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.durationMs");
    }
  });

  it("rejects a missing durationMs", () => {
    const result = flowNodeSchema.safeParse({ type: "wait", id: "pause" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric durationMs", () => {
    const result = flowNodeSchema.safeParse({
      type: "wait",
      id: "pause",
      durationMs: "1000",
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — try_catch", () => {
  it("accepts a try_catch node with body and catch", () => {
    const result = flowNodeSchema.safeParse({
      type: "try_catch",
      id: "guard",
      body: [{ type: "complete", id: "ok" }],
      catch: [{ type: "complete", id: "handled" }],
      errorVar: "err",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "try_catch") {
      expect(result.data.errorVar).toBe("err");
    }
  });

  it("rejects an empty body", () => {
    const result = flowNodeSchema.safeParse({
      type: "try_catch",
      id: "guard",
      body: [],
      catch: [{ type: "complete", id: "handled" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "EMPTY_BODY")).toBe(
        true
      );
    }
  });

  it("rejects a missing catch array", () => {
    const result = flowNodeSchema.safeParse({
      type: "try_catch",
      id: "guard",
      body: [{ type: "complete", id: "ok" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed body element", () => {
    const result = flowNodeSchema.safeParse({
      type: "try_catch",
      id: "guard",
      body: [{ type: "mystery" }],
      catch: [{ type: "complete", id: "handled" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — prompt", () => {
  it("accepts a prompt node with optional fields", () => {
    const result = flowNodeSchema.safeParse({
      type: "prompt",
      id: "ask",
      userPrompt: "What next?",
      systemPrompt: "Be helpful",
      outputKey: "answer",
      provider: "claude",
      model: "sonnet",
      tools: true,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "prompt") {
      expect(result.data.outputKey).toBe("answer");
      expect(result.data.tools).toBe(true);
    }
  });

  it("accepts a minimal prompt node", () => {
    const result = flowNodeSchema.safeParse({
      type: "prompt",
      id: "ask",
      userPrompt: "Hello",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty userPrompt", () => {
    const result = flowNodeSchema.safeParse({
      type: "prompt",
      id: "ask",
      userPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing userPrompt", () => {
    const result = flowNodeSchema.safeParse({ type: "prompt", id: "ask" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.userPrompt");
    }
  });
});

describe("flowNodeSchema — loop", () => {
  it("accepts a loop node with condition, body, and maxIterations", () => {
    const result = flowNodeSchema.safeParse({
      type: "loop",
      id: "retry",
      condition: "state.count < 3",
      body: [{ type: "complete", id: "step" }],
      maxIterations: 3,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "loop") {
      expect(result.data.maxIterations).toBe(3);
    }
  });

  it("rejects a missing condition", () => {
    const result = flowNodeSchema.safeParse({
      type: "loop",
      id: "retry",
      body: [{ type: "complete", id: "step" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.condition");
    }
  });

  it("rejects an empty body", () => {
    const result = flowNodeSchema.safeParse({
      type: "loop",
      id: "retry",
      condition: "true",
      body: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "EMPTY_BODY")).toBe(
        true
      );
    }
  });
});

describe("flowNodeSchema — persona", () => {
  it("accepts a persona node", () => {
    const result = flowNodeSchema.safeParse({
      type: "persona",
      id: "as_reviewer",
      personaId: "reviewer",
      body: [{ type: "complete", id: "done" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing personaId", () => {
    const result = flowNodeSchema.safeParse({
      type: "persona",
      id: "as_reviewer",
      body: [{ type: "complete", id: "done" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty body even when personaId is present", () => {
    const result = flowNodeSchema.safeParse({
      type: "persona",
      id: "as_reviewer",
      personaId: "reviewer",
      body: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "EMPTY_BODY")).toBe(
        true
      );
    }
  });

  it("rejects both a missing personaId and a malformed body", () => {
    const result = flowNodeSchema.safeParse({
      type: "persona",
      id: "as_reviewer",
      body: [{ type: "mystery" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — subflow", () => {
  it("accepts a subflow node with input and outputVar", () => {
    const result = flowNodeSchema.safeParse({
      type: "subflow",
      id: "delegate",
      flowRef: "other-flow",
      input: { a: 1 },
      outputVar: "result",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "subflow") {
      expect(result.data.outputVar).toBe("result");
    }
  });

  it("rejects a missing flowRef", () => {
    const result = flowNodeSchema.safeParse({ type: "subflow", id: "delegate" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object input", () => {
    const result = flowNodeSchema.safeParse({
      type: "subflow",
      id: "delegate",
      flowRef: "other-flow",
      input: "oops",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.input");
    }
  });
});

describe("flowNodeSchema — emit", () => {
  it("accepts an emit node with a payload", () => {
    const result = flowNodeSchema.safeParse({
      type: "emit",
      id: "notify",
      event: "step.done",
      payload: { ok: true },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing event", () => {
    const result = flowNodeSchema.safeParse({ type: "emit", id: "notify" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object payload", () => {
    const result = flowNodeSchema.safeParse({
      type: "emit",
      id: "notify",
      event: "step.done",
      payload: "oops",
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — return_to", () => {
  it("accepts a return_to node with maxIterations", () => {
    const result = flowNodeSchema.safeParse({
      type: "return_to",
      id: "loop_back",
      targetId: "start",
      condition: "state.count < 5",
      maxIterations: 5,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "return_to") {
      expect(result.data.maxIterations).toBe(5);
    }
  });

  it("rejects a missing targetId and condition together", () => {
    const result = flowNodeSchema.safeParse({ type: "return_to", id: "loop_back" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path);
      expect(paths).toContain("root.targetId");
      expect(paths).toContain("root.condition");
    }
  });

  it("rejects an empty condition", () => {
    const result = flowNodeSchema.safeParse({
      type: "return_to",
      id: "loop_back",
      targetId: "start",
      condition: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — spawn", () => {
  it("accepts a spawn node with input and waitForCompletion", () => {
    const result = flowNodeSchema.safeParse({
      type: "spawn",
      id: "kick_off",
      templateRef: "worker-template",
      input: { task: "build" },
      waitForCompletion: true,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "spawn") {
      expect(result.data.waitForCompletion).toBe(true);
    }
  });

  it("rejects a missing templateRef", () => {
    const result = flowNodeSchema.safeParse({ type: "spawn", id: "kick_off" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object input", () => {
    const result = flowNodeSchema.safeParse({
      type: "spawn",
      id: "kick_off",
      templateRef: "worker-template",
      input: "oops",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean waitForCompletion", () => {
    const result = flowNodeSchema.safeParse({
      type: "spawn",
      id: "kick_off",
      templateRef: "worker-template",
      waitForCompletion: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — clarification", () => {
  it("accepts a text clarification", () => {
    const result = flowNodeSchema.safeParse({
      type: "clarification",
      id: "ask_user",
      question: "What is the target repo?",
      expected: "text",
      outputKey: "targetRepo",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a choice clarification with choices", () => {
    const result = flowNodeSchema.safeParse({
      type: "clarification",
      id: "ask_user",
      question: "Pick one",
      expected: "choice",
      choices: ["a", "b"],
      outputKey: "selection",
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate, empty, and over-bounded choices", () => {
    for (const choices of [
      ["a", "a"],
      [""],
      Array.from({ length: 33 }, (_, index) => `choice-${index}`),
    ]) {
      expect(
        flowNodeSchema.safeParse({
          type: "clarification",
          id: "ask_user",
          question: "Pick one",
          expected: "choice",
          choices,
          outputKey: "selection",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects a missing question", () => {
    const result = flowNodeSchema.safeParse({ type: "clarification", id: "ask_user" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid expected value", () => {
    const result = flowNodeSchema.safeParse({
      type: "clarification",
      id: "ask_user",
      question: "Pick one",
      expected: "yes-or-no",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string choices", () => {
    const result = flowNodeSchema.safeParse({
      type: "clarification",
      id: "ask_user",
      question: "Pick one",
      choices: [1, 2],
    });
    expect(result.success).toBe(false);
  });

  it("rejects expected=choice without any choices", () => {
    const result = flowNodeSchema.safeParse({
      type: "clarification",
      id: "ask_user",
      question: "Pick one",
      expected: "choice",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("expected='choice'"))
      ).toBe(true);
    }
  });
});

describe("flowNodeSchema — memory", () => {
  it("accepts a memory write", () => {
    const result = flowNodeSchema.safeParse({
      type: "memory",
      id: "remember",
      operation: "write",
      tier: "session",
      key: "answer",
      valueExpr: "state.answer",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a memory search with query and limit", () => {
    const result = flowNodeSchema.safeParse({
      type: "memory",
      id: "recall",
      operation: "search",
      tier: "workspace",
      query: "prior incidents",
      limit: 5,
      outputVar: "hits",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "memory") {
      expect(result.data.limit).toBe(5);
    }
  });

  it("rejects an invalid operation", () => {
    const result = flowNodeSchema.safeParse({
      type: "memory",
      id: "recall",
      operation: "delete",
      tier: "session",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid tier", () => {
    const result = flowNodeSchema.safeParse({
      type: "memory",
      id: "recall",
      operation: "read",
      tier: "global",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a search operation without a query", () => {
    const result = flowNodeSchema.safeParse({
      type: "memory",
      id: "recall",
      operation: "search",
      tier: "session",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain(
        'memory.query is required when operation is "search"'
      );
    }
  });

  it("ignores a non-positive-integer limit", () => {
    const result = flowNodeSchema.safeParse({
      type: "memory",
      id: "recall",
      operation: "list",
      tier: "session",
      limit: -1,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "memory") {
      expect(result.data.limit).toBeUndefined();
    }
  });
});

describe("flowNodeSchema — approval", () => {
  it("accepts an approval node with options and approvalClass", () => {
    const result = flowNodeSchema.safeParse({
      type: "approval",
      id: "gate",
      question: "Proceed with deploy?",
      onApprove: [{ type: "complete", id: "shipped" }],
      onReject: [{ type: "complete", id: "aborted" }],
      options: ["yes", "no"],
      approvalClass: "destructive_shell",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "approval") {
      expect(result.data.approvalClass).toBe("destructive_shell");
    }
  });

  it("rejects duplicate, empty, and over-bounded approval options", () => {
    for (const options of [
      ["yes", "yes"],
      [""],
      Array.from({ length: 33 }, (_, index) => `option-${index}`),
    ]) {
      expect(
        flowNodeSchema.safeParse({
          type: "approval",
          id: "gate",
          question: "Proceed?",
          onApprove: [{ type: "complete", id: "yes" }],
          onReject: [{ type: "complete", id: "no" }],
          options,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects a missing question", () => {
    const result = flowNodeSchema.safeParse({
      type: "approval",
      id: "gate",
      onApprove: [{ type: "complete", id: "shipped" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty onApprove array", () => {
    const result = flowNodeSchema.safeParse({
      type: "approval",
      id: "gate",
      question: "Proceed?",
      onApprove: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "EMPTY_BODY")).toBe(
        true
      );
    }
  });

  it("rejects non-string options", () => {
    const result = flowNodeSchema.safeParse({
      type: "approval",
      id: "gate",
      question: "Proceed?",
      onApprove: [{ type: "complete", id: "shipped" }],
      options: [1, 2],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized approvalClass", () => {
    const result = flowNodeSchema.safeParse({
      type: "approval",
      id: "gate",
      question: "Proceed?",
      onApprove: [{ type: "complete", id: "shipped" }],
      approvalClass: "world_domination",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed onReject array while onApprove is valid", () => {
    const result = flowNodeSchema.safeParse({
      type: "approval",
      id: "gate",
      question: "Proceed?",
      onApprove: [{ type: "complete", id: "shipped" }],
      onReject: [{ type: "mystery" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — knowledge.write / knowledge.query", () => {
  it("accepts a knowledge.write node", () => {
    const result = flowNodeSchema.safeParse({
      type: "knowledge.write",
      id: "note",
      scope: "project",
      entry: { fact: "the sky is blue" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects knowledge.write with a missing scope", () => {
    const result = flowNodeSchema.safeParse({
      type: "knowledge.write",
      id: "note",
      entry: { fact: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects knowledge.write with a missing entry", () => {
    const result = flowNodeSchema.safeParse({
      type: "knowledge.write",
      id: "note",
      scope: "project",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.entry");
    }
  });

  it("accepts a knowledge.query node", () => {
    const result = flowNodeSchema.safeParse({
      type: "knowledge.query",
      id: "lookup",
      filter: { tag: "incidents" },
      output: "matches",
    });
    expect(result.success).toBe(true);
  });

  it("rejects knowledge.query with a non-object filter", () => {
    const result = flowNodeSchema.safeParse({
      type: "knowledge.query",
      id: "lookup",
      filter: "oops",
      output: "matches",
    });
    expect(result.success).toBe(false);
  });

  it("rejects knowledge.query with a missing output", () => {
    const result = flowNodeSchema.safeParse({
      type: "knowledge.query",
      id: "lookup",
      filter: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — http", () => {
  it("accepts a minimal GET http node", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com/api",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full http node with headers, body, auth, and timeout", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "post_data",
      url: "https://example.com/api",
      method: "POST",
      headers: { "x-request-id": "abc" },
      body: { key: "value" },
      auth: {
        scheme: "bearer",
        credential: "token-ref",
        provider: "internal",
        scopes: ["read"],
      },
      outputVar: "response",
      timeoutMs: 5000,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "http") {
      expect(result.data.method).toBe("POST");
      expect(result.data.timeoutMs).toBe(5000);
    }
  });

  it("accepts api-key-header auth with a reviewed header name", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com/api",
      auth: {
        scheme: "api-key-header",
        credential: "token-ref",
        provider: "internal",
        scopes: ["read"],
        headerName: "x-api-key",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing url", () => {
    const result = flowNodeSchema.safeParse({ type: "http", id: "fetch" });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported method", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      method: "TRACE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object headers value", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      headers: "oops",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object body value", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      body: "oops",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive-integer timeoutMs", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      timeoutMs: -5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects auth that is not an object", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      auth: "oops",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported auth scheme", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      auth: {
        scheme: "digest",
        credential: "token-ref",
        provider: "internal",
        scopes: ["read"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects auth missing credential and provider", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      auth: { scheme: "bearer", scopes: ["read"] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path);
      expect(paths).toContain("root.auth.credential");
      expect(paths).toContain("root.auth.provider");
    }
  });

  it("rejects a provider identity with disallowed characters", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      auth: {
        scheme: "bearer",
        credential: "token-ref",
        provider: "not a valid provider!",
        scopes: ["read"],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path === "root.auth.provider")
      ).toBe(true);
    }
  });

  it("rejects duplicate scopes", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      auth: {
        scheme: "bearer",
        credential: "token-ref",
        provider: "internal",
        scopes: ["read", "read"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a headerName on non-api-key-header schemes", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      auth: {
        scheme: "bearer",
        credential: "token-ref",
        provider: "internal",
        scopes: ["read"],
        headerName: "x-api-key",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a reserved headerName for api-key-header", () => {
    const result = flowNodeSchema.safeParse({
      type: "http",
      id: "fetch",
      url: "https://example.com",
      auth: {
        scheme: "api-key-header",
        credential: "token-ref",
        provider: "internal",
        scopes: ["read"],
        headerName: "Authorization",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — worker.dispatch", () => {
  it("accepts a minimal worker.dispatch node", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "claude",
      instructions: "Implement the fix",
      outputKey: "result",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated worker.dispatch node", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "codex",
      instructions: "Implement the fix",
      outputKey: "result",
      model: "gpt-5-codex",
      systemPrompt: "Be terse",
      input: { file: "a.ts" },
      commandSurface: "code",
      commandAllowlist: ["ls", "cat"],
      validationCommand: "yarn test",
      resultSchema: "dzup.result@1",
      resultFormat: "json",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "worker.dispatch") {
      expect(result.data.resultFormat).toBe("json");
    }
  });

  it("rejects a missing dispatchId", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      provider: "claude",
      instructions: "do it",
      outputKey: "result",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported provider", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "chatgpt",
      instructions: "do it",
      outputKey: "result",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing instructions", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "claude",
      outputKey: "result",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing outputKey", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "claude",
      instructions: "do it",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object input", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "claude",
      instructions: "do it",
      outputKey: "result",
      input: "oops",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid commandSurface", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "claude",
      instructions: "do it",
      outputKey: "result",
      commandSurface: "shell",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-array commandAllowlist", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "claude",
      instructions: "do it",
      outputKey: "result",
      commandAllowlist: "ls",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid resultFormat", () => {
    const result = flowNodeSchema.safeParse({
      type: "worker.dispatch",
      id: "dispatch_worker",
      dispatchId: "wd-1",
      provider: "claude",
      instructions: "do it",
      outputKey: "result",
      resultFormat: "xml",
    });
    expect(result.success).toBe(false);
  });
});

describe("flowNodeSchema — fleet.dispatch / fleet.gather / fleet.contract-net", () => {
  it("accepts a fleet.dispatch node with string repos", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.dispatch",
      id: "dispatch_fleet",
      mode: "fan-out",
      repos: "repo-a",
      task: { description: "audit" },
      on_contract_change: "abort",
      output: "results",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fleet.dispatch node with array repos", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.dispatch",
      id: "dispatch_fleet",
      mode: "dependency",
      repos: ["repo-a", "repo-b"],
      task: "audit",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unrecognized dispatch mode", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.dispatch",
      id: "dispatch_fleet",
      mode: "broadcast",
      repos: "repo-a",
      task: "audit",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing repos field", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.dispatch",
      id: "dispatch_fleet",
      mode: "fan-out",
      task: "audit",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.repos");
    }
  });

  it("rejects a repos field that is neither string nor array", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.dispatch",
      id: "dispatch_fleet",
      mode: "fan-out",
      repos: 42,
      task: "audit",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing task field", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.dispatch",
      id: "dispatch_fleet",
      mode: "fan-out",
      repos: "repo-a",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.task");
    }
  });

  it("accepts a fleet.gather node", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.gather",
      id: "gather_fleet",
      source: "dispatch_fleet",
      strategy: "merge",
      output: "combined",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a fleet.gather node with a missing source", () => {
    const result = flowNodeSchema.safeParse({ type: "fleet.gather", id: "gather_fleet" });
    expect(result.success).toBe(false);
  });

  it("accepts a fleet.contract-net node", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.contract-net",
      id: "cn",
      repos: ["repo-a"],
      task: "negotiate",
      output: "winner",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a fleet.contract-net node with a missing repos field", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.contract-net",
      id: "cn",
      task: "negotiate",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.repos");
    }
  });

  it("rejects a fleet.contract-net node with a repos field that is neither string nor array", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.contract-net",
      id: "cn",
      repos: true,
      task: "negotiate",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a fleet.contract-net node with a missing task field", () => {
    const result = flowNodeSchema.safeParse({
      type: "fleet.contract-net",
      id: "cn",
      repos: ["repo-a"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toBe("root.task");
    }
  });
});
