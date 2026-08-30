import { describe, expect, it } from "vitest";
import {
  createPipelineInteractionResumeV1,
  createPipelineInteractionSpecV1,
  createPipelinePendingInteractionV1,
  digestPipelineInteractionValue,
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
    definitionDigest: digestPipelineInteractionValue({ id: "pipeline" }),
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

  it("isolates authoritative records from caller, return, and lookup mutation", async () => {
    const store = new InMemoryPipelineInteractionStatePort({
      now: () => new Date("2026-08-14"),
    });
    const { spec, pending, receipt } = fixture();
    const expectedSpec = structuredClone(spec);
    const expectedPending = structuredClone(pending);
    const expectedReceipt = structuredClone(receipt);
    const pendingResult = await store.ensurePending(spec, pending);

    (spec as unknown as { question: string }).question = "Mutated caller spec";
    (pending as unknown as { expiresAt: string }).expiresAt =
      "2021-01-01T00:00:00.000Z";
    (pendingResult.spec as unknown as { question: string }).question =
      "Mutated returned spec";
    (pendingResult.pending as { expiresAt: string }).expiresAt =
      "2020-01-01T00:00:00.000Z";

    const pendingLookup = await store.get(expectedPending.interactionId);
    expect(pendingLookup).toMatchObject({
      spec: expectedSpec,
      pending: expectedPending,
    });
    (pendingLookup!.pending as { expiresAt: string }).expiresAt =
      "2022-01-01T00:00:00.000Z";
    expect(await store.get(expectedPending.interactionId)).toMatchObject({
      spec: expectedSpec,
      pending: expectedPending,
    });
    await expect(
      store.ensurePending(expectedSpec, {
        ...expectedPending,
        expiresAt: "2029-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "PENDING_PAYLOAD_DRIFT",
    });

    const terminalResult = await store.recordReceipt(receipt);
    (receipt.response as { decision: string }).decision = "rejected";
    (terminalResult.pending as { expiresAt: string }).expiresAt =
      "2023-01-01T00:00:00.000Z";
    (terminalResult.receipt!.response as { decision: string }).decision =
      "rejected";

    const terminalLookup = await store.get(expectedPending.interactionId);
    expect(terminalLookup).toMatchObject({
      spec: expectedSpec,
      pending: expectedPending,
      receipt: expectedReceipt,
    });
    (terminalLookup!.receipt!.response as { decision: string }).decision =
      "rejected";
    expect(await store.get(expectedPending.interactionId)).toMatchObject({
      spec: expectedSpec,
      pending: expectedPending,
      receipt: expectedReceipt,
    });
    expect((await store.recordReceipt(expectedReceipt)).receipt).toEqual(
      expectedReceipt,
    );
  });
});
