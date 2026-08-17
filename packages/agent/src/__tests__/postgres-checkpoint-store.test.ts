/**
 * Unit tests for PostgresPipelineCheckpointStore.
 *
 * Uses a hand-rolled mock client that records every query + params and
 * returns stubbed rows — no live database required.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PostgresPipelineCheckpointStore,
  type PostgresClientLike,
} from "../pipeline/postgres-checkpoint-store.js";
import type {
  PipelineCheckpoint,
  PipelineCheckpointSourceBinding,
} from "@dzupagent/core";
import {
  createPipelineInteractionResumeV1,
  createPipelineInteractionSpecV1,
  createPipelinePendingInteractionV1,
  digestPipelineDefinition,
} from "@dzupagent/runtime-contracts";

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

interface RecordedCall {
  text: string;
  params: unknown[];
}

interface StatefulTable {
  columns: Set<string>;
  rows: Array<Record<string, unknown>>;
}

function createMockClient(responders: Array<(call: RecordedCall) => unknown>) {
  const calls: RecordedCall[] = [];
  let idx = 0;

  const client: PostgresClientLike = {
    // `vi.fn` erases the generic call signature, so the mock is not assignable
    // to `query`'s `<T>(...) => Promise<{ rows: T[] }>` without this cast. The
    // cast is on the PROPERTY, so the mock itself keeps its `vi.fn`
    // introspection (`mock.calls`) that these tests rely on.
    query: vi.fn(async <T>(text: string, params: unknown[] = []) => {
      const call: RecordedCall = { text, params };
      calls.push(call);
      const responder = responders[idx++];
      const result = responder ? responder(call) : { rows: [] };
      return result as { rows: T[] };
    }) as PostgresClientLike["query"],
  };

  return { client, calls };
}

function createStatefulCompatibilityClient(tableName: string) {
  const calls: RecordedCall[] = [];
  const table: StatefulTable = {
    columns: new Set([
      "pipeline_run_id",
      "pipeline_id",
      "version",
      "schema_version",
      "completed_node_ids",
      "state",
      "suspended_at_node_id",
      "budget_state",
      "created_at",
      "expires_at",
      "node_idempotency_keys",
      "loop_state",
      "fork_state",
      "recovery_attempts_used",
    ]),
    rows: [
      {
        pipeline_run_id: "legacy-run",
        pipeline_id: "pipeline-legacy",
        version: 1,
        schema_version: "1.0.0",
        completed_node_ids: ["start"],
        state: { legacy: true },
        suspended_at_node_id: null,
        budget_state: null,
        created_at: "2026-04-24T00:00:00.000Z",
        expires_at: null,
        node_idempotency_keys: null,
        loop_state: null,
        fork_state: null,
        recovery_attempts_used: 0,
      },
    ],
  };

  const client: PostgresClientLike = {
    // `vi.fn` erases the generic call signature, so the mock is not assignable
    // to `query`'s `<T>(...) => Promise<{ rows: T[] }>` without this cast. The
    // cast is on the PROPERTY, so the mock itself keeps its `vi.fn`
    // introspection (`mock.calls`) that these tests rely on.
    query: vi.fn(async <T>(text: string, params: unknown[] = []) => {
      calls.push({ text, params });

      if (text.includes("CREATE TABLE IF NOT EXISTS")) {
        return { rows: [] as T[] };
      }

      const addColumn = text.match(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/);
      if (addColumn) {
        table.columns.add(addColumn[1]!);
        return { rows: [] as T[] };
      }

      if (text.includes(`INSERT INTO ${tableName}`)) {
        table.rows.push({
          pipeline_run_id: params[0],
          pipeline_id: params[1],
          version: params[2],
          schema_version: params[3],
          completed_node_ids: JSON.parse(params[4] as string),
          state: JSON.parse(params[5] as string),
          suspended_at_node_id: params[6],
          budget_state:
            typeof params[7] === "string"
              ? JSON.parse(params[7] as string)
              : null,
          created_at: params[8],
          expires_at: params[9],
          node_idempotency_keys:
            typeof params[10] === "string"
              ? JSON.parse(params[10] as string)
              : null,
          loop_state:
            typeof params[11] === "string"
              ? JSON.parse(params[11] as string)
              : null,
          fork_state:
            typeof params[12] === "string"
              ? JSON.parse(params[12] as string)
              : null,
          recovery_attempts_used: params[13],
          provider_session_refs:
            typeof params[14] === "string"
              ? JSON.parse(params[14] as string)
              : null,
          interaction_state:
            typeof params[15] === "string"
              ? JSON.parse(params[15] as string)
              : null,
        });
        return { rows: [] as T[] };
      }

      if (text.includes(`SELECT * FROM ${tableName}`)) {
        const runId = params[0];
        const rows = table.rows
          .filter((row) => row.pipeline_run_id === runId)
          .sort((a, b) => Number(b.version) - Number(a.version));
        return { rows: rows.slice(0, 1) as T[] };
      }

      return { rows: [] as T[] };
    }) as PostgresClientLike["query"],
  };

  return { client, calls, table };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckpoint(
  overrides: Partial<PipelineCheckpoint> = {}
): PipelineCheckpoint {
  return {
    pipelineRunId: "run-1",
    pipelineId: "pipeline-1",
    version: 1,
    schemaVersion: "1.0.0",
    completedNodeIds: ["start"],
    state: { result: "ok" },
    createdAt: "2026-04-24T00:00:00.000Z",
    ...overrides,
  };
}

function makePendingInteraction(runId: string) {
  const spec = createPipelineInteractionSpecV1({
    kind: "clarification",
    authoredNodeId: "clarify",
    authoredPath: "root.nodes[0]",
    question: "Environment?",
    choices: [],
    outputKey: "environment",
    requestSchema: {
      kind: "clarification",
      response: "text",
      minLength: 1,
      maxLength: 256,
    },
  });
  return createPipelinePendingInteractionV1({
    kind: "clarification",
    definitionDigest: digestPipelineDefinition({ id: "pipeline-1" }),
    pipelineId: "pipeline-1",
    runId,
    nodeId: "clarify",
    scope: { kind: "pipeline" },
    occurrence: 0,
    expectedCheckpointVersion: 1,
    requestDigest: spec.requestDigest,
    expiresAt: "2026-08-14T21:00:00.000Z",
  });
}

function makeCommittedInteraction(runId: string) {
  const pending = makePendingInteraction(runId);
  const receipt = createPipelineInteractionResumeV1({
    ...pending,
    receiptId: "receipt-environment",
    submittedAt: "2026-08-14T20:00:01.000Z",
    response: { kind: "clarification", value: "staging" },
  });
  const cursor = {
    interactionId: receipt.interactionId,
    receiptHash: receipt.receiptHash,
    definitionDigest: receipt.definitionDigest,
    nodeId: receipt.nodeId,
    scope: receipt.scope,
    selectedSuccessorNodeId: "after-clarification",
    nextNodeId: "after-clarification",
  } as const;
  return { receipt, cursor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PostgresPipelineCheckpointStore", () => {
  describe("setup()", () => {
    it("issues CREATE TABLE, checkpoint-field migrations, and index DDL using the configured table name", async () => {
      const { client, calls } = createMockClient([
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [] }),
        () => ({ rows: [] }),
      ]);
      const store = new PostgresPipelineCheckpointStore({
        client,
        tableName: "my_checkpoints",
      });

      await store.setup();

      expect(calls).toHaveLength(10);
      expect(calls[0]!.text).toContain(
        "CREATE TABLE IF NOT EXISTS my_checkpoints"
      );
      // Backward-compatible migration (W5): adds node_idempotency_keys.
      expect(calls[1]!.text).toContain(
        "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS node_idempotency_keys"
      );
      // Backward-compatible migration (W3): adds loop_state.
      expect(calls[2]!.text).toContain(
        "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS loop_state"
      );
      // Backward-compatible migration (W4): adds fork_state.
      expect(calls[3]!.text).toContain(
        "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS fork_state"
      );
      // Backward-compatible migration (W5-gap): adds recovery_attempts_used.
      expect(calls[4]!.text).toContain(
        "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS recovery_attempts_used"
      );
      expect(calls[5]!.text).toContain(
        "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS provider_session_refs"
      );
      expect(calls[6]!.text).toContain(
        "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS interaction_state"
      );
      // Backward-compatible migration (E0): adds source_binding.
      expect(calls[7]!.text).toContain(
        "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS source_binding"
      );
      expect(calls[8]!.text).toContain(
        "CREATE INDEX IF NOT EXISTS my_checkpoints_run_idx"
      );
      expect(calls[9]!.text).toContain(
        "CREATE INDEX IF NOT EXISTS my_checkpoints_expiry_idx"
      );
    });

    it("rejects table names with SQL metacharacters", () => {
      const { client } = createMockClient([]);
      expect(
        () =>
          new PostgresPipelineCheckpointStore({
            client,
            tableName: 'evil"; DROP',
          })
      ).toThrow(/Invalid tableName/);
    });

    it("migrates a pre-existing table without provider_session_refs while preserving legacy rows", async () => {
      const { client, table } = createStatefulCompatibilityClient(
        "pipeline_checkpoints"
      );
      const store = new PostgresPipelineCheckpointStore({ client });

      expect(table.columns.has("provider_session_refs")).toBe(false);
      expect(table.columns.has("interaction_state")).toBe(false);

      await store.setup();
      const legacy = await store.load("legacy-run");
      const pendingInteraction = makePendingInteraction("new-run");
      await store.save(
        makeCheckpoint({
          pipelineRunId: "new-run",
          schemaVersion: "1.1.0",
          pendingInteraction,
          providerSessionRefs: [
            {
              nodeId: "adapter_0",
              provider: "codex",
              sessionId: "sess-1",
            },
          ],
        })
      );
      const migrated = await store.load("new-run");

      expect(table.columns.has("provider_session_refs")).toBe(true);
      expect(table.columns.has("interaction_state")).toBe(true);
      expect(legacy).toMatchObject({
        pipelineRunId: "legacy-run",
        state: { legacy: true },
      });
      expect(legacy?.providerSessionRefs).toBeUndefined();
      expect(migrated?.providerSessionRefs).toEqual([
        {
          nodeId: "adapter_0",
          provider: "codex",
          sessionId: "sess-1",
        },
      ]);
      expect(migrated?.pendingInteraction).toEqual(pendingInteraction);
    });

    it("round-trips a committed interaction receipt and exact successor cursor", async () => {
      const { client } = createStatefulCompatibilityClient(
        "pipeline_checkpoints"
      );
      const store = new PostgresPipelineCheckpointStore({ client });
      const { receipt, cursor } = makeCommittedInteraction("committed-run");

      await store.setup();
      await store.save(
        makeCheckpoint({
          pipelineRunId: "committed-run",
          version: 2,
          schemaVersion: "1.1.0",
          completedNodeIds: ["start", "clarify"],
          interactionReceipts: { [receipt.interactionId]: receipt },
          interactionResumeCursor: cursor,
        })
      );

      expect(await store.load("committed-run")).toMatchObject({
        interactionReceipts: { [receipt.interactionId]: receipt },
        interactionResumeCursor: cursor,
      });
    });
  });

  describe("save()", () => {
    let client: PostgresClientLike;
    let calls: RecordedCall[];
    let store: PostgresPipelineCheckpointStore;

    beforeEach(() => {
      const mock = createMockClient([() => ({ rows: [] })]);
      client = mock.client;
      calls = mock.calls;
      store = new PostgresPipelineCheckpointStore({ client });
    });

    it("issues an UPSERT with JSON-serialised payloads", async () => {
      await store.save(makeCheckpoint());

      expect(calls).toHaveLength(1);
      expect(calls[0]!.text).toContain("INSERT INTO pipeline_checkpoints");
      expect(calls[0]!.text).toContain(
        "ON CONFLICT (pipeline_run_id, version)"
      );
      expect(calls[0]!.params[0]).toBe("run-1");
      expect(calls[0]!.params[4]).toBe(JSON.stringify(["start"]));
      expect(calls[0]!.params[5]).toBe(JSON.stringify({ result: "ok" }));
      // expires_at should be null when defaultTtlMs is not set.
      expect(calls[0]!.params[9]).toBeNull();
    });

    it("populates expires_at when defaultTtlMs is configured", async () => {
      const mock = createMockClient([() => ({ rows: [] })]);
      const ttlStore = new PostgresPipelineCheckpointStore({
        client: mock.client,
        defaultTtlMs: 60_000,
      });

      const before = Date.now();
      await ttlStore.save(makeCheckpoint());
      const after = Date.now();

      const expiresAtStr = mock.calls[0]!.params[9] as string;
      expect(typeof expiresAtStr).toBe("string");
      const expiresAtMs = new Date(expiresAtStr).getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 60_000 - 10);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 60_000 + 10);
    });

    it("includes recoveryAttemptsUsed as param $14 (W5-gap)", async () => {
      const mock = createMockClient([() => ({ rows: [] })]);
      const s = new PostgresPipelineCheckpointStore({ client: mock.client });
      await s.save({ ...makeCheckpoint(), recoveryAttemptsUsed: 3 });
      // $14 is recovery_attempts_used.
      expect(mock.calls[0]!.params[13]).toBe(3);
    });

    it("sends 0 for recoveryAttemptsUsed when not set", async () => {
      const mock = createMockClient([() => ({ rows: [] })]);
      const s = new PostgresPipelineCheckpointStore({ client: mock.client });
      await s.save(makeCheckpoint()); // no recoveryAttemptsUsed field
      expect(mock.calls[0]!.params[13]).toBe(0);
    });

    it("serialises providerSessionRefs into param $15", async () => {
      const mock = createMockClient([() => ({ rows: [] })]);
      const s = new PostgresPipelineCheckpointStore({ client: mock.client });
      await s.save(
        makeCheckpoint({
          providerSessionRefs: [
            {
              nodeId: "adapter_0",
              provider: "codex",
              sessionId: "sess-1",
              label: "draft",
              metadata: { conversationId: "conv-1" },
            },
          ],
        })
      );

      expect(mock.calls[0]!.params[14]).toBe(
        JSON.stringify([
          {
            nodeId: "adapter_0",
            provider: "codex",
            sessionId: "sess-1",
            label: "draft",
            metadata: { conversationId: "conv-1" },
          },
        ])
      );
    });

    it("serialises checkpoint-bound interaction state into param $16", async () => {
      const pendingInteraction = makePendingInteraction("run-1");
      await store.save(
        makeCheckpoint({
          schemaVersion: "1.1.0",
          pendingInteraction,
        })
      );

      expect(calls[0]!.params[15]).toBe(
        JSON.stringify({
          pendingInteraction,
          interactionReceipts: undefined,
          interactionResumeCursor: undefined,
        })
      );
    });
  });

  describe("load()", () => {
    it("returns the highest version honouring expiry filter and coerces rows", async () => {
      const { client, calls } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: "run-1",
              pipeline_id: "pipeline-1",
              version: 3,
              schema_version: "1.0.0",
              completed_node_ids: ["a", "b", "c"],
              state: { step: 3 },
              suspended_at_node_id: null,
              budget_state: null,
              created_at: "2026-04-24T00:00:00.000Z",
              expires_at: null,
            },
          ],
        }),
      ]);
      const store = new PostgresPipelineCheckpointStore({ client });

      const result = await store.load("run-1");
      expect(result).toBeDefined();
      expect(result!.version).toBe(3);
      expect(result!.completedNodeIds).toEqual(["a", "b", "c"]);
      expect(calls[0]!.text).toContain("ORDER BY version DESC");
      expect(calls[0]!.text).toContain(
        "expires_at IS NULL OR expires_at > NOW()"
      );
    });

    it("returns undefined when no rows match", async () => {
      const { client } = createMockClient([() => ({ rows: [] })]);
      const store = new PostgresPipelineCheckpointStore({ client });
      const result = await store.load("missing");
      expect(result).toBeUndefined();
    });

    it("rejects a schema-invalid stored interaction row", async () => {
      const { client } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: "run-1",
              pipeline_id: "pipeline-1",
              version: 1,
              schema_version: "1.1.0",
              completed_node_ids: [],
              state: {},
              suspended_at_node_id: "clarify",
              budget_state: null,
              created_at: "2026-04-24T00:00:00.000Z",
              expires_at: null,
              interaction_state: {
                pendingInteraction: { state: "pending" },
              },
            },
          ],
        }),
      ]);
      const store = new PostgresPipelineCheckpointStore({ client });

      await expect(store.load("run-1")).rejects.toThrow(
        "Invalid pipeline checkpoint row"
      );
    });

    it("re-hydrates suspendedAtNodeId and budgetState when present", async () => {
      const { client } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: "run-1",
              pipeline_id: "pipeline-1",
              version: 1,
              schema_version: "1.0.0",
              completed_node_ids: ["start"],
              state: {},
              suspended_at_node_id: "approval-gate",
              budget_state: { tokensUsed: 42, costCents: 3 },
              created_at: new Date("2026-04-24T00:00:00.000Z"),
              expires_at: null,
            },
          ],
        }),
      ]);
      const store = new PostgresPipelineCheckpointStore({ client });
      const result = await store.load("run-1");
      expect(result!.suspendedAtNodeId).toBe("approval-gate");
      expect(result!.budgetState).toEqual({ tokensUsed: 42, costCents: 3 });
      // Date objects are normalised to ISO strings.
      expect(result!.createdAt).toBe("2026-04-24T00:00:00.000Z");
    });

    it("persists and restores the E0 source binding through the row mapping", async () => {
      // Postgres maps explicit columns rather than serializing the checkpoint
      // wholesale, so a new field is silently DROPPED unless it is threaded
      // into the insert, the upsert, and the row->checkpoint mapping. The
      // in-memory and Redis stores would hide that, hence this proof.
      // Annotated, because the digests are a TEMPLATE LITERAL type
      // (`sha256:${string}`) and an unannotated `${}` expression widens to
      // plain `string`. The values were already correct; only the inferred
      // type was wrong.
      const binding: PipelineCheckpointSourceBinding = {
        definitionDigest: `sha256:${"a".repeat(64)}`,
        loopSourceDigests: { "loop-items": `sha256:${"b".repeat(64)}` },
      };
      const { client, calls } = createMockClient([
        () => ({ rows: [] }),
        () => ({
          rows: [
            {
              pipeline_run_id: "run-1",
              pipeline_id: "pipeline-1",
              version: 1,
              schema_version: "1.0.0",
              completed_node_ids: ["start"],
              state: {},
              suspended_at_node_id: null,
              budget_state: null,
              created_at: new Date("2026-04-24T00:00:00.000Z"),
              expires_at: null,
              source_binding: binding,
            },
          ],
        }),
      ]);
      const store = new PostgresPipelineCheckpointStore({ client });

      await store.save({
        pipelineRunId: "run-1",
        pipelineId: "pipeline-1",
        version: 1,
        schemaVersion: "1.0.0",
        completedNodeIds: ["start"],
        state: {},
        createdAt: "2026-04-24T00:00:00.000Z",
        sourceBinding: binding,
      });

      // The binding must actually reach the INSERT, not just the type.
      const insert = calls[0]!;
      expect(insert.text).toContain("source_binding");
      expect(insert.params).toContain(JSON.stringify(binding));

      const result = await store.load("run-1");
      expect(result!.sourceBinding).toEqual(binding);
    });

    it("restores recoveryAttemptsUsed from the row (W5-gap)", async () => {
      const { client } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: "run-1",
              pipeline_id: "pipeline-1",
              version: 1,
              schema_version: "1.0.0",
              completed_node_ids: ["start"],
              state: {},
              suspended_at_node_id: null,
              budget_state: null,
              created_at: "2026-04-24T00:00:00.000Z",
              expires_at: null,
              recovery_attempts_used: 2,
            },
          ],
        }),
      ]);
      const store = new PostgresPipelineCheckpointStore({ client });
      const result = await store.load("run-1");
      expect(result!.recoveryAttemptsUsed).toBe(2);
    });

    it("restores providerSessionRefs from the row", async () => {
      const { client } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: "run-1",
              pipeline_id: "pipeline-1",
              version: 1,
              schema_version: "1.0.0",
              completed_node_ids: ["adapter_0"],
              state: {},
              suspended_at_node_id: null,
              budget_state: null,
              created_at: "2026-04-24T00:00:00.000Z",
              expires_at: null,
              provider_session_refs: [
                {
                  nodeId: "adapter_0",
                  provider: "codex",
                  sessionId: "sess-1",
                  label: "draft",
                  metadata: { conversationId: "conv-1" },
                },
              ],
            },
          ],
        }),
      ]);
      const store = new PostgresPipelineCheckpointStore({ client });
      const result = await store.load("run-1");
      expect(result!.providerSessionRefs).toEqual([
        {
          nodeId: "adapter_0",
          provider: "codex",
          sessionId: "sess-1",
          label: "draft",
          metadata: { conversationId: "conv-1" },
        },
      ]);
    });

    it("omits recoveryAttemptsUsed when the column is 0 or null (W5-gap)", async () => {
      const { client } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: "run-1",
              pipeline_id: "pipeline-1",
              version: 1,
              schema_version: "1.0.0",
              completed_node_ids: [],
              state: {},
              suspended_at_node_id: null,
              budget_state: null,
              created_at: "2026-04-24T00:00:00.000Z",
              expires_at: null,
              recovery_attempts_used: 0,
            },
          ],
        }),
      ]);
      const store = new PostgresPipelineCheckpointStore({ client });
      const result = await store.load("run-1");
      expect(result!.recoveryAttemptsUsed).toBeUndefined();
    });
  });

  describe("listVersions()", () => {
    it("maps rows into sorted summaries", async () => {
      const { client } = createMockClient([
        () => ({
          rows: [
            {
              pipeline_run_id: "run-1",
              version: 1,
              created_at: "2026-04-24T00:00:00.000Z",
              completed_node_ids: ["a"],
            },
            {
              pipeline_run_id: "run-1",
              version: 2,
              created_at: "2026-04-24T00:01:00.000Z",
              completed_node_ids: ["a", "b"],
            },
          ],
        }),
      ]);
      const store = new PostgresPipelineCheckpointStore({ client });
      const versions = await store.listVersions("run-1");
      expect(versions).toHaveLength(2);
      expect(versions[0]!.completedNodeCount).toBe(1);
      expect(versions[1]!.completedNodeCount).toBe(2);
    });
  });

  describe("delete() + prune()", () => {
    it("issues a DELETE with the correct runId", async () => {
      const { client, calls } = createMockClient([() => ({ rows: [] })]);
      const store = new PostgresPipelineCheckpointStore({ client });

      await store.delete("run-9");
      expect(calls[0]!.text).toContain("DELETE FROM pipeline_checkpoints");
      expect(calls[0]!.params).toEqual(["run-9"]);
    });

    it("prune returns rowCount when the adapter exposes it", async () => {
      const mock = {
        client: {
          query: vi.fn(async () => ({ rows: [], rowCount: 5 })),
        } as unknown as PostgresClientLike,
      };
      const store = new PostgresPipelineCheckpointStore({
        client: mock.client,
      });
      const pruned = await store.prune(60_000);
      expect(pruned).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // E1 — compare-and-set writes
  // -------------------------------------------------------------------------

  describe("saveIfVersion (CAS)", () => {
    /**
     * Client that actually enforces `UNIQUE (pipeline_run_id, version)` and
     * answers `MAX(version)`. The CAS guard is that constraint, so a mock that
     * accepted every insert would make these tests vacuous.
     */
    function createUniqueEnforcingClient() {
      const calls: RecordedCall[] = [];
      const rows: Array<{ pipeline_run_id: string; version: number }> = [];

      const client: PostgresClientLike = {
        // Same `vi.fn` generic-erasure cast as `createMockClient` above.
        query: vi.fn(async <T>(text: string, params: unknown[] = []) => {
          calls.push({ text, params });

          if (text.includes("MAX(version)")) {
            const runId = params[0];
            const versions = rows
              .filter((r) => r.pipeline_run_id === runId)
              .map((r) => r.version);
            const max = versions.length > 0 ? Math.max(...versions) : null;
            return { rows: [{ version: max }] as T[], rowCount: 1 };
          }

          if (text.includes("INSERT INTO")) {
            const runId = params[0] as string;
            const version = params[2] as number;
            const clash = rows.some(
              (r) => r.pipeline_run_id === runId && r.version === version
            );
            if (clash) {
              // Real Postgres semantics: DO NOTHING affects zero rows, whereas
              // DO UPDATE affects one — which is exactly how an upsert silently
              // clobbers the winner. Modelling both is what makes the conflict
              // test below fail if the CAS insert ever becomes an upsert.
              return text.includes("DO NOTHING")
                ? { rows: [] as T[], rowCount: 0 }
                : { rows: [] as T[], rowCount: 1 };
            }
            rows.push({ pipeline_run_id: runId, version });
            return { rows: [] as T[], rowCount: 1 };
          }

          return { rows: [] as T[], rowCount: 0 };
        }) as PostgresClientLike["query"],
      };

      return { client, calls, rows };
    }

    it("commits when the observed version matches", async () => {
      const { client } = createUniqueEnforcingClient();
      const store = new PostgresPipelineCheckpointStore({ client });

      const receipt = await store.saveIfVersion(
        makeCheckpoint({ version: 1 }),
        0
      );

      expect(receipt).toEqual({ committed: true, observedVersion: 1 });
    });

    it("uses ON CONFLICT DO NOTHING, not the upsert that would clobber the winner", async () => {
      const { client, calls } = createUniqueEnforcingClient();
      const store = new PostgresPipelineCheckpointStore({ client });

      await store.saveIfVersion(makeCheckpoint({ version: 1 }), 0);

      const insert = calls.find((c) => c.text.includes("INSERT INTO"))!;
      expect(insert.text).toContain(
        "ON CONFLICT (pipeline_run_id, version) DO NOTHING"
      );
      expect(insert.text).not.toContain("DO UPDATE SET");
    });

    it("reports a conflict from a zero row count rather than throwing", async () => {
      // A true interleaving: the loser reads MAX(version) while the run is
      // still empty, and the winner commits version 1 before the loser's
      // INSERT lands. The early version check therefore PASSES for the loser
      // and the unique constraint is the only thing standing between it and a
      // clobber — so this exercises the DO NOTHING branch, not the early exit.
      const { client, rows } = createUniqueEnforcingClient();
      const store = new PostgresPipelineCheckpointStore({ client });

      const originalQuery = client.query;
      let interleaved = false;
      client.query = (async <T>(text: string, params: unknown[] = []) => {
        const result = await (
          originalQuery as PostgresClientLike["query"]
        ).call(client, text, params);
        // After the loser reads an empty run, let the winner commit v1.
        if (!interleaved && text.includes("MAX(version)")) {
          interleaved = true;
          rows.push({ pipeline_run_id: "run-1", version: 1 });
        }
        return result as { rows: T[] };
      }) as PostgresClientLike["query"];

      const conflict = await store.saveIfVersion(
        makeCheckpoint({ version: 1 }),
        0
      );

      expect(conflict.committed).toBe(false);
      // The loser observes the winner's version, not its own attempt.
      expect(conflict.observedVersion).toBe(1);
      // Exactly one row for that version — the winner's.
      expect(rows.filter((r) => r.version === 1)).toHaveLength(1);
    });

    it("rejects a stale expected version early, before touching the table", async () => {
      const { client } = createUniqueEnforcingClient();
      const store = new PostgresPipelineCheckpointStore({ client });
      await store.saveIfVersion(makeCheckpoint({ version: 1 }), 0);

      const conflict = await store.saveIfVersion(
        makeCheckpoint({ version: 1 }),
        0
      );

      expect(conflict).toEqual({ committed: false, observedVersion: 1 });
    });

    it("rejects a stale expected version before attempting the insert", async () => {
      const { client, calls } = createUniqueEnforcingClient();
      const store = new PostgresPipelineCheckpointStore({ client });
      await store.saveIfVersion(makeCheckpoint({ version: 1 }), 0);
      const insertsBefore = calls.filter((c) =>
        c.text.includes("INSERT INTO")
      ).length;

      const conflict = await store.saveIfVersion(
        makeCheckpoint({ version: 2 }),
        0
      );

      expect(conflict).toEqual({ committed: false, observedVersion: 1 });
      const insertsAfter = calls.filter((c) =>
        c.text.includes("INSERT INTO")
      ).length;
      expect(insertsAfter).toBe(insertsBefore);
    });

    it("persists every mapped column — a dropped field would vanish only in Postgres", async () => {
      // In-memory and Redis serialize the checkpoint wholesale, so they cannot
      // catch a column the explicit mapping forgot. This pins the CAS insert to
      // the same 17-column shape `save` writes.
      const { client, calls } = createUniqueEnforcingClient();
      const store = new PostgresPipelineCheckpointStore({ client });

      await store.saveIfVersion(
        makeCheckpoint({
          version: 1,
          sourceBinding: { definitionDigest: `sha256:${"a".repeat(64)}` },
        }),
        0
      );

      const insert = calls.find((c) => c.text.includes("INSERT INTO"))!;
      expect(insert.text).toContain("source_binding");
      expect(insert.params).toHaveLength(17);
      expect(JSON.parse(insert.params[16] as string)).toEqual({
        definitionDigest: `sha256:${"a".repeat(64)}`,
      });
    });
  });
});
