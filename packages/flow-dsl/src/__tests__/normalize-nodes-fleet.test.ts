import { describe, it, expect } from "vitest";
import { normalizeFleetNode } from "../normalize-nodes-fleet.js";

describe("normalizeFleetNode", () => {
  it("normalizes a minimal fleet.dispatch node", () => {
    const raw = {
      id: "d1",
      type: "fleet.dispatch",
      mode: "fan-out",
      repos: "${run.repos}",
      task: "${run.task}",
    };
    const result = normalizeFleetNode(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.type).toBe("fleet.dispatch");
      if (result.node.type === "fleet.dispatch") {
        expect(result.node.mode).toBe("fan-out");
      }
    }
  });

  it("rejects fleet.dispatch with invalid mode", () => {
    const raw = {
      id: "d1",
      type: "fleet.dispatch",
      mode: "nope",
      repos: [],
      task: {},
    };
    const result = normalizeFleetNode(raw);
    expect(result.ok).toBe(false);
  });

  it("normalizes a knowledge.write node", () => {
    const raw = {
      id: "w1",
      type: "knowledge.write",
      scope: "run:r1",
      entry: { kind: "lesson" },
    };
    const result = normalizeFleetNode(raw);
    expect(result.ok).toBe(true);
  });

  it("normalizes a knowledge.query node and requires output", () => {
    expect(
      normalizeFleetNode({
        id: "q",
        type: "knowledge.query",
        filter: {},
        output: "x",
      }).ok
    ).toBe(true);
    expect(
      normalizeFleetNode({ id: "q", type: "knowledge.query", filter: {} }).ok
    ).toBe(false);
  });

  it("returns ok=null for unrelated node types", () => {
    const result = normalizeFleetNode({ id: "a", type: "agent" });
    expect(result.ok).toBeNull();
  });
});
