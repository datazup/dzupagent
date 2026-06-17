import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryFlowApprovalStore } from "../flow-approval-store.js";

describe("InMemoryFlowApprovalStore", () => {
  let store: InMemoryFlowApprovalStore;

  beforeEach(() => {
    store = new InMemoryFlowApprovalStore();
  });

  it("create stores approval with status: 'pending'", async () => {
    const result = await store.create({
      runId: "run-1",
      approvalId: "appr-1",
      requestPayload: { message: "Please approve" },
    });

    expect(result.runId).toBe("run-1");
    expect(result.tenantId).toBe("default");
    expect(result.approvalId).toBe("appr-1");
    expect(result.status).toBe("pending");
    expect(result.requestPayload).toEqual({ message: "Please approve" });
    expect(result.responsePayload).toBeNull();
    expect(result.resolvedAt).toBeNull();
  });

  it("create is idempotent for an existing approval id in the same run", async () => {
    const first = await store.create({
      tenantId: "tenant-a",
      runId: "run-idem",
      approvalId: "appr-idem",
      requestPayload: { message: "first" },
    });

    const second = await store.create({
      tenantId: "tenant-a",
      runId: "run-idem",
      approvalId: "appr-idem",
      requestPayload: { message: "second" },
    });

    expect(second).toBe(first);
    expect(second.requestPayload).toEqual({ message: "first" });
  });

  it("create allows reuse of an approval id for a different run", async () => {
    await store.create({
      runId: "run-original",
      approvalId: "appr-conflict",
      requestPayload: {},
    });

    const result = await store.create({
      runId: "run-other",
      approvalId: "appr-conflict",
      requestPayload: { run: "other" },
    });

    expect(result.runId).toBe("run-other");
    expect(result.approvalId).toBe("appr-conflict");
    expect(result.requestPayload).toEqual({ run: "other" });
  });

  it("resolve transitions to 'approved' with responsePayload and resolvedAt", async () => {
    await store.create({
      runId: "run-2",
      approvalId: "appr-2",
      requestPayload: { step: "deploy" },
    });

    const before = new Date();
    const result = await store.resolve("run-2", "appr-2", "approved", {
      comment: "LGTM",
    });
    const after = new Date();

    expect(result.approvalId).toBe("appr-2");
    expect(result.status).toBe("approved");
    expect(result.responsePayload).toEqual({ comment: "LGTM" });
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(result.resolvedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(result.resolvedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("resolve throws on missing approvalId", async () => {
    await expect(
      store.resolve("run-missing", "nonexistent", "rejected", {}),
    ).rejects.toThrow(
      "FlowApproval not found: run-missing/nonexistent",
    );
  });

  it("resolve is idempotent after an approval is already resolved", async () => {
    await store.create({
      runId: "run-resolve-idem",
      approvalId: "appr-resolve-idem",
      requestPayload: {},
    });

    const first = await store.resolve(
      "run-resolve-idem",
      "appr-resolve-idem",
      "approved",
      { comment: "ok" },
    );
    const second = await store.resolve(
      "run-resolve-idem",
      "appr-resolve-idem",
      "approved",
      { comment: "ignored" },
    );

    expect(second).toEqual(first);
    expect(second.responsePayload).toEqual({ comment: "ok" });
  });

  it("get retrieves approval by approvalId", async () => {
    await store.create({
      runId: "run-3",
      approvalId: "appr-3",
      requestPayload: {},
    });
    const result = await store.get("run-3", "appr-3");
    expect(result).toBeDefined();
    expect(result?.approvalId).toBe("appr-3");
  });

  it("listByRun returns only that run's approvals", async () => {
    await store.create({
      runId: "run-A",
      approvalId: "appr-A1",
      requestPayload: {},
    });
    await store.create({
      runId: "run-A",
      approvalId: "appr-A2",
      requestPayload: {},
    });
    await store.create({
      runId: "run-B",
      approvalId: "appr-B1",
      requestPayload: {},
    });

    const runAResults = await store.listByRun("run-A");
    expect(runAResults).toHaveLength(2);
    expect(runAResults.map((a) => a.approvalId).sort()).toEqual([
      "appr-A1",
      "appr-A2",
    ]);

    const runBResults = await store.listByRun("run-B");
    expect(runBResults).toHaveLength(1);
    expect(runBResults[0]?.approvalId).toBe("appr-B1");

    const runCResults = await store.listByRun("run-C");
    expect(runCResults).toHaveLength(0);
  });
});
