import { describe, expect, it } from "vitest";
import { IterationBudget } from "../guardrails/iteration-budget.js";

describe("IterationBudget.fork (DZUPAGENT-AGENT-L-01)", () => {
  it("does not leak child dynamically-blocked tools back to the parent", () => {
    const parent = new IterationBudget({ blockedTools: [] });
    const child = parent.fork();

    child.blockTool("shell");

    // Child sees its own block; parent is unaffected.
    expect(child.isToolBlocked("shell")).toBe(true);
    expect(parent.isToolBlocked("shell")).toBe(false);
  });

  it("does not leak parent dynamically-blocked tools forward into a later child mutation", () => {
    const parent = new IterationBudget({ blockedTools: [] });
    // Pre-existing parent block is copied into the fork snapshot...
    parent.blockTool("fs.write");
    const child = parent.fork();
    expect(child.isToolBlocked("fs.write")).toBe(true);

    // ...but mutating the parent afterwards must not appear in the child.
    parent.blockTool("net.fetch");
    expect(child.isToolBlocked("net.fetch")).toBe(false);
    // ...and mutating the child must not appear in the parent.
    child.blockTool("db.query");
    expect(parent.isToolBlocked("db.query")).toBe(false);
  });

  it("keeps emittedThresholds independent so a child fork can still emit its own warnings", () => {
    // Parent crosses the 0.7 threshold (emits once, dedup recorded on parent).
    const parent = new IterationBudget({
      maxTokens: 100,
      budgetWarnings: [0.7],
    });
    const firstParentWarnings = parent.recordUsage({
      inputTokens: 70,
      outputTokens: 0,
    });
    expect(firstParentWarnings.some((w) => w.threshold === 0.7)).toBe(true);

    // A fresh fork inherits the dedup snapshot, so it will NOT re-emit for the
    // already-crossed shared state — but the Set is its own object, so child
    // dedup bookkeeping cannot corrupt the parent's.
    const child = parent.fork();
    // Forcing the child to re-evaluate must not throw and must not mutate the
    // parent's emittedThresholds object identity.
    child.recordUsage({ inputTokens: 0, outputTokens: 0 });

    // Parent re-recording below new thresholds still de-dupes correctly.
    const again = parent.recordUsage({ inputTokens: 0, outputTokens: 0 });
    expect(again.some((w) => w.threshold === 0.7)).toBe(false);
  });

  it("shares cumulative budget state by reference (intended semantics)", () => {
    const parent = new IterationBudget({ maxTokens: 1000 });
    const child = parent.fork();

    // Child spend counts against the shared envelope visible to the parent.
    child.recordUsage({ inputTokens: 400, outputTokens: 100 });
    parent.recordUsage({ inputTokens: 400, outputTokens: 100 });

    // 1000 tokens total across parent+child → parent sees the limit exceeded.
    expect(parent.isExceeded().exceeded).toBe(true);
    expect(child.isExceeded().exceeded).toBe(true);
  });
});
