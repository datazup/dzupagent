import { describe, expect, it } from "vitest";
import {
  createPipelineInteractionResumeV1,
  createPipelineInteractionSpecV1,
  createPipelinePendingInteractionV1,
  digestPipelineDefinition,
} from "@dzupagent/runtime-contracts";
import {
  InMemoryPipelineInteractionStatePort,
  PipelineInteractionStoreError,
} from "../pipeline-interaction-adapter.js";

function fixture() {
  const spec = createPipelineInteractionSpecV1({
    kind: "approval",
    authoredNodeId: "approve",
    authoredPath: "root.nodes[0]",
    question: "Ship?",
    choices: ["standard"],
    outcomeToSuccessor: { approved: "ship", rejected: "stop" },
    requestSchema: { kind: "approval", decisions: ["approved", "rejected"] },
  });
  const pending = createPipelinePendingInteractionV1({
    kind: "approval",
    definitionDigest: digestPipelineDefinition({ id: "pipeline" }),
    pipelineId: "pipeline",
    runId: "run",
    nodeId: "gate",
    scope: { kind: "pipeline" },
    occurrence: 0,
    expectedCheckpointVersion: 1,
    requestDigest: spec.requestDigest,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const receipt = createPipelineInteractionResumeV1({
    ...pending,
    receiptId: "receipt-1",
    submittedAt: "2026-08-14T00:00:00.000Z",
    response: { kind: "approval", decision: "approved", reason: "Reviewed" },
  });
  return { spec, pending, receipt };
}

describe("InMemoryPipelineInteractionStatePort", () => {
  it("accepts identical pending registration and rejects payload drift", async () => {
    const store = new InMemoryPipelineInteractionStatePort({ now: () => new Date("2026-08-14") });
    const { spec, pending } = fixture();
    expect(await store.ensurePending(spec, pending)).toEqual(
      await store.ensurePending(spec, pending),
    );
    await expect(
      store.ensurePending(spec, { ...pending, expiresAt: "2029-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "PENDING_PAYLOAD_DRIFT" });
  });

  it("accepts identical terminal replay and rejects a conflicting decision", async () => {
    const store = new InMemoryPipelineInteractionStatePort({ now: () => new Date("2026-08-14") });
    const { spec, pending, receipt } = fixture();
    await store.ensurePending(spec, pending);
    expect((await store.recordReceipt(receipt)).receipt).toEqual(receipt);
    expect((await store.recordReceipt(receipt)).receipt).toEqual(receipt);
    const forgedReplay = {
      ...receipt,
      response: { kind: "approval", decision: "rejected" },
    } as typeof receipt;
    await expect(store.recordReceipt(forgedReplay)).rejects.toMatchObject({
      code: "INVALID_INTERACTION",
    });
    const conflict = createPipelineInteractionResumeV1({
      ...pending,
      receiptId: "receipt-2",
      submittedAt: "2026-08-14T00:01:00.000Z",
      response: { kind: "approval", decision: "rejected" },
    });
    await expect(store.recordReceipt(conflict)).rejects.toBeInstanceOf(
      PipelineInteractionStoreError,
    );
    await expect(store.recordReceipt(conflict)).rejects.toMatchObject({
      code: "TERMINAL_RECEIPT_CONFLICT",
    });
  });

  it("treats the exact expiry instant as expired", async () => {
    const { spec, pending, receipt } = fixture();
    const store = new InMemoryPipelineInteractionStatePort({
      now: () => new Date(pending.expiresAt),
    });
    await store.ensurePending(spec, pending);
    await expect(store.recordReceipt(receipt)).rejects.toMatchObject({
      code: "INTERACTION_EXPIRED",
    });
  });
});
