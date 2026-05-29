import { describe, it, expect } from "vitest";
import {
  lowerFleetNode,
  lowerKnowledgeNode,
  isFleetNode,
  collectFleetSteps,
} from "../lower/lower-fleet-nodes.js";
import type { FlowNode } from "@dzupagent/flow-ast";

describe("lowerFleetNode", () => {
  it("lowers fleet.dispatch to a runtime step calling FleetSupervisor.run", () => {
    const lowered = lowerFleetNode({
      id: "d1",
      type: "fleet.dispatch",
      mode: "fan-out",
      repos: [],
      task: {},
    } as never);
    expect(lowered.kind).toBe("fleet.dispatch");
    expect(lowered.factory).toBe(
      "@dzupagent/agent/orchestration#FleetSupervisor"
    );
    expect(lowered.id).toBe("d1");
    expect(lowered.handler).toBe("run");
    expect(lowered.payload).toEqual({
      type: "fleet.dispatch",
      mode: "fan-out",
      policy: "fan-out",
      repos: [],
      task: {},
    });
  });

  it("lowers fleet.gather with FleetSupervisor factory", () => {
    const lowered = lowerFleetNode({
      id: "g1",
      type: "fleet.gather",
      source: "outcomes",
    } as never);
    expect(lowered.kind).toBe("fleet.gather");
    expect(lowered.factory).toBe(
      "@dzupagent/agent/orchestration#FleetSupervisor"
    );
    expect(lowered.handler).toBe("gather");
    expect(lowered.payload).toEqual({
      type: "fleet.gather",
      source: "outcomes",
    });
  });

  it("lowers fleet.contract-net with FleetSupervisor factory", () => {
    const lowered = lowerFleetNode({
      id: "cn1",
      type: "fleet.contract-net",
      repos: ["repo-a"],
      task: { id: "work" },
    } as never);
    expect(lowered.kind).toBe("fleet.contract-net");
    expect(lowered.factory).toBe(
      "@dzupagent/agent/orchestration#FleetSupervisor"
    );
    expect(lowered.handler).toBe("run");
    expect(lowered.payload).toEqual({
      type: "fleet.contract-net",
      mode: "contract-net",
      policy: "contract-net",
      repos: ["repo-a"],
      task: { id: "work" },
    });
  });

  it("lowers knowledge.query to a runtime step calling KnowledgeStore.query", () => {
    const lowered = lowerFleetNode({
      id: "q1",
      type: "knowledge.query",
      filter: {},
      output: "x",
    } as never);
    expect(lowered.kind).toBe("knowledge.query");
    expect(lowered.factory).toBe(
      "@dzupagent/agent/orchestration#KnowledgeStore"
    );
    expect(lowered.handler).toBe("query");
    expect(lowered.payload).toEqual({
      type: "knowledge.query",
      filter: {},
      output: "x",
    });
  });

  it("lowers knowledge.write with KnowledgeStore factory", () => {
    const lowered = lowerFleetNode({
      id: "w1",
      type: "knowledge.write",
      scope: "run:r1",
      entry: { kind: "lesson" },
    } as never);
    expect(lowered.kind).toBe("knowledge.write");
    expect(lowered.factory).toBe(
      "@dzupagent/agent/orchestration#KnowledgeStore"
    );
    expect(lowered.handler).toBe("append");
    expect(lowered.payload).toEqual({
      type: "knowledge.write",
      scope: "run:r1",
      entry: { kind: "lesson" },
    });
  });

  it("lowers knowledge.write through lowerKnowledgeNode", () => {
    const lowered = lowerKnowledgeNode({
      id: "w2",
      type: "knowledge.write",
      scope: "run:r2",
      entry: { kind: "decision" },
    } as never);
    expect(lowered).toMatchObject({
      id: "w2",
      kind: "knowledge.write",
      handler: "append",
      payload: {
        type: "knowledge.write",
        scope: "run:r2",
        entry: { kind: "decision" },
      },
    });
  });

  it("throws on unsupported node type", () => {
    expect(() => lowerFleetNode({ id: "x", type: "action" } as never)).toThrow(
      "lowerFleetNode: unsupported type action"
    );
  });

  it("normalizes optional fleet.dispatch fields explicitly", () => {
    const node = {
      id: "d2",
      type: "fleet.dispatch",
      mode: "contract-net",
      repos: ["repo-a"],
      task: "ship it",
      on_contract_change: "reconcile",
      output: "outcomes",
    };
    const lowered = lowerFleetNode(node as never);
    expect(lowered.payload).toEqual({
      type: "fleet.dispatch",
      mode: "contract-net",
      policy: "contract-net",
      repos: ["repo-a"],
      task: "ship it",
      onContractChange: "reconcile",
      output: "outcomes",
    });
  });

  it("throws when required fleet fields are absent", () => {
    expect(() =>
      lowerFleetNode({
        id: "bad",
        type: "fleet.dispatch",
        mode: "fan-out",
        repos: [],
      } as never)
    ).toThrow("fleet.dispatch.task is required");

    expect(() =>
      lowerFleetNode({
        id: "bad",
        type: "fleet.gather",
      } as never)
    ).toThrow("fleet.gather.source must be a non-empty string");
  });
});

describe("isFleetNode", () => {
  it.each([
    "fleet.dispatch",
    "fleet.gather",
    "fleet.contract-net",
    "knowledge.write",
    "knowledge.query",
  ] as FlowNode["type"][])("returns true for %s", (type) => {
    expect(isFleetNode({ id: "x", type } as FlowNode)).toBe(true);
  });

  it.each(["action", "sequence", "complete", "agent"] as FlowNode["type"][])(
    "returns false for %s",
    (type) => {
      expect(isFleetNode({ id: "x", type } as FlowNode)).toBe(false);
    }
  );
});

describe("collectFleetSteps", () => {
  it("collects fleet nodes from a flat sequence", () => {
    const ast: FlowNode = {
      type: "sequence",
      nodes: [
        { id: "a", type: "action", toolRef: "tool.run", input: {} },
        {
          id: "d1",
          type: "fleet.dispatch",
          mode: "fan-out",
          repos: [],
          task: {},
        } as never,
        {
          id: "q1",
          type: "knowledge.query",
          filter: {},
          output: "matches",
        } as never,
      ],
    };
    const steps = collectFleetSteps(ast);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.id).toBe("d1");
    expect(steps[1]?.id).toBe("q1");
  });

  it("collects fleet nodes nested inside branch.then", () => {
    const ast: FlowNode = {
      type: "branch",
      condition: "ok",
      then: [
        {
          id: "cn1",
          type: "fleet.contract-net",
          repos: [],
          task: {},
        } as never,
      ],
    };
    const steps = collectFleetSteps(ast);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("fleet.contract-net");
  });

  it("returns empty array when no fleet nodes present", () => {
    const ast: FlowNode = {
      type: "sequence",
      nodes: [{ id: "a", type: "action", toolRef: "tool.run", input: {} }],
    };
    expect(collectFleetSteps(ast)).toHaveLength(0);
  });
});
