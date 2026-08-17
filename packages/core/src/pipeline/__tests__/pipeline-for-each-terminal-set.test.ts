/**
 * 24-G — the durable contract for the `for_each` per-item terminal set.
 *
 * The producers and the retirement-survival behaviour are proved end-to-end in
 * the agent package. What lives here is the part that is only observable at the
 * PARSE boundary, and that the agent suites structurally cannot exercise:
 *
 *   - The `schemaVersion` seam. The runtime writer and this validator are
 *     deliberately kept in agreement — a checkpoint carrying `itemOutcomes` is
 *     always stamped `1.1.0` — so no end-to-end run can ever present the
 *     disagreeing combination. That agreement is exactly why the validator half
 *     needs a direct test: without one, deleting the rule kills nothing and it
 *     reads as protection while doing nothing.
 *   - Key/record agreement and the closed field set, which reject an
 *     externally-authored or corrupted checkpoint rather than a self-produced
 *     one.
 */
import { describe, expect, it } from "vitest";

import { PipelineCheckpointSchema, type PipelineCheckpoint } from "../index.js";

/** A minimal checkpoint carrying one `for_each` terminal record. */
function checkpointWith(
  loopState: Record<string, unknown>,
  schemaVersion: "1.0.0" | "1.1.0" = "1.1.0"
): Record<string, unknown> {
  return {
    pipelineRunId: "run-1",
    pipelineId: "pipeline-1",
    version: 1,
    schemaVersion,
    completedNodeIds: [],
    state: {},
    createdAt: new Date(0).toISOString(),
    // `loopState` is cast at the FIELD rather than the whole object: these
    // tests pass malformed loop states precisely to assert the SCHEMA rejects
    // them, so the argument cannot be a real
    // `Record<string, PipelineLoopCheckpointState>`. Narrowing the escape
    // hatch to this one field keeps `satisfies` checking every other envelope
    // field, instead of a blanket cast that would let a typo in
    // `pipelineRunId` through unnoticed.
    // `NonNullable` because `loopState` is optional on the checkpoint and
    // `exactOptionalPropertyTypes` forbids writing `undefined` explicitly.
    loopState: loopState as NonNullable<PipelineCheckpoint["loopState"]>,
  } satisfies Partial<PipelineCheckpoint> as Record<string, unknown>;
}

const COMPLETED_ITEM = {
  itemIndex: 0,
  outcome: "completed",
  economics: {
    reservationId: "resv:v1:run-1:item:loop:0",
    reservedCostCents: 50,
    settledCostCents: 50,
  },
};

describe("24-G: for_each terminal set — schemaVersion seam", () => {
  it("refuses a 1.0.0 checkpoint that carries a terminal set", () => {
    // Follows the interaction-state precedent rather than being exempt from it.
    // The terminal set is load-bearing for accounting, so a `1.0.0` reader —
    // which has no rule for it — must not silently accept a checkpoint that
    // depends on it.
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith(
        { loop: { iteration: 1, itemOutcomes: { "0": COMPLETED_ITEM } } },
        "1.0.0"
      )
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "for_each per-item terminal outcomes require checkpoint schemaVersion 1.1.0"
    );
  });

  it("admits the same terminal set at 1.1.0", () => {
    // The negative control for the rule above: it must reject on the VERSION,
    // not on the terminal set being present at all.
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith(
        { loop: { iteration: 1, itemOutcomes: { "0": COMPLETED_ITEM } } },
        "1.1.0"
      )
    );
    expect(result.success).toBe(true);
  });

  it("still admits a 1.0.0 checkpoint that carries no terminal set", () => {
    // Absence stays unprovable in the other direction: pre-24-G checkpoints
    // carry no outcomes and must keep resuming untouched.
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith({ loop: { iteration: 1 } }, "1.0.0")
    );
    expect(result.success).toBe(true);
  });
});

describe("24-G: for_each terminal set — record integrity", () => {
  it("refuses a record whose key disagrees with its itemIndex", () => {
    // A key naming a different item than the record it holds would attribute
    // one item's outcome — and its settled cost — to another item.
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith({
        loop: {
          iteration: 1,
          itemOutcomes: { "3": { ...COMPLETED_ITEM, itemIndex: 0 } },
        },
      })
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "does not match its record"
    );
    expect(JSON.stringify(result.error?.issues)).toContain("itemOutcomes");
  });

  it("refuses a non-decimal item key", () => {
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith({
        loop: {
          iteration: 1,
          itemOutcomes: { "00": { ...COMPLETED_ITEM, itemIndex: 0 } },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("refuses an unrecognised outcome value", () => {
    // The vocabulary is closed. Admitting an unknown state would let a reader
    // fall through every terminal check and treat a settled item as running.
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith({
        loop: {
          iteration: 1,
          itemOutcomes: { "0": { ...COMPLETED_ITEM, outcome: "settled" } },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("refuses an unknown field on a terminal record", () => {
    // `.strict()`: an unrecognised key is a writer disagreeing with this
    // contract, and dropping it silently would let a checkpoint claim an
    // accounting fact no reader honours.
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith({
        loop: {
          iteration: 1,
          itemOutcomes: { "0": { ...COMPLETED_ITEM, refunded: true } },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("refuses a fractional settled cost", () => {
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith({
        loop: {
          iteration: 1,
          itemOutcomes: {
            "0": {
              ...COMPLETED_ITEM,
              economics: {
                ...COMPLETED_ITEM.economics,
                settledCostCents: 12.5,
              },
            },
          },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("admits a terminal record with no economics", () => {
    // A `cancelled` or `denied` item never opened a ledger row, so it must be
    // representable without economics rather than forced to claim a zero-cent
    // reservation that does not exist.
    const result = PipelineCheckpointSchema.safeParse(
      checkpointWith({
        loop: {
          iteration: 0,
          itemOutcomes: { "2": { itemIndex: 2, outcome: "cancelled" } },
        },
      })
    );
    expect(result.success).toBe(true);
  });
});
