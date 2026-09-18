/**
 * DSL-V2-HOST-BRIDGE-20260918 — the framework V2 host bridge for conditional
 * `for_each` items (plan §5), through the public PipelineRuntime.
 *
 * Every case uses the anchored fixture definition and the in-memory V2 host:
 * the host's `dispatchLeaf` is the only route that can run an execution or
 * effect leaf, the checkpoint store is the durable carrier of the V2 record,
 * and settlement charges exactly the recorded leaves.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PipelineCheckpoint, PipelineCheckpointCommitReceipt } from "@dzupagent/core/pipeline";
import { PipelineCheckpointSchema } from "@dzupagent/core/pipeline";
import {
  materializeLoopEconomicsEvidenceV2,
  type LoopEconomicsEvidenceV2,
} from "@dzupagent/runtime-contracts/loop-economics-evidence-v2";
import {
  LOOP_ECONOMICS_EVIDENCE_SCHEMA,
  materializeLoopEconomicsEvidence,
} from "@dzupagent/runtime-contracts/loop-economics-evidence";
import { CANONICAL_JSON_VERSION } from "@dzupagent/runtime-contracts";

import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { validatePipeline } from "../pipeline/pipeline-validator.js";
import type { LoopBudgetStrictHost } from "../pipeline/loop-executor/budget-types.js";
import {
  binding,
  checkpoints,
  createV2Host,
  emptyLedger,
  executor,
  predicates,
  reservationFor,
  settledCents,
  v2BranchDefinition,
  type V2HostFaults,
  type V2Ledger,
} from "./fixtures/for-each-v2-host-bridge-fixture.js";

function itemEconomics(cp: PipelineCheckpoint, index: number) {
  return cp.loopState?.items?.itemOutcomes?.[String(index)]?.economics;
}

function rematerialize(evidence: LoopEconomicsEvidenceV2, patch: Partial<LoopEconomicsEvidenceV2>): LoopEconomicsEvidenceV2 {
  const { admissionDigest: _a, evidenceDigest: _e, ...input } = evidence;
  return materializeLoopEconomicsEvidenceV2({ ...input, ...patch } as Parameters<typeof materializeLoopEconomicsEvidenceV2>[0]);
}

async function run(options: {
  items?: number[];
  concurrency?: number;
  emptyElse?: boolean;
  ledger?: V2Ledger;
  store?: InMemoryPipelineCheckpointStore;
  failing?: ReadonlySet<string>;
  signal?: AbortSignal;
  faults?: V2HostFaults;
  predicates?: typeof predicates;
}) {
  const ledger = options.ledger ?? emptyLedger();
  const { host, faults } = createV2Host({ ledger, ...(options.faults === undefined ? {} : { faults: options.faults }) });
  const store = options.store ?? new InMemoryPipelineCheckpointStore();
  const calls: string[] = [];
  const outside: string[] = [];
  const definition = v2BranchDefinition(options.concurrency ?? 1, options.emptyElse ?? false);
  const runtime = new PipelineRuntime({
    definition, predicates: options.predicates ?? predicates, checkpointStore: store,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    loopIterationBudgetReservation: host,
    nodeExecutor: executor(calls, ledger, outside, options.failing),
  });
  const result = await runtime.execute({ items: options.items ?? [0, 1] });
  return { result, ledger, faults, store, calls, outside, definition, host, runtime };
}

async function resume(cp: PipelineCheckpoint, options: {
  ledger: V2Ledger;
  store?: InMemoryPipelineCheckpointStore;
  faults?: V2HostFaults;
  predicates?: Record<string, (state: Record<string, unknown>) => boolean>;
  emptyElse?: boolean;
  host?: LoopBudgetStrictHost;
}) {
  const { host } = createV2Host({ ledger: options.ledger, ...(options.faults === undefined ? {} : { faults: options.faults }) });
  const store = options.store ?? new InMemoryPipelineCheckpointStore();
  // The resumed run continues the retained version line, as a real restart does.
  await store.save(structuredClone(cp));
  const calls: string[] = [];
  const outside: string[] = [];
  const result = await new PipelineRuntime({
    definition: v2BranchDefinition(1, options.emptyElse ?? false), predicates: options.predicates ?? predicates,
    checkpointStore: store, loopIterationBudgetReservation: options.host ?? host,
    nodeExecutor: executor(calls, options.ledger, outside),
  }).resume(cp);
  return { result, calls, outside, store };
}

describe("DSL-V2-HOST-BRIDGE-20260918: conditional for_each items under the strict V2 profile", () => {
  it.each([1, 2])("settles exactly the recorded leaves through one authority at concurrency %s", async (concurrency) => {
    const { result, ledger, outside, store, definition } = await run({ items: [0, 1, 2], concurrency });
    expect(validatePipeline(definition).errors).toEqual([]);
    expect(result.state, result.error).toBe("completed");
    expect(result.nodeResults.get("done")?.output).toEqual(["after:item-0", "after:item-1", "after:item-2"]);
    // One authority: no leaf node ever ran outside a host dispatch, every
    // dispatched key executed exactly once, and nothing was replayed.
    expect(outside).toEqual([]);
    expect(ledger.executions).toEqual(ledger.dispatches);
    expect(ledger.replays).toEqual([]);
    expect(new Set(ledger.dispatches).size).toBe(ledger.dispatches.length);
    const rows = Object.values(ledger.rows);
    expect(rows.map((row) => row.state)).toEqual(["settled", "settled", "settled"]);
    expect(rows.map((row) => row.cost)).toEqual([4, 2, 4]);
    expect(ledger.charges).toEqual({ "0": 1, "1": 1, "2": 1 });
    const cp = (await checkpoints(store, result.runId)).at(-1)!;
    for (const index of [0, 1, 2]) {
      const economics = itemEconomics(cp, index)!;
      expect(economics.evidenceV2?.resolution.status).toBe("settled");
      expect(economics.leafOutcomesV2).toBeUndefined();
      expect(settledCents(economics.evidenceV2)).toBe(economics.settledCostCents);
      const selected = economics.evidenceV2!.controlSelections[0];
      expect(selected?.kind === "branch" ? selected.selectedBranch : null).toBe(index % 2 === 0 ? "then" : "else");
      const outcomes = economics.evidenceV2!.resolution.status === "settled" ? economics.evidenceV2!.resolution.outcomes : [];
      const byLeaf = Object.fromEntries(outcomes.map((outcome) => [outcome.leafId, outcome.status === "released" ? `released:${outcome.reason}` : outcome.status]));
      expect(byLeaf).toEqual(index % 2 === 0
        ? { "execution:root.nodes[0].body[0]": "recorded", "charge:root.nodes[0].body[0]": "recorded", "execution:root.nodes[0].body[1].then[0]": "recorded", "charge:root.nodes[0].body[1].then[0]": "recorded", "effect:root.nodes[0].body[1].else[0]": "released:not-selected" }
        : { "execution:root.nodes[0].body[0]": "recorded", "charge:root.nodes[0].body[0]": "recorded", "execution:root.nodes[0].body[1].then[0]": "released:not-selected", "charge:root.nodes[0].body[1].then[0]": "released:not-selected", "effect:root.nodes[0].body[1].else[0]": "recorded" });
    }
  });

  it("selects the absent else from the authored structure and releases the then arm", async () => {
    const { result, ledger, store } = await run({ items: [1], emptyElse: true });
    expect(result.state, result.error).toBe("completed");
    expect(result.nodeResults.get("done")?.output).toEqual(["after:item-1"]);
    expect(ledger.dispatches).toHaveLength(1);
    const economics = itemEconomics((await checkpoints(store, result.runId)).at(-1)!, 0)!;
    const selected = economics.evidenceV2!.controlSelections[0];
    expect(selected?.kind === "branch" ? selected.selectedBranch : null).toBe("else");
    expect(economics.settledCostCents).toBe(2);
    expect(Object.values(ledger.rows).map((row) => row.state)).toEqual(["settled"]);
  });

  describe("identity (§3.1)", () => {
    it.each([
      ["a foreign leaf", (e: LoopEconomicsEvidenceV2) => rematerialize(e, { leaves: [...e.leaves, { ...e.leaves.at(-1)!, leafId: "effect:foreign", order: e.leaves.length, idempotencyKey: "foreign-key", nodePath: ["items", "ghost"], controlRequirements: [] } as never] })],
      ["reordered leaves", (e: LoopEconomicsEvidenceV2) => rematerialize(e, { leaves: [e.leaves[1]!, e.leaves[0]!, ...e.leaves.slice(2)].map((leaf, order) => ({ ...leaf, order })) as never })],
      ["a key the framework did not derive", (e: LoopEconomicsEvidenceV2) => rematerialize(e, { leaves: e.leaves.map((leaf, index) => index === 0 ? { ...leaf, idempotencyKey: "someone-elses-key" } : leaf) as never })],
      ["another attempt", (e: LoopEconomicsEvidenceV2) => rematerialize(e, { unitAttempt: 1 })],
      ["another definition", (e: LoopEconomicsEvidenceV2) => rematerialize(e, { definitionDigest: `sha256:${"1".repeat(64)}` })],
    ])("denies a record with %s before any dispatch and releases the hold", async (_label, mutateAdmission) => {
      const { result, ledger } = await run({ faults: { mutateAdmission } });
      expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/invalid V2 selected\/skipped-leaf economics/) });
      expect(ledger.dispatches).toEqual([]);
      expect(Object.values(ledger.rows).map((row) => row.state)).toEqual(["released"]);
    });

    it("denies a host that answers V1 evidence or no record", async () => {
      for (const faults of [{ answerV1: true }, { answerNone: true }]) {
        const { result, ledger } = await run({ faults });
        expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/V1 exact evidence|no V2 selected\/skipped-leaf record/) });
        expect(ledger.dispatches).toEqual([]);
      }
    });

    it("blocks a retained record that binds another definition", async () => {
      const first = await run({ items: [0] });
      const boundary = (await checkpoints(first.store, first.result.runId)).find((cp) => cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.nextNodeId === "yes")!;
      const frame = boundary.loopState!.items!.itemFrames!["0"]!;
      const forged = structuredClone(boundary);
      forged.loopState!.items!.itemFrames!["0"]!.economics!.evidenceV2 = rematerialize(frame.economics!.evidenceV2!, { definitionDigest: `sha256:${"2".repeat(64)}` });
      const ledger = emptyLedger();
      ledger.rows = structuredClone(first.ledger.rows);
      ledger.rows[frame.economics!.reservationId]!.state = "reserved";
      const resumed = await resume(forged, { ledger });
      expect(resumed.result).toMatchObject({ state: "failed", error: expect.stringMatching(/definitionDigest/) });
      expect(ledger.dispatches).toEqual([]);
    });
  });

  describe("profile", () => {
    it("still denies the V1 exact profile on a graph body, and the V2 profile on a flat body", async () => {
      const reserve = vi.fn(() => ({ status: "reserved" as const, reservedCostCents: 10 }));
      const v1: LoopBudgetStrictHost = { mode: "strict", evidenceMode: "required", itemBudgetCents: 10, reserve, settle: () => {}, release: () => {}, reconcile: () => ({ status: "unknown" }), measureItemCost: () => ({ status: "known", costCents: 1 }) };
      const graph = await new PipelineRuntime({ definition: v2BranchDefinition(), predicates, checkpointStore: new InMemoryPipelineCheckpointStore(), loopIterationBudgetReservation: v1, nodeExecutor: executor([], emptyLedger()) }).execute({ items: [0] });
      expect(graph).toMatchObject({ state: "failed", error: expect.stringMatching(/V2 selected\/skipped-leaf/) });
      expect(reserve).not.toHaveBeenCalled();

      const flat = v2BranchDefinition();
      const loop = flat.nodes[0]!;
      if (loop.type !== "loop") throw new Error("fixture");
      delete loop.bodyGraph;
      loop.bodyNodeIds = ["before", "after"];
      flat.nodes = flat.nodes.filter((node) => !["choose", "yes", "no"].includes(node.id));
      flat.edges = [{ type: "sequential", sourceNodeId: "before", targetNodeId: "after" }, { type: "sequential", sourceNodeId: "items", targetNodeId: "done" }];
      const { host, ledger } = createV2Host();
      const result = await new PipelineRuntime({ definition: flat, predicates, checkpointStore: new InMemoryPipelineCheckpointStore(), loopIterationBudgetReservation: host, nodeExecutor: executor([], ledger) }).execute({ items: [0] });
      expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/admits only a compiler-lowered graph body/) });
      expect(ledger.dispatches).toEqual([]);
    });

    it("never downgrades a retained V2 record or upgrades a retained V1 record", async () => {
      const first = await run({ items: [0] });
      const boundary = (await checkpoints(first.store, first.result.runId)).find((cp) => cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.nextNodeId === "yes")!;
      const v1: LoopBudgetStrictHost = { mode: "strict", itemBudgetCents: 10, reserve: () => ({ status: "reserved", reservedCostCents: 10 }), settle: () => {}, release: () => {}, reconcile: () => ({ status: "reserved", reservedCostCents: 4 }), measureItemCost: () => ({ status: "known", costCents: 1 }) };
      const calls: string[] = [];
      const downgraded = await new PipelineRuntime({ definition: v2BranchDefinition(), predicates, checkpointStore: new InMemoryPipelineCheckpointStore(), loopIterationBudgetReservation: v1, nodeExecutor: executor(calls, emptyLedger()) }).resume(boundary);
      expect(downgraded).toMatchObject({ state: "failed", error: expect.stringMatching(/downgrade is denied/) });
      expect(calls).toEqual([]);

      // A V1 record can only be planted through a hand-written checkpoint; the
      // schema refuses it beside the V2 record, and the loop refuses it alone.
      const evidence = materializeLoopEconomicsEvidence({
        schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA, canonicalization: CANONICAL_JSON_VERSION,
        owner: { runId: boundary.pipelineRunId, loopNodeId: "items", reservationId: `resv:v1:${boundary.pipelineRunId}:item:items:0`, unit: { kind: "item", itemIndex: 0, iteration: 1, attempt: 0 } },
        executions: ["before", "yes"].map((nodeId) => ({ nodeId, binding, money: { status: "priced" as const, reservation: reservationFor(nodeId), tariffDigest: `sha256:${"a".repeat(64)}` as const }, quota: { status: "not-applicable" as const } })),
        effectIntents: [], terminal: { status: "pending" },
      });
      const both = structuredClone(boundary);
      both.loopState!.items!.itemFrames!["0"]!.economics!.evidence = evidence;
      expect(PipelineCheckpointSchema.safeParse(both).success).toBe(false);
      const planted = structuredClone(boundary);
      const economics = planted.loopState!.items!.itemFrames!["0"]!.economics!;
      delete economics.evidenceV2;
      delete economics.leafOutcomesV2;
      economics.evidence = evidence;
      const ledger = emptyLedger();
      const upgraded = await resume(planted, { ledger });
      expect(upgraded.result).toMatchObject({ state: "failed", error: expect.stringMatching(/V1 exact-evidence execution is not admitted/) });
      expect(ledger.dispatches).toEqual([]);
    });
  });

  describe("resume and reconciliation (§3.4)", () => {
    it("resumes every durable boundary without re-evaluating the selection or re-executing a recorded leaf", async () => {
      const first = await run({ items: [0, 1] });
      expect(first.result.state, first.result.error).toBe("completed");
      const boundaries = (await checkpoints(first.store, first.result.runId)).filter((cp) => cp.loopState?.items?.itemFrames?.["0"]?.graph !== undefined || (cp.loopState?.items?.iteration ?? 0) > 0);
      expect(boundaries.length).toBeGreaterThanOrEqual(6);
      for (const cp of boundaries) {
        const ledger = emptyLedger();
        ledger.rows = structuredClone(first.ledger.rows);
        // The host retains exactly what it had done by this boundary: receipts
        // for items that had started, and rows not yet settled stay reserved.
        const items = cp.loopState?.items;
        const started = (index: number) => items?.itemFrames?.[String(index)] !== undefined || items?.itemOutcomes?.[String(index)] !== undefined;
        const settledAt = (index: number) => items?.itemFrames?.[String(index)]?.economics?.settledCostCents !== undefined || items?.itemOutcomes?.[String(index)]?.economics?.settledCostCents !== undefined;
        ledger.receipts = Object.fromEntries(Object.entries(first.ledger.receipts).filter(([, receipt]) => started(receipt.itemIndex)));
        for (const row of Object.values(ledger.rows)) row.state = settledAt(row.itemIndex) ? "settled" : "reserved";
        const seeded = new Set(Object.keys(ledger.receipts));
        const changed = vi.fn(() => false);
        const resumed = await resume(cp, { ledger, predicates: { choose: changed } });
        expect(resumed.result.state, `${cp.version}: ${resumed.result.error}`).toBe("completed");
        expect(resumed.result.nodeResults.get("done")?.output).toEqual(["after:item-0", "after:item-1"]);
        expect(resumed.outside).toEqual([]);
        // A leaf the first run recorded is answered from the retained receipt,
        // never executed again; a leaf it had not reached executes once.
        expect(ledger.executions.filter((key) => seeded.has(key))).toEqual([]);
        const frame0 = cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame;
        const chooseRecorded = frame0?.completedNodeIds.includes("choose") === true || cp.loopState?.items?.itemOutcomes?.["0"]?.outcome === "completed";
        // Item 0's recorded selection is never re-evaluated; item 1's gate still evaluates its own.
        if (chooseRecorded) expect(changed.mock.calls.filter(([state]) => (state as Record<string, unknown>).item === 0)).toEqual([]);
        expect(Object.values(ledger.rows).map((row) => row.state)).toEqual(["settled", "settled"]);
        // A recorded selection is honoured (then: before+yes, 4 cents); before
        // the gate completed, the changed predicate legitimately selects else.
        expect(Object.values(ledger.rows).map((row) => row.cost)).toEqual([chooseRecorded ? 4 : 2, 2]);
        // An item the first run had already settled is restored, never charged again.
        expect(ledger.charges["0"] ?? 0).toBe(settledAt(0) ? 0 : 1);
        expect(ledger.charges["1"] ?? 0).toBe(settledAt(1) ? 0 : 1);
      }
    });

    it("blocks a retained selection that disagrees with its frame (rows 1–2)", async () => {
      const first = await run({ items: [0] });
      const boundary = (await checkpoints(first.store, first.result.runId)).find((cp) => cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.nextNodeId === "yes")!;
      const forged = structuredClone(boundary);
      const economics = forged.loopState!.items!.itemFrames!["0"]!.economics!;
      economics.evidenceV2 = rematerialize(economics.evidenceV2!, { controlSelections: [{ kind: "branch", nodePath: economics.evidenceV2!.controlSelections[0]!.nodePath, selectedBranch: "else" }] });
      const ledger = emptyLedger();
      ledger.rows = structuredClone(first.ledger.rows);
      ledger.rows[economics.reservationId]!.state = "reserved";
      ledger.receipts = structuredClone(first.ledger.receipts);
      const resumed = await resume(forged, { ledger });
      expect(resumed.result).toMatchObject({ state: "failed", error: expect.stringMatching(/recorded selection "else" disagrees with the durable frame/) });
      expect(resumed.calls).toEqual([]);
      expect(ledger.dispatches).toEqual([]);
    });

    it("re-presents a dispatched leaf whose acknowledgement was lost under the same key (row 3)", async () => {
      const ledger = emptyLedger();
      const lostKey = (key: string) => key.includes(":yes") && ledger.executions.length === 2;
      const first = await run({ items: [0], ledger, faults: { throwAfterExecute: (key) => lostKey(key) && ledger.dispatches.length === 2 } });
      expect(first.result).toMatchObject({ state: "failed", error: expect.stringMatching(/V2 leaf accounting is unresolved.*dispatch-acknowledgement-lost/) });
      const cp = (await checkpoints(first.store, first.result.runId)).at(-1)!;
      const terminal = cp.loopState!.items!.itemOutcomes!["0"]!;
      expect(terminal.outcome).toBe("outcome_unknown");
      expect(terminal.economics!.leafOutcomesV2!.filter((outcome) => outcome.status === "unknown").map((outcome) => outcome.leafId)).toEqual(["execution:root.nodes[0].body[1].then[0]", "charge:root.nodes[0].body[1].then[0]"]);
      // Nothing was released or settled while the leaf was unproven.
      expect(Object.values(ledger.rows).map((row) => row.state)).toEqual(["reserved"]);
      expect(ledger.executions).toHaveLength(2);
      const resumed = await resume(cp, { ledger });
      expect(resumed.result.state, resumed.result.error).toBe("completed");
      // The same key was presented again and answered from custody: one
      // logical call, one charge.
      expect(ledger.executions).toHaveLength(2);
      expect(ledger.replays).toEqual([ledger.executions[1]]);
      expect(Object.values(ledger.rows).map((row) => `${row.state}:${row.cost}`)).toEqual(["settled:4"]);
      expect(ledger.charges).toEqual({ "0": 1 });
    });

    it("replays a retained result when the graph checkpoint after the leaf was lost (row 4)", async () => {
      class LoseAfterYes extends InMemoryPipelineCheckpointStore {
        lost = false;
        override async saveIfVersion(cp: PipelineCheckpoint, expected: number): Promise<PipelineCheckpointCommitReceipt> {
          if (!this.lost && cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.completedNodeIds.includes("yes")) {
            this.lost = true;
            return { committed: false, observedVersion: 999 };
          }
          return super.saveIfVersion(cp, expected);
        }
      }
      const store = new LoseAfterYes();
      const ledger = emptyLedger();
      const first = await run({ items: [0], ledger, store });
      expect(store.lost).toBe(true);
      expect(first.result.state).toBe("failed");
      const cp = (await checkpoints(store, first.result.runId)).at(-1)!;
      expect(cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.nextNodeId).toBe("yes");
      expect(ledger.executions).toHaveLength(2);
      const resumed = await resume(cp, { ledger });
      expect(resumed.result.state, resumed.result.error).toBe("completed");
      expect(ledger.executions).toHaveLength(2);
      expect(ledger.replays).toEqual([ledger.executions[1]]);
      expect(resumed.calls).not.toContain("yes:0");
      expect(Object.values(ledger.rows).map((row) => `${row.state}:${row.cost}`)).toEqual(["settled:4"]);
    });

    it("blocks a receipt whose result custody is missing and invents no output (row 5)", async () => {
      const ledger = emptyLedger();
      const first = await run({ items: [0], ledger, faults: { throwAfterExecute: (key) => key.includes(":yes") } });
      expect(first.result.state).toBe("failed");
      const cp = (await checkpoints(first.store, first.result.runId)).at(-1)!;
      const resumed = await resume(cp, { ledger, faults: { resultMissing: (key) => key.includes(":yes") } });
      expect(resumed.result).toMatchObject({ state: "failed", error: expect.stringMatching(/unresolved.*receipt-unavailable/) });
      expect(resumed.calls).not.toContain("after:0");
      expect(ledger.executions).toHaveLength(2);
      expect(Object.values(ledger.rows).map((row) => row.state)).toEqual(["reserved"]);
      const again = (await resumed.store.load(resumed.result.runId))!;
      expect(again.loopState?.items?.itemOutcomes?.["0"]?.outcome).toBe("outcome_unknown");
      expect(again.loopState?.items?.itemOutcomes?.["0"]?.economics?.leafOutcomesV2?.some((o) => o.status === "unknown" && o.reason === "receipt-unavailable")).toBe(true);
    });

    it("reconciles a settlement whose item checkpoint was lost without a second charge (row 6)", async () => {
      class LoseCompleted extends InMemoryPipelineCheckpointStore {
        lost = false;
        override async saveIfVersion(cp: PipelineCheckpoint, expected: number): Promise<PipelineCheckpointCommitReceipt> {
          if (!this.lost && cp.loopState?.items?.itemFrames?.["0"]?.outcome === "completed") {
            this.lost = true;
            return { committed: false, observedVersion: 999 };
          }
          return super.saveIfVersion(cp, expected);
        }
      }
      const store = new LoseCompleted();
      const ledger = emptyLedger();
      const first = await run({ items: [0], ledger, store });
      expect(store.lost).toBe(true);
      expect(first.result.state).toBe("failed");
      expect(ledger.charges).toEqual({ "0": 1 });
      const cp = (await checkpoints(store, first.result.runId)).at(-1)!;
      expect(cp.loopState?.items?.itemFrames?.["0"]?.outcome).toBe("running");
      const resumed = await resume(cp, { ledger });
      expect(resumed.result.state, resumed.result.error).toBe("completed");
      expect(ledger.charges).toEqual({ "0": 1 });
      expect(ledger.executions).toHaveLength(2);
      expect(resumed.calls).not.toContain("yes:0");
      expect(Object.values(ledger.rows).map((row) => `${row.state}:${row.cost}`)).toEqual(["settled:4"]);
    });
  });

  describe("release", () => {
    it("keeps recorded charges and releases the rest when a leaf fails", async () => {
      const { result, ledger, store } = await run({ items: [0], failing: new Set(["yes"]) });
      expect(result.state).toBe("failed");
      expect(Object.values(ledger.rows).map((row) => row.state)).toEqual(["released"]);
      const economics = itemEconomics((await checkpoints(store, result.runId)).at(-1)!, 0)!;
      expect(economics.evidenceV2?.resolution.status).toBe("settled");
      const outcomes = economics.evidenceV2!.resolution.status === "settled" ? economics.evidenceV2!.resolution.outcomes : [];
      expect(outcomes.map((outcome) => `${outcome.leafId.split(":")[0]}:${outcome.status}${outcome.status === "released" ? `/${outcome.reason}` : ""}`)).toEqual([
        "execution:recorded", "charge:recorded", "execution:recorded", "charge:recorded", "effect:released/not-selected",
      ]);
      expect(settledCents(economics.evidenceV2)).toBe(4);
    });

    it("releases every leaf as cancelled-before-dispatch when the host aborts first", async () => {
      const controller = new AbortController();
      controller.abort();
      const { result, ledger, store } = await run({ items: [0], signal: controller.signal });
      expect(result.state).not.toBe("completed");
      expect(ledger.dispatches).toEqual([]);
      const cp = (await checkpoints(store, result.runId)).at(-1);
      const economics = cp === undefined ? undefined : itemEconomics(cp, 0);
      if (economics !== undefined) {
        expect(economics.evidenceV2?.resolution.status).toBe("settled");
        const outcomes = economics.evidenceV2!.resolution.status === "settled" ? economics.evidenceV2!.resolution.outcomes : [];
        expect(outcomes).toHaveLength(5);
        expect(outcomes.filter((outcome) => outcome.status === "released" && outcome.reason === "cancelled-before-dispatch")).toHaveLength(5);
        expect(Object.values(ledger.rows).map((row) => row.state)).toEqual(["released"]);
      }
    });

    it("refuses to re-admit recorded leaves under a fresh attempt", async () => {
      const first = await run({ items: [0], failing: new Set(["yes"]) });
      const cp = (await checkpoints(first.store, first.result.runId)).at(-1)!;
      expect(cp.loopState?.items?.itemOutcomes?.["0"]?.outcome).toBe("failed");
      const ledger = emptyLedger();
      ledger.rows = structuredClone(first.ledger.rows);
      const resumed = await resume(cp, { ledger });
      expect(resumed.result).toMatchObject({ state: "failed", error: expect.stringMatching(/cannot adopt its retained progress under a fresh V2 admission/) });
      expect(ledger.dispatches).toEqual([]);
      expect(Object.values(ledger.rows).map((row) => `${row.attempt}:${row.state}`)).toEqual(["0:released", "1:released"]);
    });
  });

  it("fences concurrent siblings after a lost checkpoint commit", async () => {
    let park = (): void => {}, release = (): void => {}, lose = (): void => {};
    const parked = new Promise<void>((resolve) => { park = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const lost = new Promise<void>((resolve) => { lose = resolve; });
    class ConflictStore extends InMemoryPipelineCheckpointStore {
      refused = false;
      writesAfterRefusal = 0;
      override async saveIfVersion(cp: PipelineCheckpoint, expectedVersion: number): Promise<PipelineCheckpointCommitReceipt> {
        if (this.refused) this.writesAfterRefusal++;
        if (!this.refused && cp.loopState?.items?.itemFrames?.["0"]?.graph?.frame.nextNodeId === "yes") {
          this.refused = true; lose();
          return { committed: false, observedVersion: 999 };
        }
        return super.saveIfVersion(cp, expectedVersion);
      }
    }
    const store = new ConflictStore();
    const ledger = emptyLedger();
    const { host } = createV2Host({ ledger });
    const calls: string[] = [];
    const plain = executor(calls, ledger);
    const pending = new PipelineRuntime({
      definition: v2BranchDefinition(2), predicates, checkpointStore: store, loopIterationBudgetReservation: host,
      nodeExecutor: async (id, node, ctx) => {
        if (id === "before" && ctx.state.item === 1) { park(); await released; }
        if (id === "before" && ctx.state.item === 0) await parked;
        return plain(id, node, ctx);
      },
    }).execute({ items: [0, 1, 2] });
    await lost;
    release();
    const result = await pending;
    expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/conflict|commit/i) });
    expect(store.writesAfterRefusal).toBe(0);
    expect(Object.values(ledger.rows).map((row) => row.state)).toEqual(["reserved", "reserved"]);
    expect(ledger.charges).toEqual({});
    expect(ledger.dispatches.filter((key) => key.includes(":yes") || key.includes(":no"))).toEqual([]);
  });

  it.each(["selection", "leaf", "body", "settlement", "item", "parent"])("survives independent-process SIGKILL after %s", (cut) => {
    const directory = mkdtempSync(join(tmpdir(), "for-each-v2-"));
    const worker = fileURLToPath(new URL("./fixtures/for-each-v2-crash-worker.ts", import.meta.url));
    const tsconfig = join(directory, "runtime-tsconfig.json");
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { paths: {
      "@dzupagent/core/pipeline": [fileURLToPath(new URL("../../../core/src/pipeline.ts", import.meta.url))],
    } } }));
    const args = ["--import", "tsx", worker, "--run-v2-crash-worker", directory];
    const options = { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), encoding: "utf8" as const, timeout: 20000,
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig } };
    const killed = spawnSync(process.execPath, [...args, cut], options);
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const resumed = spawnSync(process.execPath, [...args, "none"], options);
    expect(resumed.status, resumed.stderr).toBe(0);
    const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    expect(result).toMatchObject({ state: "completed", answer: ["after:item-0", "after:item-1"] });
    const effects = readFileSync(join(directory, "effects.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { id: string; item?: number });
    const identities = effects.map(({ id, item }) => `${id}:${item ?? "outer"}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities).not.toContain("no:0"); expect(identities).not.toContain("yes:1");
    const ledger = JSON.parse(readFileSync(join(directory, "ledger.json"), "utf8")) as V2Ledger;
    expect(ledger.charges).toEqual({ "0": 1, "1": 1 });
    const rows = Object.values(ledger.rows);
    expect(rows.map((row) => `${row.state}:${row.cost}`)).toEqual(["settled:4", "settled:2"]);
    expect(new Set(ledger.executions).size).toBe(ledger.executions.length);
  });
});
