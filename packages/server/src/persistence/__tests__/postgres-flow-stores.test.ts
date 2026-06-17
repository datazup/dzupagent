import { describe, it, expect, vi } from "vitest";

type Pred = (row: Record<string, unknown>) => boolean;

vi.mock("drizzle-orm", () => ({
  and:
    (...predicates: Pred[]): Pred =>
    (row) =>
      predicates.every((predicate) => predicate(row)),
  eq:
    (col: { _col: string }, value: unknown): Pred =>
    (row) =>
      row[col._col] === value,
}));

vi.mock("../drizzle-schema.js", () => {
  const col = (name: string) => ({ _col: name });
  return {
    flowArtifacts: {
      _table: "flowArtifacts",
      artifactRef: col("artifactRef"),
      contentDigest: col("contentDigest"),
    },
    flowApprovals: {
      _table: "flowApprovals",
      approvalId: col("approvalId"),
      runId: col("runId"),
    },
  };
});

const { PostgresFlowArtifactStore } = await import("../flow-artifact-store.js");
const { PostgresFlowApprovalStore } = await import("../flow-approval-store.js");

class FakeDb {
  private readonly rows = new Map<string, Map<string, Record<string, unknown>>>();

  insert(table: { _table: string }) {
    return {
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const store = this.table(table._table);
            const key = keyFor(table._table, values);
            const existing = store.get(key);
            if (existing) return [{ ...existing }];
            const row = { ...values };
            store.set(key, row);
            return [{ ...row }];
          },
        }),
      }),
    };
  }

  select() {
    return {
      from: (table: { _table: string }) => ({
        where: (pred: Pred) => {
          const all = [...this.table(table._table).values()].filter(pred);
          return {
            limit: async (limit: number) => all.slice(0, limit).map(clone),
            then: (
              resolve: (rows: Record<string, unknown>[]) => unknown,
              reject?: (error: unknown) => unknown,
            ) => Promise.resolve(all.map(clone)).then(resolve, reject),
          };
        },
      }),
    };
  }

  update(table: { _table: string }) {
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (pred: Pred) => ({
          returning: async () => {
            const out: Record<string, unknown>[] = [];
            const store = this.table(table._table);
            for (const [key, row] of store) {
              if (!pred(row)) continue;
              const updated = { ...row, ...patch };
              store.set(key, updated);
              out.push(clone(updated));
            }
            return out;
          },
        }),
      }),
    };
  }

  private table(name: string): Map<string, Record<string, unknown>> {
    let table = this.rows.get(name);
    if (!table) {
      table = new Map();
      this.rows.set(name, table);
    }
    return table;
  }
}

function keyFor(table: string, row: Record<string, unknown>): string {
  if (table === "flowArtifacts") return String(row["artifactRef"]);
  if (table === "flowApprovals") {
    return `${String(row["runId"])}\0${String(row["approvalId"])}`;
  }
  throw new Error(`unknown table: ${table}`);
}

function clone(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

describe("PostgresFlowArtifactStore", () => {
  it("stores inline content and replays duplicate puts by artifact ref", async () => {
    const store = new PostgresFlowArtifactStore(new FakeDb() as never);

    const first = await store.put({
      artifactRef: "artifact-1",
      tenantId: "tenant-a",
      contentDigest: "sha256:artifact",
      contentType: "application/json",
      content: { result: 1 },
      schemaRef: "result.v1",
    });
    const second = await store.put({
      artifactRef: "artifact-1",
      tenantId: "tenant-a",
      contentDigest: "sha256:artifact",
      contentType: "application/json",
      content: { result: 2 },
      schemaRef: "result.v1",
    });

    expect(second.content).toEqual({ result: 1 });
    expect(await store.get("artifact-1")).toEqual(first);
    expect((await store.findByDigest("sha256:artifact"))?.artifactRef).toBe(
      "artifact-1",
    );
  });

  it("rejects duplicate artifact refs with a different digest", async () => {
    const store = new PostgresFlowArtifactStore(new FakeDb() as never);
    await store.put({
      artifactRef: "artifact-drift",
      contentDigest: "sha256:old",
      contentType: "application/json",
    });

    await expect(
      store.put({
        artifactRef: "artifact-drift",
        contentDigest: "sha256:new",
        contentType: "application/json",
      }),
    ).rejects.toThrow("FlowArtifact digest mismatch for ref: artifact-drift");
  });
});

describe("PostgresFlowApprovalStore", () => {
  it("creates, resolves, lists, and idempotently replays approvals", async () => {
    const store = new PostgresFlowApprovalStore(new FakeDb() as never);

    const pending = await store.create({
      tenantId: "tenant-a",
      runId: "run-1",
      approvalId: "approval-1",
      requestPayload: { prompt: "approve?" },
    });
    const duplicate = await store.create({
      tenantId: "tenant-a",
      runId: "run-1",
      approvalId: "approval-1",
      requestPayload: { prompt: "ignored" },
    });

    expect(duplicate).toEqual(pending);

    const resolved = await store.resolve(
      "run-1",
      "approval-1",
      "approved",
      { comment: "ok" },
    );
    const resolvedAgain = await store.resolve(
      "run-1",
      "approval-1",
      "approved",
      { comment: "ignored" },
    );

    expect(resolved.status).toBe("approved");
    expect(resolved.responsePayload).toEqual({ comment: "ok" });
    expect(resolvedAgain).toEqual(resolved);
    expect(await store.get("run-1", "approval-1")).toEqual(resolved);
    expect(await store.listByRun("run-1")).toEqual([resolved]);
  });

  it("allows approval id reuse across runs", async () => {
    const store = new PostgresFlowApprovalStore(new FakeDb() as never);
    await store.create({
      runId: "run-original",
      approvalId: "approval-conflict",
      requestPayload: {},
    });

    const other = await store.create({
      runId: "run-other",
      approvalId: "approval-conflict",
      requestPayload: { run: "other" },
    });

    expect(other.runId).toBe("run-other");
    expect(other.approvalId).toBe("approval-conflict");
    expect(other.requestPayload).toEqual({ run: "other" });
  });
});
