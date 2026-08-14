import { describe, expect, it, vi } from "vitest";

import {
  executeEffectOnce,
  materializeEffectIntent,
  validateEffectIntent,
  validateEffectReceipt,
  type EffectJournalRecord,
  type EffectJournalStore,
  type EffectJsonValue,
  type EffectReceipt,
} from "../effect-receipt.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const time = () => "2026-08-14T00:00:00.000Z";

class SharedEffectJournal<T extends EffectJsonValue>
  implements EffectJournalStore<T> {
  readonly records = new Map<string, EffectJournalRecord<T>>();

  async claim(intent: Parameters<EffectJournalStore<T>["claim"]>[0], claimedAt: string) {
    const existing = this.records.get(intent.idempotencyKey);
    if (existing !== undefined) return { status: "existing" as const, record: existing };
    this.records.set(intent.idempotencyKey, { status: "pending", intent, claimedAt });
    return { status: "claimed" as const };
  }

  async commit(
    intent: Parameters<EffectJournalStore<T>["commit"]>[0],
    receipt: EffectReceipt<T>,
  ) {
    const current = this.records.get(intent.idempotencyKey);
    if (current?.status !== "pending" || current.intent.intentDigest !== intent.intentDigest) {
      throw new Error("compare-and-set failed");
    }
    this.records.set(intent.idempotencyKey, { status: "committed", intent, receipt });
  }

  async markOutcomeUnknown(
    intent: Parameters<EffectJournalStore<T>["markOutcomeUnknown"]>[0],
    observedAt: string,
  ) {
    const current = this.records.get(intent.idempotencyKey);
    if (current?.status !== "pending" || current.intent.intentDigest !== intent.intentDigest) {
      throw new Error("compare-and-set failed");
    }
    this.records.set(intent.idempotencyKey, { status: "outcome-unknown", intent, observedAt });
  }
}

function intent(operationDigest = digest("a")) {
  return materializeEffectIntent({
    idempotencyKey: "dzup:v1:source:run-1:node-1:exactly-once:input",
    sourceHash: digest("d"),
    runId: "run-1",
    nodeId: "node-1",
    effectClass: "db_write",
    attemptPolicy: "exactly-once-required",
    operationDigest,
  });
}

describe("effect receipt restart semantics", () => {
  it("returns diagnostics instead of throwing on malformed or cyclic input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateEffectIntent(cyclic)).not.toThrow();
    expect(() => validateEffectReceipt({ result: cyclic })).not.toThrow();
    expect(validateEffectIntent(cyclic).valid).toBe(false);
    expect(validateEffectReceipt({ result: cyclic }).valid).toBe(false);
  });

  it("replays a committed receipt through a fresh coordinator without repeating the effect", async () => {
    const store = new SharedEffectJournal<{ readonly recordId: string }>();
    const effect = vi.fn(async () => ({ recordId: "record-1" }));
    const first = await executeEffectOnce({ store, intent: intent(), execute: effect, now: time });
    const afterRestart = await executeEffectOnce({
      store,
      intent: intent(),
      execute: effect,
      now: time,
    });

    expect(first).toEqual(expect.objectContaining({ status: "executed" }));
    expect(afterRestart).toEqual(expect.objectContaining({ status: "replayed" }));
    expect(effect).toHaveBeenCalledTimes(1);
    if (afterRestart.status !== "replayed") throw new Error("expected replay");
    expect(afterRestart.receipt.result).toEqual({ recordId: "record-1" });
    expect(validateEffectReceipt(afterRestart.receipt, intent())).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("dispatches when the otherwise identical restart has no journal record", async () => {
    const emptyRestartStore = new SharedEffectJournal<{ readonly recordId: string }>();
    const effect = vi.fn(async () => ({ recordId: "record-1" }));
    expect(await executeEffectOnce({
      store: emptyRestartStore,
      intent: intent(),
      execute: effect,
      now: time,
    })).toEqual(expect.objectContaining({ status: "executed" }));
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("blocks key reuse for a different operation instead of deduplicating it", async () => {
    const store = new SharedEffectJournal<{ readonly recordId: string }>();
    const effect = vi.fn(async () => ({ recordId: "record-1" }));
    await executeEffectOnce({ store, intent: intent(), execute: effect, now: time });
    const conflict = await executeEffectOnce({
      store,
      intent: intent(digest("c")),
      execute: effect,
      now: time,
    });
    expect(conflict).toEqual({ status: "blocked", reason: "idempotency-conflict" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("blocks a pending pre-crash intent rather than guessing it is safe to repeat", async () => {
    const store = new SharedEffectJournal<{ readonly recordId: string }>();
    await store.claim(intent(), time());
    const effect = vi.fn(async () => ({ recordId: "record-1" }));
    expect(await executeEffectOnce({ store, intent: intent(), execute: effect, now: time }))
      .toEqual({ status: "blocked", reason: "effect-outcome-unknown" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("persists outcome-unknown after a thrown dispatch and blocks restart redispatch", async () => {
    const store = new SharedEffectJournal<{ readonly recordId: string }>();
    const effect = vi.fn<() => Promise<{ readonly recordId: string }>>()
      .mockRejectedValueOnce(new Error("transport disconnected"))
      .mockResolvedValue({ recordId: "would-repeat" });
    expect(await executeEffectOnce({ store, intent: intent(), execute: effect, now: time }))
      .toEqual({ status: "blocked", reason: "effect-outcome-unknown" });
    expect(await executeEffectOnce({ store, intent: intent(), execute: effect, now: time }))
      .toEqual({ status: "blocked", reason: "effect-outcome-unknown" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("does not commit an invalid post-dispatch receipt", async () => {
    const store = new SharedEffectJournal<{ readonly recordId: string }>();
    expect(await executeEffectOnce({
      store,
      intent: intent(),
      execute: async () => ({ recordId: "record-1" }),
      now: () => "not-an-instant",
    })).toEqual({ status: "blocked", reason: "effect-outcome-unknown" });
    expect(store.records.get(intent().idempotencyKey)?.status).toBe("outcome-unknown");
  });

  it("rejects a result changed after the receipt was committed", async () => {
    const store = new SharedEffectJournal<{ readonly recordId: string }>();
    const executed = await executeEffectOnce({
      store,
      intent: intent(),
      execute: async () => ({ recordId: "record-1" }),
      now: time,
    });
    if (executed.status !== "executed") throw new Error("expected execution");
    expect(validateEffectReceipt({
      ...executed.receipt,
      result: { recordId: "tampered" },
    }).valid).toBe(false);
  });
});
