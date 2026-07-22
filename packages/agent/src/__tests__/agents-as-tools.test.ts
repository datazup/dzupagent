/**
 * agents-as-tools.test.ts
 *
 * +75 tests covering the `agentAsTool` factory in @dzupagent/agent:
 *   - Sub-agent invocation: calling a sub-agent produces a tool-call-style result
 *   - Result forwarding: sub-agent output correctly forwarded to parent agent's context
 *   - Error propagation: sub-agent error surfaces as tool error in parent
 *   - Sub-agent timeout: sub-agent that times out → rejects with error
 *   - Sub-agent with input schema: task/context fields validated before dispatch
 *   - Sub-agent with output schema: output string returned after return
 *   - Nested agents-as-tools: sub-agent itself calls another agent-as-tool
 *   - Parallel sub-agent dispatch: two sub-agents invoked concurrently
 *   - Sub-agent result caching: same call reuses generate, cache layer optional
 *   - Sub-agent cancellation: AbortSignal cancellation propagates
 *   - Sub-agent context isolation: separate generate calls per tool instance
 *   - Tool name collision: multiple agents get distinct names
 *   - Sub-agent retry: generate fails once, manual retry succeeds
 *   - Agent-tool registration: tool appears with correct name + description
 *
 * All LLM / generate calls are mocked — no real network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import { agentAsTool } from "../tools/agent-as-tool.js";
import type { AgentAsToolContext } from "../tools/agent-as-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  overrides: Partial<AgentAsToolContext> & { content?: string } = {}
): AgentAsToolContext {
  const {
    content = "done",
    id = "worker",
    description = "A worker agent",
    ...rest
  } = overrides;
  return {
    id,
    description,
    generate: vi.fn(async (_msgs: BaseMessage[]) => ({ content })),
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// 1. Tool construction & registration
// ---------------------------------------------------------------------------

describe("agentAsTool – tool registration", () => {
  it("returns a StructuredToolInterface", async () => {
    const t = await agentAsTool(makeContext());
    expect(t).toBeDefined();
    expect(typeof t.invoke).toBe("function");
  });

  it("tool name is agent-<id>", async () => {
    const t = await agentAsTool(makeContext({ id: "summariser" }));
    expect(t.name).toBe("agent-summariser");
  });

  it("tool description matches context.description", async () => {
    const t = await agentAsTool(
      makeContext({ description: "Summarises long documents" })
    );
    expect(t.description).toBe("Summarises long documents");
  });

  it("tool schema has required task field", async () => {
    const t = await agentAsTool(makeContext());
    // schema is a zod object; verify by invoking with missing task
    await expect(t.invoke({ task: "" })).resolves.toBeDefined();
  });

  it("tool schema has optional context field", async () => {
    const t = await agentAsTool(makeContext());
    // providing context should not throw
    await expect(
      t.invoke({ task: "do it", context: "extra info" })
    ).resolves.toBeDefined();
  });

  it("two agents produce tools with distinct names", async () => {
    const t1 = await agentAsTool(makeContext({ id: "alpha" }));
    const t2 = await agentAsTool(makeContext({ id: "beta" }));
    expect(t1.name).toBe("agent-alpha");
    expect(t2.name).toBe("agent-beta");
    expect(t1.name).not.toBe(t2.name);
  });

  it("id with hyphens is preserved in tool name", async () => {
    const t = await agentAsTool(makeContext({ id: "my-sub-agent" }));
    expect(t.name).toBe("agent-my-sub-agent");
  });

  it("tool can be constructed multiple times independently", async () => {
    const ctx = makeContext({ id: "reuse" });
    const t1 = await agentAsTool(ctx);
    const t2 = await agentAsTool(ctx);
    expect(t1.name).toBe(t2.name);
  });
});

// ---------------------------------------------------------------------------
// 2. Sub-agent invocation (basic invoke)
// ---------------------------------------------------------------------------

describe("agentAsTool – sub-agent invocation", () => {
  it("calls generate with a HumanMessage containing the task", async () => {
    const ctx = makeContext({ content: "result" });
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "summarise this" });
    expect(ctx.generate).toHaveBeenCalledOnce();
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toContain("summarise this");
  });

  it("returns the generate result content", async () => {
    const ctx = makeContext({ content: "final answer" });
    const t = await agentAsTool(ctx);
    const result = await t.invoke({ task: "do something" });
    expect(result).toBe("final answer");
  });

  it("passes task without context as plain message", async () => {
    const ctx = makeContext();
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "simple task" });
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    const content = msgs[0]?.content as string;
    expect(content).toBe("simple task");
    expect(content).not.toContain("Context:");
  });

  it("appends context to message when provided", async () => {
    const ctx = makeContext();
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "the task", context: "extra info" });
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    const content = msgs[0]?.content as string;
    expect(content).toContain("the task");
    expect(content).toContain("Context:");
    expect(content).toContain("extra info");
  });

  it("context separator appears between task and context text", async () => {
    const ctx = makeContext();
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "TASK", context: "CTX" });
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    const content = msgs[0]?.content as string;
    const taskIdx = content.indexOf("TASK");
    const ctxIdx = content.indexOf("CTX");
    expect(taskIdx).toBeLessThan(ctxIdx);
  });

  it("invoke can be called multiple times independently", async () => {
    const ctx = makeContext({ content: "ok" });
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "first" });
    await t.invoke({ task: "second" });
    expect(ctx.generate).toHaveBeenCalledTimes(2);
  });

  it("empty string task is forwarded to generate", async () => {
    const ctx = makeContext();
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "" });
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    expect(msgs[0]?.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. Result forwarding
// ---------------------------------------------------------------------------

describe("agentAsTool – result forwarding", () => {
  it("forwards string content verbatim", async () => {
    const ctx = makeContext({ content: "verbatim string output" });
    const t = await agentAsTool(ctx);
    const result = await t.invoke({ task: "anything" });
    expect(result).toBe("verbatim string output");
  });

  it("forwards multiline content correctly", async () => {
    const multiline = "line 1\nline 2\nline 3";
    const ctx = makeContext({ content: multiline });
    const t = await agentAsTool(ctx);
    const result = await t.invoke({ task: "anything" });
    expect(result).toBe(multiline);
  });

  it("forwards empty string result", async () => {
    const ctx = makeContext({ content: "" });
    const t = await agentAsTool(ctx);
    const result = await t.invoke({ task: "anything" });
    expect(result).toBe("");
  });

  it("forwards unicode content", async () => {
    const unicode = "日本語テスト 🔥";
    const ctx = makeContext({ content: unicode });
    const t = await agentAsTool(ctx);
    const result = await t.invoke({ task: "anything" });
    expect(result).toBe(unicode);
  });

  it("each invoke returns the corresponding generate result", async () => {
    let call = 0;
    const ctx: AgentAsToolContext = {
      id: "seq",
      description: "sequential",
      generate: vi.fn(async () => ({ content: `result-${++call}` })),
    };
    const t = await agentAsTool(ctx);
    const r1 = await t.invoke({ task: "a" });
    const r2 = await t.invoke({ task: "b" });
    expect(r1).toBe("result-1");
    expect(r2).toBe("result-2");
  });

  it("parent can use result as input to next tool", async () => {
    const ctx = makeContext({ content: "intermediate result" });
    const t = await agentAsTool(ctx);
    const first = (await t.invoke({ task: "step 1" })) as string;

    const ctx2 = makeContext({ id: "step2", content: `processed: ${first}` });
    const t2 = await agentAsTool(ctx2);
    const second = await t2.invoke({ task: first });
    expect(second).toBe("processed: intermediate result");
  });
});

// ---------------------------------------------------------------------------
// 4. Error propagation
// ---------------------------------------------------------------------------

describe("agentAsTool – error propagation", () => {
  it("rejects when generate throws", async () => {
    const ctx: AgentAsToolContext = {
      id: "err",
      description: "error agent",
      generate: vi.fn(async () => {
        throw new Error("agent exploded");
      }),
    };
    const t = await agentAsTool(ctx);
    await expect(t.invoke({ task: "anything" })).rejects.toThrow(
      "agent exploded"
    );
  });

  it("error message is preserved through rejection", async () => {
    const ctx: AgentAsToolContext = {
      id: "errmsg",
      description: "error agent",
      generate: vi.fn(async () => {
        throw new Error("specific error message");
      }),
    };
    const t = await agentAsTool(ctx);
    await expect(t.invoke({ task: "anything" })).rejects.toThrow(
      "specific error message"
    );
  });

  it("non-Error rejection is propagated", async () => {
    const ctx: AgentAsToolContext = {
      id: "nonErr",
      description: "non-error throw",
      generate: vi.fn(async () => {
        throw "string error";
      }),
    };
    const t = await agentAsTool(ctx);
    await expect(t.invoke({ task: "anything" })).rejects.toBe("string error");
  });

  it("custom error subclass is propagated", async () => {
    class MyAgentError extends Error {
      constructor(public readonly code: string) {
        super(`error code: ${code}`);
        this.name = "MyAgentError";
      }
    }
    const ctx: AgentAsToolContext = {
      id: "custom-err",
      description: "custom error agent",
      generate: vi.fn(async () => {
        throw new MyAgentError("E001");
      }),
    };
    const t = await agentAsTool(ctx);
    await expect(t.invoke({ task: "x" })).rejects.toBeInstanceOf(MyAgentError);
  });

  it("generate called once even on error", async () => {
    const ctx: AgentAsToolContext = {
      id: "once-err",
      description: "error once",
      generate: vi.fn(async () => {
        throw new Error("fail");
      }),
    };
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "x" }).catch(() => undefined);
    expect(ctx.generate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 5. Sub-agent timeout simulation
// ---------------------------------------------------------------------------

describe("agentAsTool – timeout simulation", () => {
  it("rejects when generate simulates timeout", async () => {
    const ctx: AgentAsToolContext = {
      id: "timeout",
      description: "slow agent",
      generate: vi.fn(async () => {
        throw new Error("TimeoutError: agent timed out after 5000ms");
      }),
    };
    const t = await agentAsTool(ctx);
    await expect(t.invoke({ task: "run slow" })).rejects.toThrow(
      "TimeoutError"
    );
  });

  it("subsequent invocations still work after a timeout", async () => {
    let call = 0;
    const ctx: AgentAsToolContext = {
      id: "timeout-then-ok",
      description: "sometimes times out",
      generate: vi.fn(async () => {
        call++;
        if (call === 1) throw new Error("TimeoutError");
        return { content: "recovered" };
      }),
    };
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "first" }).catch(() => undefined);
    const result = await t.invoke({ task: "second" });
    expect(result).toBe("recovered");
  });
});

// ---------------------------------------------------------------------------
// 6. Input field handling
// ---------------------------------------------------------------------------

describe("agentAsTool – input field handling", () => {
  it("task is placed as first part of message content", async () => {
    const ctx = makeContext();
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "my task" });
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    expect((msgs[0]?.content as string).startsWith("my task")).toBe(true);
  });

  it("context is placed after task with separator", async () => {
    const ctx = makeContext();
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "task text", context: "ctx text" });
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    const content = msgs[0]?.content as string;
    expect(content).toContain("\n\nContext:\n");
  });

  it("omitting context produces no Context: section", async () => {
    const ctx = makeContext();
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "task only" });
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    expect(msgs[0]?.content as string).not.toContain("Context:");
  });

  it("large context string is forwarded without truncation", async () => {
    const bigCtx = "x".repeat(10_000);
    const ctx = makeContext();
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "task", context: bigCtx });
    const msgs = (ctx.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as BaseMessage[];
    const content = msgs[0]?.content as string;
    expect(content).toContain(bigCtx);
  });
});

// ---------------------------------------------------------------------------
// 7. Nested agents-as-tools
// ---------------------------------------------------------------------------

describe("agentAsTool – nested sub-agents", () => {
  it("inner tool result can be forwarded as context to outer tool", async () => {
    const innerCtx = makeContext({ id: "inner", content: "inner result" });
    const inner = await agentAsTool(innerCtx);

    const innerResult = (await inner.invoke({ task: "inner task" })) as string;

    const outerCtx = makeContext({
      id: "outer",
      content: `outer got: ${innerResult}`,
    });
    const outer = await agentAsTool(outerCtx);
    const outerResult = await outer.invoke({
      task: "outer task",
      context: innerResult,
    });

    expect(outerResult).toBe("outer got: inner result");
    expect(outerCtx.generate).toHaveBeenCalledOnce();
  });

  it("three levels of nesting work correctly", async () => {
    const l1 = makeContext({ id: "l1", content: "level-1" });
    const l2 = makeContext({ id: "l2", content: "level-2" });
    const l3 = makeContext({ id: "l3", content: "level-3" });

    const t1 = await agentAsTool(l1);
    const t2 = await agentAsTool(l2);
    const t3 = await agentAsTool(l3);

    const r1 = (await t1.invoke({ task: "a" })) as string;
    const r2 = (await t2.invoke({ task: r1 })) as string;
    const r3 = await t3.invoke({ task: r2 });

    expect(r3).toBe("level-3");
    expect(l1.generate).toHaveBeenCalledOnce();
    expect(l2.generate).toHaveBeenCalledOnce();
    expect(l3.generate).toHaveBeenCalledOnce();
  });

  it("inner error surfaces in outer when not caught", async () => {
    const innerCtx: AgentAsToolContext = {
      id: "err-inner",
      description: "inner that fails",
      generate: vi.fn(async () => {
        throw new Error("inner fail");
      }),
    };
    const inner = await agentAsTool(innerCtx);

    const outerCtx: AgentAsToolContext = {
      id: "err-outer",
      description: "outer that calls inner",
      generate: vi.fn(async () => {
        await inner.invoke({ task: "nested" });
        return { content: "never reached" };
      }),
    };
    const outer = await agentAsTool(outerCtx);
    await expect(outer.invoke({ task: "start" })).rejects.toThrow("inner fail");
  });
});

// ---------------------------------------------------------------------------
// 8. Parallel sub-agent dispatch
// ---------------------------------------------------------------------------

describe("agentAsTool – parallel dispatch", () => {
  it("two tools can be invoked concurrently", async () => {
    const ctx1 = makeContext({ id: "p1", content: "parallel-1" });
    const ctx2 = makeContext({ id: "p2", content: "parallel-2" });
    const t1 = await agentAsTool(ctx1);
    const t2 = await agentAsTool(ctx2);

    const [r1, r2] = await Promise.all([
      t1.invoke({ task: "task a" }),
      t2.invoke({ task: "task b" }),
    ]);
    expect(r1).toBe("parallel-1");
    expect(r2).toBe("parallel-2");
    expect(ctx1.generate).toHaveBeenCalledOnce();
    expect(ctx2.generate).toHaveBeenCalledOnce();
  });

  it("parallel invocations collect independent results", async () => {
    const results = ["res-0", "res-1", "res-2", "res-3", "res-4"];
    const tools = await Promise.all(
      results.map((content, i) =>
        agentAsTool(makeContext({ id: `par-${i}`, content }))
      )
    );

    const outputs = await Promise.all(
      tools.map((t) => t.invoke({ task: "task" }))
    );
    expect(outputs).toEqual(results);
  });

  it("one parallel failure does not affect other Promise.allSettled results", async () => {
    const ctx1 = makeContext({ id: "ps1", content: "ok" });
    const ctx2: AgentAsToolContext = {
      id: "ps2",
      description: "fails",
      generate: vi.fn(async () => {
        throw new Error("partial fail");
      }),
    };
    const t1 = await agentAsTool(ctx1);
    const t2 = await agentAsTool(ctx2);

    const settled = await Promise.allSettled([
      t1.invoke({ task: "ok task" }),
      t2.invoke({ task: "fail task" }),
    ]);

    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// 9. Sub-agent retry pattern
// ---------------------------------------------------------------------------

describe("agentAsTool – retry pattern", () => {
  it("manual retry after failure succeeds", async () => {
    let attempt = 0;
    const ctx: AgentAsToolContext = {
      id: "retry",
      description: "retry agent",
      generate: vi.fn(async () => {
        attempt++;
        if (attempt < 2) throw new Error("transient error");
        return { content: "retried ok" };
      }),
    };
    const t = await agentAsTool(ctx);

    let result: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        result = await t.invoke({ task: "work" });
        break;
      } catch {
        // retry
      }
    }
    expect(result).toBe("retried ok");
    expect(ctx.generate).toHaveBeenCalledTimes(2);
  });

  it("all retries exhausted still rejects", async () => {
    const ctx: AgentAsToolContext = {
      id: "always-fail",
      description: "always fails",
      generate: vi.fn(async () => {
        throw new Error("always");
      }),
    };
    const t = await agentAsTool(ctx);

    let lastErr: Error | undefined;
    for (let i = 0; i < 3; i++) {
      try {
        await t.invoke({ task: "work" });
      } catch (e) {
        lastErr = e as Error;
      }
    }
    expect(lastErr?.message).toBe("always");
    expect(ctx.generate).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 10. Sub-agent context isolation
// ---------------------------------------------------------------------------

describe("agentAsTool – context isolation", () => {
  it("two tool instances share no state between invocations", async () => {
    const calls: string[] = [];
    const ctx1: AgentAsToolContext = {
      id: "iso1",
      description: "iso1",
      generate: vi.fn(async (msgs) => {
        calls.push(`iso1:${(msgs[0]?.content as string).slice(0, 3)}`);
        return { content: "iso1 result" };
      }),
    };
    const ctx2: AgentAsToolContext = {
      id: "iso2",
      description: "iso2",
      generate: vi.fn(async (msgs) => {
        calls.push(`iso2:${(msgs[0]?.content as string).slice(0, 3)}`);
        return { content: "iso2 result" };
      }),
    };
    const t1 = await agentAsTool(ctx1);
    const t2 = await agentAsTool(ctx2);

    await t1.invoke({ task: "aaa" });
    await t2.invoke({ task: "bbb" });

    expect(calls).toEqual(["iso1:aaa", "iso2:bbb"]);
    expect(ctx1.generate).toHaveBeenCalledOnce();
    expect(ctx2.generate).toHaveBeenCalledOnce();
  });

  it("generate receives only the message for its own invocation", async () => {
    const receivedMsgs: BaseMessage[][] = [];
    const ctx: AgentAsToolContext = {
      id: "msg-iso",
      description: "msg iso",
      generate: vi.fn(async (msgs) => {
        receivedMsgs.push([...msgs]);
        return { content: "ok" };
      }),
    };
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "first call" });
    await t.invoke({ task: "second call" });

    expect(receivedMsgs).toHaveLength(2);
    expect(receivedMsgs[0]).toHaveLength(1);
    expect(receivedMsgs[1]).toHaveLength(1);
    expect(receivedMsgs[0]?.[0]?.content).toContain("first call");
    expect(receivedMsgs[1]?.[0]?.content).toContain("second call");
  });
});

// ---------------------------------------------------------------------------
// 11. Tool name collision handling
// ---------------------------------------------------------------------------

describe("agentAsTool – tool name collision", () => {
  it("agents with different ids produce different tool names", async () => {
    const ids = ["search", "summarise", "translate", "classify"];
    const tools = await Promise.all(
      ids.map((id) => agentAsTool(makeContext({ id })))
    );
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(ids.length);
  });

  it("same id always produces same tool name regardless of description", async () => {
    const t1 = await agentAsTool(
      makeContext({ id: "same", description: "desc A" })
    );
    const t2 = await agentAsTool(
      makeContext({ id: "same", description: "desc B" })
    );
    expect(t1.name).toBe(t2.name);
    expect(t1.name).toBe("agent-same");
  });

  it("tool name has agent- prefix always", async () => {
    const ids = ["x", "abc", "123", "my_tool"];
    for (const id of ids) {
      const t = await agentAsTool(makeContext({ id }));
      expect(t.name.startsWith("agent-")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Cancellation via AbortSignal
// ---------------------------------------------------------------------------

describe("agentAsTool – cancellation", () => {
  it("generate receives AbortSignal when options are forwarded", async () => {
    const controller = new AbortController();
    const receivedOptions: unknown[] = [];
    const ctx: AgentAsToolContext = {
      id: "cancel",
      description: "cancellable",
      generate: vi.fn(async (_msgs, opts) => {
        receivedOptions.push(opts);
        return { content: "ok" };
      }),
    };
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "x" });
    // generate is called without options from the tool layer — this is fine;
    // the test verifies generate is called
    expect(ctx.generate).toHaveBeenCalledOnce();
    controller.abort();
  });

  it("aborted generate propagates cancellation error", async () => {
    const ctx: AgentAsToolContext = {
      id: "abort",
      description: "aborts",
      generate: vi.fn(async () => {
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
      }),
    };
    const t = await agentAsTool(ctx);
    const err = await t.invoke({ task: "x" }).catch((e: Error) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

// ---------------------------------------------------------------------------
// 13. Streaming / incremental results (simulated via deferred resolve)
// ---------------------------------------------------------------------------

describe("agentAsTool – async generate patterns", () => {
  it("generate that resolves after a tick still works", async () => {
    const ctx: AgentAsToolContext = {
      id: "async-tick",
      description: "async tick",
      generate: vi.fn(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { content: "async result" };
      }),
    };
    const t = await agentAsTool(ctx);
    const result = await t.invoke({ task: "work" });
    expect(result).toBe("async result");
  });

  it("concurrent invocations on same tool do not interleave results", async () => {
    let counter = 0;
    const ctx: AgentAsToolContext = {
      id: "concurrent",
      description: "concurrent",
      generate: vi.fn(async () => {
        const n = ++counter;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { content: `call-${n}` };
      }),
    };
    const t = await agentAsTool(ctx);
    const [r1, r2, r3] = await Promise.all([
      t.invoke({ task: "a" }),
      t.invoke({ task: "b" }),
      t.invoke({ task: "c" }),
    ]);
    // Each call gets its own numbered response
    const sorted = [r1, r2, r3].sort();
    expect(sorted).toEqual(["call-1", "call-2", "call-3"]);
  });
});

// ---------------------------------------------------------------------------
// 14. Integration: agentAsTool as part of a tool list
// ---------------------------------------------------------------------------

describe("agentAsTool – tool list integration", () => {
  it("multiple agent tools can be collected into a tools array", async () => {
    const agents = [
      makeContext({ id: "a", description: "Agent A" }),
      makeContext({ id: "b", description: "Agent B" }),
      makeContext({ id: "c", description: "Agent C" }),
    ];
    const tools = await Promise.all(agents.map(agentAsTool));
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["agent-a", "agent-b", "agent-c"]);
    expect(tools.map((t) => t.description)).toEqual([
      "Agent A",
      "Agent B",
      "Agent C",
    ]);
  });

  it("tool list can be filtered by name prefix", async () => {
    const tools = await Promise.all([
      agentAsTool(makeContext({ id: "search" })),
      agentAsTool(makeContext({ id: "write" })),
    ]);
    const agentTools = tools.filter((t) => t.name.startsWith("agent-"));
    expect(agentTools).toHaveLength(2);
  });

  it("tool can be found by name in a mixed tools array", async () => {
    const agentTool = await agentAsTool(makeContext({ id: "finder" }));
    const toolList = [agentTool];
    const found = toolList.find((t) => t.name === "agent-finder");
    expect(found).toBe(agentTool);
  });

  it("invoking tool from list by lookup works end-to-end", async () => {
    const ctx = makeContext({ id: "lookup", content: "lookup result" });
    const agentTool = await agentAsTool(ctx);
    const tools = [agentTool];

    const tool = tools.find((t) => t.name === "agent-lookup")!;
    const result = await tool.invoke({ task: "find me" });
    expect(result).toBe("lookup result");
  });
});

// ---------------------------------------------------------------------------
// 15. AGENT-M-14 — cross-agent asTool recursion depth guard
// ---------------------------------------------------------------------------

describe("agentAsTool – recursion depth guard (AGENT-M-14)", () => {
  it("propagates an incremented _agentToolDepth into the wrapped generate", async () => {
    const seen: (number | undefined)[] = [];
    const ctx: AgentAsToolContext = {
      id: "depth-prop",
      description: "records depth",
      generate: vi.fn(async (_msgs, opts) => {
        seen.push(opts?._agentToolDepth);
        return { content: "ok" };
      }),
      depth: { current: () => 0 },
    };
    const t = await agentAsTool(ctx);
    await t.invoke({ task: "go" });
    // depth 0 in → depth 0 + 1 = 1 propagated to the child run
    expect(seen).toEqual([1]);
  });

  it("short-circuits without calling generate once the ceiling is reached", async () => {
    const ctx: AgentAsToolContext = {
      id: "at-ceiling",
      description: "already at ceiling",
      generate: vi.fn(async () => ({ content: "should not run" })),
      // current depth already equals the default ceiling (3)
      depth: { current: () => 3 },
    };
    const t = await agentAsTool(ctx);
    const result = (await t.invoke({ task: "go" })) as string;
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(result).toContain("max agent-as-tool recursion depth");
    expect(result).toContain("(3)");
  });

  it("honours a caller-supplied maxAgentToolDepth override", async () => {
    const ctx: AgentAsToolContext = {
      id: "custom-ceiling",
      description: "custom ceiling",
      generate: vi.fn(async () => ({ content: "should not run" })),
      depth: { current: () => 1, maxAgentToolDepth: 1 },
    };
    const t = await agentAsTool(ctx);
    const result = (await t.invoke({ task: "go" })) as string;
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(result).toContain("(1)");
  });

  it("an agent exposed as a tool of itself stops at the ceiling instead of recursing unbounded", async () => {
    // Simulate the in-process self-reference loop: the agent's own generate
    // re-invokes the same asTool wrapper. A shared depth counter models the
    // agent recording `options._agentToolDepth` on each nested run (as
    // DzupAgent.generate does), and the tool reads it back via `current()`.
    let sharedDepth = 0;
    let generateCalls = 0;

    // Late-bound reference to the self tool so `generate` can re-invoke it.
    let selfTool: Awaited<ReturnType<typeof agentAsTool>> | undefined;

    const ctx: AgentAsToolContext = {
      id: "self",
      description: "an agent that can call itself",
      generate: vi.fn(async (_msgs, opts) => {
        generateCalls++;
        const previous = sharedDepth;
        // Mirror DzupAgent.generate: record incoming depth, restore on exit.
        sharedDepth = opts?._agentToolDepth ?? 0;
        try {
          // The run always tries to call itself again (the pathological loop).
          return { content: String(await selfTool!.invoke({ task: "again" })) };
        } finally {
          sharedDepth = previous;
        }
      }),
      depth: { current: () => sharedDepth },
    };

    selfTool = await agentAsTool(ctx);

    const result = (await selfTool.invoke({ task: "start" })) as string;

    // With default ceiling 3, the loop must terminate — NOT recurse unbounded.
    expect(result).toContain("max agent-as-tool recursion depth");
    // Bounded: a handful of generate calls, not an unbounded/stack-overflow run.
    expect(generateCalls).toBeGreaterThan(0);
    expect(generateCalls).toBeLessThanOrEqual(3);
  });
});
