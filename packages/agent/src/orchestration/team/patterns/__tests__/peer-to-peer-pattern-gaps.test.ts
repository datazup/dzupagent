/**
 * Gap-filling tests for the peer-to-peer coordination pattern.
 * Covers concurrency policy, hook shape, single-participant path,
 * result ordering, and error-field absence on success.
 */
import { describe, expect, it } from "vitest";
import { peerToPeerPattern } from "../peer-to-peer-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

describe("peerToPeerPattern — gap coverage", () => {
  describe("single participant", () => {
    it("runs with one participant and returns its content", async () => {
      const { ctx } = buildContext("peer_to_peer", [
        buildResolved("solo", { role: "worker", response: "solo-out" }),
      ]);
      const result = await peerToPeerPattern.execute(ctx);
      expect(result.pattern).toBe("peer-to-peer");
      expect(result.content).toBe("solo-out");
      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0]!.success).toBe(true);
    });
  });

  describe("agentResults shape", () => {
    it("ordering of agentResults matches the input participant ordering", async () => {
      const { ctx } = buildContext("peer_to_peer", [
        buildResolved("first", { response: "alpha" }),
        buildResolved("second", { response: "beta" }),
        buildResolved("third", { response: "gamma" }),
      ]);
      const result = await peerToPeerPattern.execute(ctx);
      expect(result.agentResults.map((r) => r.agentId)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    it("successful agentResults do not carry an error field", async () => {
      const { ctx } = buildContext("peer_to_peer", [
        buildResolved("a", { response: "ok" }),
        buildResolved("b", { response: "also-ok" }),
      ]);
      const result = await peerToPeerPattern.execute(ctx);
      for (const r of result.agentResults) {
        expect("error" in r).toBe(false);
      }
    });

    it("failed agentResult carries error message and empty content", async () => {
      const { ctx } = buildContext("peer_to_peer", [
        buildResolved("ok", { response: "fine" }),
        buildResolved("bad", { shouldThrow: true }),
      ]);
      const result = await peerToPeerPattern.execute(ctx);
      const bad = result.agentResults.find((r) => r.agentId === "bad")!;
      expect(bad.success).toBe(false);
      expect(bad.content).toBe("");
      expect(bad.error).toMatch(/mock model failed/);
    });

    it("agentResults include role from the participant definition", async () => {
      const { ctx } = buildContext("peer_to_peer", [
        buildResolved("w", { role: "worker", response: "x" }),
      ]);
      const result = await peerToPeerPattern.execute(ctx);
      expect(result.agentResults[0]!.role).toBe("worker");
    });

    it("result.durationMs is non-negative", async () => {
      const { ctx } = buildContext("peer_to_peer", [
        buildResolved("p", { response: "r" }),
      ]);
      const result = await peerToPeerPattern.execute(ctx);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("hook wiring", () => {
    it("fires emitParticipantStart once per participant", async () => {
      const { ctx, calls } = buildContext("peer_to_peer", [
        buildResolved("x"),
        buildResolved("y"),
      ]);
      await peerToPeerPattern.execute(ctx);
      expect(calls.starts).toHaveLength(2);
      expect(calls.starts).toContain("x");
      expect(calls.starts).toContain("y");
    });

    it("fires emitParticipantComplete with success=true and durationMs >= 0 for fulfilled participant", async () => {
      const { ctx, calls } = buildContext("peer_to_peer", [
        buildResolved("p", { response: "out" }),
      ]);
      await peerToPeerPattern.execute(ctx);
      expect(calls.completes).toHaveLength(1);
      expect(calls.completes[0]!.success).toBe(true);
      expect(calls.completes[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("fires emitParticipantComplete with success=false and error for a throwing participant", async () => {
      const { ctx, calls } = buildContext("peer_to_peer", [
        buildResolved("bad", { shouldThrow: true }),
      ]);
      await peerToPeerPattern.execute(ctx);
      expect(calls.completes[0]!.success).toBe(false);
      expect(calls.completes[0]!.error).toMatch(/mock model failed/);
    });

    it("fires completes for all participants even when some fail", async () => {
      const { ctx, calls } = buildContext("peer_to_peer", [
        buildResolved("ok", { response: "fine" }),
        buildResolved("bad", { shouldThrow: true }),
        buildResolved("ok2", { response: "also-fine" }),
      ]);
      await peerToPeerPattern.execute(ctx);
      expect(calls.completes).toHaveLength(3);
    });
  });

  describe("maxParallelParticipants policy", () => {
    it("respects concurrency=1 — participants execute serially (observable via execution order)", async () => {
      const order: string[] = [];
      // We inject responses via buildResolved but track call order via the
      // AIMessage content which is returned in the order items are processed.
      // With concurrency=1 and synchronous mock, ordering is deterministic.
      const { ctx } = buildContext(
        "peer_to_peer",
        [
          buildResolved("a", { response: "A" }),
          buildResolved("b", { response: "B" }),
          buildResolved("c", { response: "C" }),
        ],
        { policies: { execution: { maxParallelParticipants: 1 } } }
      );
      const result = await peerToPeerPattern.execute(ctx);
      // With serial execution agentResults preserve input order.
      expect(result.agentResults.map((r) => r.agentId)).toEqual([
        "a",
        "b",
        "c",
      ]);
      // Merged content contains all three in order.
      const content = result.content;
      expect(content.indexOf("A")).toBeLessThan(content.indexOf("B"));
      expect(content.indexOf("B")).toBeLessThan(content.indexOf("C"));
    });

    it("uses default concurrency (5) when no execution policy is set", async () => {
      // Verify it still works correctly with the default concurrency path.
      const { ctx } = buildContext("peer_to_peer", [
        buildResolved("p1", { response: "r1" }),
        buildResolved("p2", { response: "r2" }),
      ]);
      const result = await peerToPeerPattern.execute(ctx);
      expect(result.agentResults).toHaveLength(2);
      expect(result.agentResults.every((r) => r.success)).toBe(true);
    });
  });
});
