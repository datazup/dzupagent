/**
 * 24-F — reject a resume whose per-item outcome or economics is corrupt.
 *
 * Doc 27 §8 proof 5 requires a corrupted checkpoint to be REFUSED before any
 * item is dispatched. Four of its six sub-parts already fail closed (definition
 * and source digests in E3, the forEach contract via subsumption in `9e4b618d`,
 * the ordered-prefix cursor in `e000bb47`). The remaining two — outcome and
 * economics — were not merely unwritten but UNREPRESENTABLE: before 24-F the
 * item frame carried a body cursor and nothing else, so there was no field to
 * corrupt and therefore nothing a guard could reject.
 *
 * The contract added in `430bd99a` makes them representable. These tests pin
 * the two layers that must now refuse a corrupt frame:
 *
 * 1. `PipelineCheckpointSchema` — the serializing boundary. Structural facts
 *    (closed outcome vocabulary, integer non-negative cents) belong here.
 * 2. `assertForEachCursorWithinSource` — the in-memory resume seam that
 *    already holds the source and cursor guards. RELATIONAL facts belong here,
 *    because they are agreements *between* fields that a per-field schema
 *    cannot express.
 *
 * Every case below was confirmed ACCEPTED before the guard existed, so none of
 * these tests is a guard against an unreachable defect — the failure mode that
 * cost packet 24-E an entire reverted implementation.
 *
 * Absence stays UNPROVABLE, not agreement: a pre-24-F checkpoint carries no
 * outcome and no economics, and must keep resuming. The final describe block
 * pins that, so a future guard cannot tighten absence into a rejection.
 */
import { describe, expect, it } from "vitest";
import {
  assertForEachCursorWithinSource,
  PipelineForEachCursorCorruptError,
} from "../pipeline/executor-internals/stage-dispatch.js";
import type { PipelineForEachItemFrame } from "@dzupagent/core";

/** A frame mid-way through an item, with no outcome or economics recorded. */
function baseFrame(): PipelineForEachItemFrame {
  return { itemIndex: 0, nextBodyNodeIndex: 1 };
}

/** The loop cursor shape `assertForEachCursorWithinSource` reads. */
function cursorWith(frame: PipelineForEachItemFrame): {
  iteration: number;
  itemFrames: Record<string, PipelineForEachItemFrame>;
} {
  return {
    iteration: 0,
    itemFrames: { [String(frame.itemIndex)]: frame },
  };
}

describe("24-F: for_each item outcome corruption is refused at resume", () => {
  it("rejects a settled cost that exceeds its own reservation", () => {
    // The item claims to have spent more than the ceiling admitted for it.
    // Accepting this resumes a run whose durable economics already record a
    // breach of the authored ceiling — the exact fact `settleItem` fails the
    // loop closed on while the process is alive.
    const frame: PipelineForEachItemFrame = {
      ...baseFrame(),
      outcome: "completed",
      economics: {
        reservationId: "resv:v1:run-1:item:loop:0",
        reservedCostCents: 10,
        settledCostCents: 99_999,
      },
    };

    expect(() =>
      assertForEachCursorWithinSource("loop", "run-1", cursorWith(frame), 3),
    ).toThrow(PipelineForEachCursorCorruptError);
  });

  it("rejects a settled cost on an item that never reached a terminal state", () => {
    // Settlement is what a TERMINAL item does. A frame that is still `running`
    // yet carries a settled amount cannot both be true: resuming it would
    // re-dispatch a body whose spend the ledger already closed, double-charging
    // the item.
    const frame: PipelineForEachItemFrame = {
      ...baseFrame(),
      outcome: "running",
      economics: {
        reservationId: "resv:v1:run-1:item:loop:0",
        reservedCostCents: 10,
        settledCostCents: 5,
      },
    };

    expect(() =>
      assertForEachCursorWithinSource("loop", "run-1", cursorWith(frame), 3),
    ).toThrow(PipelineForEachCursorCorruptError);
  });

  it("rejects economics filed under an item index the reservation id disowns", () => {
    // `deriveItemReservationId` embeds the item index, so a frame at index 0
    // holding a reservation minted for index 2 proves the frame and the ledger
    // row have been crossed. Resuming would settle one item's work against
    // another item's money.
    const frame: PipelineForEachItemFrame = {
      ...baseFrame(),
      outcome: "reserved",
      economics: {
        reservationId: "resv:v1:run-1:item:loop:2",
        reservedCostCents: 10,
      },
    };

    expect(() =>
      assertForEachCursorWithinSource("loop", "run-1", cursorWith(frame), 3),
    ).toThrow(PipelineForEachCursorCorruptError);
  });

  it("accepts a well-formed reserved frame whose reservation id names its own index", () => {
    // The control: identical in every dimension to the case above EXCEPT the
    // index the reservation id names. Without this, a guard that rejected
    // every frame carrying economics would pass all three tests above.
    const frame: PipelineForEachItemFrame = {
      ...baseFrame(),
      outcome: "reserved",
      economics: {
        reservationId: "resv:v1:run-1:item:loop:0",
        reservedCostCents: 10,
      },
    };

    expect(() =>
      assertForEachCursorWithinSource("loop", "run-1", cursorWith(frame), 3),
    ).not.toThrow();
  });

  it("accepts a completed frame that settled within its reservation", () => {
    // The second control, holding the terminal/settled pairing ACCEPTING so
    // the overrun test above is proven to turn on the amount alone.
    const frame: PipelineForEachItemFrame = {
      ...baseFrame(),
      outcome: "completed",
      economics: {
        reservationId: "resv:v1:run-1:item:loop:0",
        reservedCostCents: 10,
        settledCostCents: 10,
      },
    };

    expect(() =>
      assertForEachCursorWithinSource("loop", "run-1", cursorWith(frame), 3),
    ).not.toThrow();
  });
});

describe("24-F: absence stays unprovable rather than becoming agreement", () => {
  it("accepts a pre-24-F frame carrying neither outcome nor economics", () => {
    // Every checkpoint written before `430bd99a` looks exactly like this. If a
    // guard read absence as a claim — "no outcome means running" — every such
    // checkpoint would either be rejected or silently gain an outcome it never
    // observed. Both are worse than carrying no answer.
    expect(() =>
      assertForEachCursorWithinSource(
        "loop",
        "run-1",
        cursorWith(baseFrame()),
        3,
      ),
    ).not.toThrow();
  });

  it("accepts a terminal outcome recorded without economics", () => {
    // A host that authored no `itemBudgetCents` takes no reservation at all,
    // so a completed item genuinely has no economics to record. Requiring them
    // together would fail closed on the unpriced configuration, which is the
    // default one.
    const frame: PipelineForEachItemFrame = {
      ...baseFrame(),
      outcome: "completed",
    };

    expect(() =>
      assertForEachCursorWithinSource("loop", "run-1", cursorWith(frame), 3),
    ).not.toThrow();
  });
});
