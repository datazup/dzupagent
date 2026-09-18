/**
 * DSL-V2-HOST-BRIDGE-20260918 — the parse boundary of the V2 per-item
 * economics carrier.
 *
 * The item host proves selection, dispatch and settlement end-to-end in the
 * agent package. What lives here is what only the checkpoint schema can
 * refuse: a V2 record that does not validate, a record beside a V1 one, and
 * a retained outcome prefix that names a foreign leaf, repeats a leaf, or
 * disagrees with the admitted order — each of which a resumed loop would
 * otherwise read as accounting truth.
 */
import { describe, expect, it } from "vitest";
import { CANONICAL_JSON_VERSION } from "@dzupagent/runtime-contracts";
import {
  LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA,
  materializeLoopEconomicsEvidenceV2,
  type LoopEconomicsEvidenceV2,
  type LoopEconomicsLeafOutcomeV2,
} from "@dzupagent/runtime-contracts/loop-economics-evidence-v2";

import { PipelineCheckpointSchema, type PipelineCheckpoint } from "../index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

/** Two effect leaves under one branch selection; no priced execution, so reserved cents are 0. */
function pendingRecord(): LoopEconomicsEvidenceV2 {
  return materializeLoopEconomicsEvidenceV2({
    schema: LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    owner: {
      runId: "run-1",
      loopNodeId: "items",
      reservationId: "resv:v1:run-1:item:items:0",
      unit: { kind: "item", itemIndex: 0, iteration: 1, attempt: 0 },
    },
    definitionDigest: digest("d"),
    bodyPlanDigest: digest("b"),
    unitAttempt: 0,
    controlSelections: [{ kind: "branch", nodePath: ["items", "choose"], selectedBranch: null }],
    leaves: [
      {
        leafId: "effect:then",
        order: 0,
        nodePath: ["items", "choose", "yes"],
        controlRequirements: [{ selectionIndex: 0, kind: "branch", requiredBranch: "then" }],
        idempotencyKey: "key-then",
        fence: 1,
        kind: "effect",
        effect: { nodeId: "yes", intentDigest: digest("1") },
      },
      {
        leafId: "effect:else",
        order: 1,
        nodePath: ["items", "choose", "no"],
        controlRequirements: [{ selectionIndex: 0, kind: "branch", requiredBranch: "else" }],
        idempotencyKey: "key-else",
        fence: 1,
        kind: "effect",
        effect: { nodeId: "no", intentDigest: digest("2") },
      },
    ],
    resolution: { status: "pending" },
  });
}

const released: LoopEconomicsLeafOutcomeV2 = {
  leafId: "effect:else",
  kind: "effect",
  status: "released",
  reason: "not-selected",
  releaseDigest: digest("e"),
};
const recorded: LoopEconomicsLeafOutcomeV2 = {
  leafId: "effect:then",
  kind: "effect",
  status: "recorded",
  intentDigest: digest("1"),
  receiptDigest: digest("f"),
};

function checkpointWith(economics: Record<string, unknown>): Record<string, unknown> {
  return {
    pipelineRunId: "run-1",
    pipelineId: "pipeline-1",
    version: 1,
    schemaVersion: "1.1.0",
    completedNodeIds: [],
    state: {},
    createdAt: new Date(0).toISOString(),
    loopState: {
      items: {
        iteration: 0,
        itemFrames: { "0": { itemIndex: 0, nextBodyNodeIndex: 0, economics } },
      },
    } as NonNullable<PipelineCheckpoint["loopState"]>,
  } satisfies Partial<PipelineCheckpoint> as Record<string, unknown>;
}

function issues(value: Record<string, unknown>): string[] {
  const result = PipelineCheckpointSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

const base = { reservationId: "resv:v1:run-1:item:items:0", reservedCostCents: 0 };

describe("DSL-V2-HOST-BRIDGE-20260918: V2 per-item economics carrier", () => {
  it("accepts a pending V2 record with an ordered outcome prefix", () => {
    expect(issues(checkpointWith({ ...base, evidenceV2: pendingRecord(), leafOutcomesV2: [recorded, released] }))).toEqual([]);
    expect(issues(checkpointWith({ ...base, evidenceV2: pendingRecord() }))).toEqual([]);
  });

  it("refuses a V2 record that its own validator rejects", () => {
    const corrupt = { ...pendingRecord(), evidenceDigest: digest("0") };
    expect(issues(checkpointWith({ ...base, evidenceV2: corrupt }))).toEqual([
      expect.stringMatching(/evidenceV2.*invalid canonical loop economics V2 evidence/),
    ]);
  });

  it("refuses a V2 record whose reserved cents disagree with its priced leaves", () => {
    expect(issues(checkpointWith({ ...base, reservedCostCents: 5, evidenceV2: pendingRecord() }))).toEqual([
      expect.stringMatching(/evidenceV2\.leaves.*reserved cents/),
    ]);
  });

  // A V1 record beside a V2 record is refused by the same schema; it is pinned
  // in the agent suite (pipeline-for-each-v2-host-bridge.test.ts), which owns
  // the execution binding a valid V1 record needs.

  it("refuses outcomes without the record, foreign leaves, repeats and disorder", () => {
    expect(issues(checkpointWith({ ...base, leafOutcomesV2: [recorded] }))).toEqual([
      expect.stringMatching(/leafOutcomesV2: retained V2 leaf outcomes require the admitted V2 evidence record/),
    ]);
    const evidenceV2 = pendingRecord();
    expect(issues(checkpointWith({ ...base, evidenceV2, leafOutcomesV2: [{ ...recorded, leafId: "effect:other" }] }))).toEqual([
      expect.stringMatching(/leafOutcomesV2\.0\.leafId: retained V2 leaf outcome does not name an admitted leaf/),
    ]);
    expect(issues(checkpointWith({ ...base, evidenceV2, leafOutcomesV2: [recorded, recorded] }))).toEqual([
      expect.stringMatching(/leafOutcomesV2\.1\.leafId: retained V2 leaf outcomes must be unique and in admitted leaf order/),
    ]);
    expect(issues(checkpointWith({ ...base, evidenceV2, leafOutcomesV2: [released, recorded] }))).toEqual([
      expect.stringMatching(/leafOutcomesV2\.1\.leafId: retained V2 leaf outcomes must be unique and in admitted leaf order/),
    ]);
    const chargeShaped = { leafId: "effect:then", kind: "charge", status: "recorded", bindingDigest: digest("a"), receiptDigest: digest("f"), usage: {} };
    expect(issues(checkpointWith({ ...base, evidenceV2, leafOutcomesV2: [chargeShaped] }))).toEqual([
      expect.stringMatching(/leafOutcomesV2\.0\.kind: retained V2 leaf outcome kind must match its admitted leaf/),
    ]);
  });

  it("refuses an outcome prefix beside a resolved record", () => {
    const { admissionDigest: _admission, evidenceDigest: _digest, ...pending } = pendingRecord();
    const resolved = materializeLoopEconomicsEvidenceV2({
      ...pending,
      controlSelections: [{ kind: "branch", nodePath: ["items", "choose"], selectedBranch: "then" }],
      resolution: { status: "settled", outcomes: [recorded, released] },
    });
    expect(issues(checkpointWith({ ...base, settledCostCents: 0, evidenceV2: resolved }))).toEqual([]);
    expect(issues(checkpointWith({ ...base, settledCostCents: 0, evidenceV2: resolved, leafOutcomesV2: [recorded] }))).toEqual([
      expect.stringMatching(/leafOutcomesV2: a resolved V2 record carries its outcomes itself/),
    ]);
  });

  it("keeps an unrecognised economics key out", () => {
    expect(issues(checkpointWith({ ...base, evidenceV2: pendingRecord(), leafOutcomesV3: [] }))).toEqual([
      expect.stringMatching(/Unrecognized key/),
    ]);
  });
});
