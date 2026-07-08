import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  PostgresClientLike,
  RedisClientLike,
} from "@dzupagent/agent/pipeline";

import {
  runSdlcMvpEvidenceReport,
  shapeSdlcMvpEvidenceCommandOutputs,
} from "../sdlc-mvp-evidence.js";

// ---------------------------------------------------------------------------
// In-memory fakes — no live Redis/Postgres required.
// ---------------------------------------------------------------------------

class FakeRedisClient implements RedisClientLike {
  strings = new Map<string, string>();
  sortedSets = new Map<string, Map<string, number>>();
  sets = new Map<string, Set<string>>();
  closed = false;

  async set(
    key: string,
    value: string,
    ..._modifiers: Array<string | number>
  ): Promise<"OK"> {
    this.strings.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.strings.delete(k)) count++;
      if (this.sortedSets.delete(k)) count++;
      if (this.sets.delete(k)) count++;
    }
    return count;
  }

  async zadd(
    key: string,
    ...scoreMembers: Array<string | number>
  ): Promise<number> {
    let zset = this.sortedSets.get(key);
    if (!zset) {
      zset = new Map();
      this.sortedSets.set(key, zset);
    }
    let added = 0;
    for (let i = 0; i < scoreMembers.length; i += 2) {
      const score = Number(scoreMembers[i]);
      const member = String(scoreMembers[i + 1]);
      if (!zset.has(member)) added++;
      zset.set(member, score);
    }
    return added;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key);
    if (!zset) return [];
    const sorted = [...zset.entries()]
      .sort((a, b) => a[1] - b[1])
      .map((e) => e[0]);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key);
    if (!zset) return [];
    const sorted = [...zset.entries()]
      .sort((a, b) => b[1] - a[1])
      .map((e) => e[0]);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end);
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const score = this.sortedSets.get(key)?.get(member);
    return score === undefined ? null : String(score);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const zset = this.sortedSets.get(key);
    if (!zset) return 0;
    let removed = 0;
    for (const member of members) {
      if (zset.delete(member)) removed++;
    }
    return removed;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added++;
      set.add(member);
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed++;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) ? 1 : 0;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * Minimal stateful Postgres fake — stores rows in a JS array and
 * understands only the SQL shapes issued by PostgresPipelineCheckpointStore
 * (CREATE/ALTER TABLE, upsert INSERT, SELECT latest, DELETE, DROP TABLE).
 */
class FakePostgresClient implements PostgresClientLike {
  rows: Array<Record<string, unknown>> = [];
  droppedTables: string[] = [];
  ended = false;

  async query<T = unknown>(
    text: string,
    params: unknown[] = []
  ): Promise<{ rows: T[] }> {
    const sql = text.trim();
    if (/^CREATE TABLE|^CREATE INDEX|^ALTER TABLE/i.test(sql)) {
      return { rows: [] as T[] };
    }
    if (/^DROP TABLE/i.test(sql)) {
      const match = /DROP TABLE IF EXISTS (\w+)/i.exec(sql);
      if (match) this.droppedTables.push(match[1]!);
      return { rows: [] as T[] };
    }
    if (/^INSERT INTO/i.test(sql)) {
      const [
        pipelineRunId,
        pipelineId,
        version,
        schemaVersion,
        completedNodeIds,
        state,
        suspendedAtNodeId,
        budgetState,
        createdAt,
        expiresAt,
        nodeIdempotencyKeys,
        loopState,
        forkState,
        recoveryAttemptsUsed,
        providerSessionRefs,
      ] = params;
      const existingIndex = this.rows.findIndex(
        (row) =>
          row.pipeline_run_id === pipelineRunId && row.version === version
      );
      const row = {
        pipeline_run_id: pipelineRunId,
        pipeline_id: pipelineId,
        version,
        schema_version: schemaVersion,
        completed_node_ids: JSON.parse(completedNodeIds as string) as unknown,
        state: JSON.parse(state as string) as unknown,
        suspended_at_node_id: suspendedAtNodeId,
        budget_state: budgetState ? JSON.parse(budgetState as string) : null,
        created_at: createdAt,
        expires_at: expiresAt,
        node_idempotency_keys: nodeIdempotencyKeys
          ? JSON.parse(nodeIdempotencyKeys as string)
          : null,
        loop_state: loopState ? JSON.parse(loopState as string) : null,
        fork_state: forkState ? JSON.parse(forkState as string) : null,
        recovery_attempts_used: recoveryAttemptsUsed,
        provider_session_refs: providerSessionRefs
          ? JSON.parse(providerSessionRefs as string)
          : null,
      };
      if (existingIndex >= 0) {
        this.rows[existingIndex] = row;
      } else {
        this.rows.push(row);
      }
      return { rows: [] as T[] };
    }
    if (/^SELECT \* FROM/i.test(sql)) {
      const [runId] = params;
      const matches = this.rows
        .filter((row) => row.pipeline_run_id === runId)
        .sort((a, b) => (b.version as number) - (a.version as number));
      return { rows: matches.slice(0, 1) as unknown[] as T[] };
    }
    if (/^DELETE FROM/i.test(sql)) {
      const [runId] = params;
      this.rows = this.rows.filter((row) => row.pipeline_run_id !== runId);
      return { rows: [] as T[] };
    }
    return { rows: [] as T[] };
  }

  async close(): Promise<void> {
    this.ended = true;
  }
}

describe("SDLC MVP evidence report", () => {
  it("builds a passing memory-backed report from successful host command outputs", async () => {
    const report = await runSdlcMvpEvidenceReport({
      commandOutputs: [
        {
          id: "api-typecheck",
          command: "yarn workspace @codev-app/api typecheck",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        },
      ],
      packetItems: [{ ref: "codev/operator-closeout" }],
      env: {},
      runId: "run-test",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      parseOk: true,
      compileOk: true,
      runtimeReady: true,
      readinessReport: "Runtime tool readiness: ready",
      checkpointBackend: "memory",
      backendChecks: {
        redisConfigured: false,
        postgresConfigured: false,
      },
      checkpointProof: {
        backend: "memory",
        status: "skipped",
        reason: "No persistent checkpoint backend configured",
      },
      execution: {
        state: "completed",
        runId: "run-test",
        exportedState: {
          truth: {
            commandCount: 1,
            packetRefs: ["codev/operator-closeout"],
          },
          closeoutStatus: "complete",
        },
      },
    });
  });

  it("marks readiness blocked when a host command failed", async () => {
    const report = await runSdlcMvpEvidenceReport({
      commandOutputs: [
        {
          id: "api-test",
          command: "yarn workspace @codev-app/api test",
          exitCode: 1,
          stdout: "",
          stderr: "failed",
        },
      ],
      env: {},
      runId: "run-failed",
    });

    expect(report).toMatchObject({
      parseOk: true,
      compileOk: false,
      runtimeReady: false,
      readinessReport: "Runtime tool readiness: blocked (api-test exited 1)",
      execution: {
        state: "blocked",
        runId: "run-failed",
        exportedState: {
          closeoutStatus: "blocked",
        },
      },
    });
  });

  it("loads command outputs and packet refs from CLI JSON files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdlc-mvp-evidence-test-"));
    try {
      const commandOutputPath = join(dir, "commands.json");
      const packetPath = join(dir, "packets.json");
      await writeFile(
        commandOutputPath,
        JSON.stringify([
          {
            id: "api-typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          },
        ]),
        "utf8"
      );
      await writeFile(
        packetPath,
        JSON.stringify([{ ref: "packet-a" }]),
        "utf8"
      );

      const shaped = await shapeSdlcMvpEvidenceCommandOutputs({
        commandOutputJsonPath: commandOutputPath,
        packetJsonPath: packetPath,
      });

      expect(shaped).toEqual({
        commandOutputs: [
          {
            id: "api-typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          },
        ],
        packetItems: [{ ref: "packet-a" }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed command output JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdlc-mvp-evidence-test-"));
    try {
      const commandOutputPath = join(dir, "commands.json");
      await writeFile(
        commandOutputPath,
        JSON.stringify([{ id: "missing-fields" }]),
        "utf8"
      );

      await expect(
        shapeSdlcMvpEvidenceCommandOutputs({
          commandOutputJsonPath: commandOutputPath,
        })
      ).rejects.toThrow(
        /command output item must include id, command, exitCode, stdout, and stderr/i
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("live checkpoint backend verification", () => {
    it("verifies a live Redis backend by round-tripping a checkpoint through a fake client", async () => {
      const fakeRedis = new FakeRedisClient();
      const report = await runSdlcMvpEvidenceReport({
        commandOutputs: [
          {
            id: "typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        ],
        env: { DZUPAGENT_REDIS_URL: "redis://localhost:6379" },
        runId: "run-redis",
        redisClientFactory: async () => fakeRedis,
      });

      expect(report.checkpointBackend).toBe("redis");
      expect(report.backendChecks).toEqual({
        redisConfigured: true,
        postgresConfigured: false,
      });
      expect(report.checkpointProof).toMatchObject({
        backend: "redis",
        status: "passed",
        checkpointVersion: 1,
      });
      // The client should be closed after verification.
      expect(fakeRedis.closed).toBe(true);
      // The throwaway checkpoint should not remain in the store.
      expect(fakeRedis.strings.size).toBe(0);
    });

    it("verifies a live Postgres backend, creates then drops the temp evidence table", async () => {
      const fakePostgres = new FakePostgresClient();
      const report = await runSdlcMvpEvidenceReport({
        commandOutputs: [
          {
            id: "typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        ],
        env: { DZUPAGENT_POSTGRES_URL: "postgres://localhost:5432/db" },
        runId: "run-postgres",
        postgresClientFactory: async () => fakePostgres,
      });

      expect(report.checkpointBackend).toBe("postgres");
      expect(report.backendChecks).toEqual({
        redisConfigured: false,
        postgresConfigured: true,
      });
      expect(report.checkpointProof).toMatchObject({
        backend: "postgres",
        status: "passed",
        checkpointVersion: 1,
      });
      // Temp evidence table must be dropped after verification (a6159aec fix).
      expect(fakePostgres.droppedTables).toHaveLength(1);
      expect(fakePostgres.droppedTables[0]).toMatch(/^sdlc_mvp_evidence_/);
      expect(fakePostgres.ended).toBe(true);
      expect(fakePostgres.rows).toHaveLength(0);
    });

    it("prefers redis over postgres when both are configured", async () => {
      const fakeRedis = new FakeRedisClient();
      const fakePostgres = new FakePostgresClient();
      const report = await runSdlcMvpEvidenceReport({
        commandOutputs: [
          {
            id: "typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        ],
        env: {
          DZUPAGENT_REDIS_URL: "redis://localhost:6379",
          DZUPAGENT_POSTGRES_URL: "postgres://localhost:5432/db",
        },
        runId: "run-both",
        redisClientFactory: async () => fakeRedis,
        postgresClientFactory: async () => fakePostgres,
      });

      expect(report.checkpointBackend).toBe("redis");
      expect(report.backendChecks).toEqual({
        redisConfigured: true,
        postgresConfigured: true,
      });
      expect(fakePostgres.rows).toHaveLength(0);
      expect(fakePostgres.droppedTables).toHaveLength(0);
    });

    it("falls back to memory (skipped) when redis is configured but no client factory is supplied", async () => {
      const report = await runSdlcMvpEvidenceReport({
        commandOutputs: [
          {
            id: "typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        ],
        env: { DZUPAGENT_REDIS_URL: "redis://localhost:6379" },
        runId: "run-no-factory",
      });

      expect(report.checkpointBackend).toBe("memory");
      expect(report.checkpointProof).toMatchObject({
        backend: "memory",
        status: "skipped",
        reason: "redis client factory not configured",
      });
    });

    it("falls back to memory (skipped) when postgres is configured but no client factory is supplied", async () => {
      const report = await runSdlcMvpEvidenceReport({
        commandOutputs: [
          {
            id: "typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        ],
        env: { DZUPAGENT_POSTGRES_URL: "postgres://localhost:5432/db" },
        runId: "run-no-pg-factory",
      });

      expect(report.checkpointBackend).toBe("memory");
      expect(report.checkpointProof).toMatchObject({
        backend: "memory",
        status: "skipped",
        reason: "postgres client factory not configured",
      });
    });

    it("reports skipped with a reason when live redis verification throws", async () => {
      const report = await runSdlcMvpEvidenceReport({
        commandOutputs: [
          {
            id: "typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        ],
        env: { DZUPAGENT_REDIS_URL: "redis://localhost:6379" },
        runId: "run-redis-error",
        redisClientFactory: async () => {
          throw new Error("connection refused");
        },
      });

      expect(report.checkpointBackend).toBe("redis");
      expect(report.checkpointProof).toMatchObject({
        backend: "redis",
        status: "skipped",
      });
      expect(report.checkpointProof.reason).toMatch(/connection refused/);
    });

    it("reports skipped with a reason when live postgres verification throws", async () => {
      const report = await runSdlcMvpEvidenceReport({
        commandOutputs: [
          {
            id: "typecheck",
            command: "yarn typecheck",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        ],
        env: { DZUPAGENT_POSTGRES_URL: "postgres://localhost:5432/db" },
        runId: "run-postgres-error",
        postgresClientFactory: async () => {
          throw new Error("could not connect to server");
        },
      });

      expect(report.checkpointBackend).toBe("postgres");
      expect(report.checkpointProof).toMatchObject({
        backend: "postgres",
        status: "skipped",
      });
      expect(report.checkpointProof.reason).toMatch(
        /could not connect to server/
      );
    });
  });
});
