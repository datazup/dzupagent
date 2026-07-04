import { describe, it, expect } from "vitest";
import { ReplayEngine } from "../replay/replay-engine.js";
import { ReplayController } from "../replay/replay-controller.js";
import {
  ReplaySessionNotFoundError,
  ReplayIndexOutOfBoundsError,
} from "../replay/replay-types.js";
import type { CapturedTrace } from "../replay/replay-types.js";

function makeTrace(eventCount: number): CapturedTrace {
  return {
    schemaVersion: "1.0.0",
    runId: "run-fork-test",
    events: Array.from({ length: eventCount }, (_, i) => ({
      index: i,
      timestamp: 1700000000000 + i * 1000,
      type: i === 0 ? "run_started" : "step_completed",
      data: { step: i },
    })),
    startedAt: 1700000000000,
    config: { snapshotInterval: 0 },
  };
}

describe("ReplayController.fork", () => {
  it("forks a session at a valid mid-trace index", () => {
    const engine = new ReplayEngine();
    const session = engine.createSession(makeTrace(10));
    const controller = new ReplayController(session, engine);

    const forked = controller.fork(4);

    expect(forked.id).not.toBe(session.id);
    expect(forked.events).toHaveLength(5);
    expect(forked.currentIndex).toBe(4);
    expect(forked.status).toBe("paused");
  });

  it("post-fork mutations are isolated between original and fork", () => {
    const engine = new ReplayEngine();
    const session = engine.createSession(makeTrace(10));
    const controller = new ReplayController(session, engine);
    const forked = controller.fork(4);
    const forkedController = new ReplayController(forked, engine);

    controller.seekTo(8);
    forkedController.seekTo(2);

    const originalAfter = engine.getSession(session.id);
    const forkedAfter = engine.getSession(forked.id);
    expect(originalAfter?.currentIndex).toBe(8);
    expect(forkedAfter?.currentIndex).toBe(2);
  });

  it("forks at index 0 (boundary case)", () => {
    const engine = new ReplayEngine();
    const session = engine.createSession(makeTrace(10));
    const controller = new ReplayController(session, engine);

    const forked = controller.fork(0);
    expect(forked.events).toHaveLength(1);
  });

  it("forks at the last index (boundary case)", () => {
    const engine = new ReplayEngine();
    const session = engine.createSession(makeTrace(10));
    const controller = new ReplayController(session, engine);

    const forked = controller.fork(9);
    expect(forked.events).toHaveLength(10);
  });

  it("throws ReplayIndexOutOfBoundsError for an invalid index", () => {
    const engine = new ReplayEngine();
    const session = engine.createSession(makeTrace(10));
    const controller = new ReplayController(session, engine);

    expect(() => controller.fork(-1)).toThrow(ReplayIndexOutOfBoundsError);
    expect(() => controller.fork(10)).toThrow(ReplayIndexOutOfBoundsError);
  });

  it("throws ReplaySessionNotFoundError when the engine no longer has the bound session", () => {
    const engine = new ReplayEngine();
    const session = engine.createSession(makeTrace(10));
    const controller = new ReplayController(session, engine);
    engine.deleteSession(session.id);

    expect(() => controller.fork(0)).toThrow(ReplaySessionNotFoundError);
  });

  it("breakpoints on a fork do not appear on the original", () => {
    const engine = new ReplayEngine();
    const session = engine.createSession(makeTrace(10));
    const controller = new ReplayController(session, engine);
    const forked = controller.fork(4);
    const forkedController = new ReplayController(forked, engine);

    forkedController.addBreakpoint({
      id: "bp-1",
      type: "node-id",
      value: "some-node",
      enabled: true,
    });

    const originalAfter = engine.getSession(session.id);
    const forkedAfter = engine.getSession(forked.id);
    expect(originalAfter?.breakpoints).toHaveLength(0);
    expect(forkedAfter?.breakpoints).toHaveLength(1);
  });
});
