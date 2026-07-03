import { describe, expect, it } from "vitest";
import type {
  AdapterRuntimeEventBusEvent,
  FanoutRuntimeEvent,
  SubagentRuntimeEvent,
} from "../index.js";

describe("FanoutRuntimeEvent contract (dynamic-subagents Spec 03 §5)", () => {
  it("covers the full fan-out lifecycle discriminators", () => {
    const events: FanoutRuntimeEvent[] = [
      {
        type: "fanout:started",
        batchId: "b1",
        parentRunId: "run-1",
        mode: "template",
        declared: 3,
      },
      {
        type: "fanout:item_dispatched",
        batchId: "b1",
        itemKey: "a",
        taskId: "t1",
      },
      {
        type: "fanout:item_settled",
        batchId: "b1",
        itemKey: "a",
        taskId: "t1",
        status: "succeeded",
        durationMs: 12,
      },
      {
        type: "fanout:completed",
        batchId: "b1",
        dispatched: 3,
        succeeded: 2,
        failed: 1,
        uncovered: 0,
        wallClockMs: 100,
      },
      {
        type: "fanout:aborted",
        batchId: "b1",
        reason: "timeout",
        dispatched: 2,
      },
      { type: "fanout:progress", batchId: "b1", message: "2 of 3" },
    ];
    expect(events.map((e) => e.type)).toEqual([
      "fanout:started",
      "fanout:item_dispatched",
      "fanout:item_settled",
      "fanout:completed",
      "fanout:aborted",
      "fanout:progress",
    ]);
  });

  it("subagent:spawned accepts optional batchId/depth (additive)", () => {
    const legacy: SubagentRuntimeEvent = {
      type: "subagent:spawned",
      taskId: "t1",
      parentRunId: "run-1",
      agentId: "claude",
    };
    const batched: SubagentRuntimeEvent = {
      type: "subagent:spawned",
      taskId: "t2",
      parentRunId: "run-1",
      agentId: "claude",
      batchId: "b1",
      depth: 1,
    };
    expect(legacy.type).toBe("subagent:spawned");
    expect(batched.type).toBe("subagent:spawned");
  });

  it("fan-out events are bus-allowed adapter runtime events", () => {
    const event: AdapterRuntimeEventBusEvent = {
      type: "fanout:progress",
      batchId: "b1",
      message: "hi",
    };
    expect(event.type).toBe("fanout:progress");
  });
});
