/**
 * DZUPAGENT-AGENT-H-12 — a tool result is bounded before it enters history.
 */
import { describe, it, expect, vi } from "vitest";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { DzupEventBus } from "@dzupagent/core";
import {
  capToolResultForContext,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  executePolicyEnabledToolCall,
} from "../policy-enabled-tool-executor.js";
import type { ToolLoopConfig } from "../types.js";

function makeTool(output: string): StructuredToolInterface {
  return {
    name: "big",
    description: "returns a large payload",
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => output),
  } as unknown as StructuredToolInterface;
}

async function run(output: string, config: Partial<ToolLoopConfig> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const eventBus = {
    emit: vi.fn((e: unknown) => events.push(e as Record<string, unknown>)),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as DzupEventBus;
  const onToolResult = vi.fn();
  const tool = makeTool(output);
  const result = await executePolicyEnabledToolCall(
    { id: "tc_1", name: "big", args: {} },
    {
      toolMap: new Map([["big", tool]]),
      config: { maxIterations: 5, eventBus, runId: "run-1", onToolResult, ...config } as ToolLoopConfig,
      getOrCreateStat: () => ({ calls: 0, errors: 0, totalMs: 0 }),
    },
  );
  return { content: String(result.message.content), events, onToolResult };
}

describe("tool-result size cap", () => {
  it("a 1 MB result reaches the model capped, inside a closed fence, and the event reports truncation", async () => {
    const big = "x".repeat(1_000_000);
    const { content, events, onToolResult } = await run(big, { maxToolResultChars: 5_000 });

    expect(content.length).toBeLessThan(5_000 + 300);
    expect(content).toContain("[tool result truncated: kept 5000 of 1000000 characters]");
    expect(content.trimEnd().endsWith("</untrusted_content>")).toBe(true);
    expect(content.indexOf("[tool result truncated")).toBeLessThan(content.lastIndexOf("</untrusted_content>"));

    const resultEvent = events.find((e) => e["type"] === "tool:result");
    expect(resultEvent?.["truncation"]).toEqual({ originalChars: 1_000_000, keptChars: 5_000 });
    // Observability still sees the raw result.
    expect(onToolResult).toHaveBeenCalledWith("big", big);
  });

  it("applies the default cap when none is configured", async () => {
    const { content } = await run("y".repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 10));
    expect(content).toContain(`kept ${DEFAULT_MAX_TOOL_RESULT_CHARS} of`);
  });

  it("leaves small results and their event untouched", async () => {
    const { content, events } = await run("small");
    expect(content).not.toContain("truncated");
    expect(events.find((e) => e["type"] === "tool:result")).not.toHaveProperty("truncation");
  });

  it("Infinity disables the cap", () => {
    expect(capToolResultForContext("z".repeat(200_000), Infinity).truncation).toBeUndefined();
  });
});
