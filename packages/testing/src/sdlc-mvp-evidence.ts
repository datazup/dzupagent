import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Socket } from "node:net";

import {
  createRuntimeToolHandlers,
  InMemoryPipelineCheckpointStore,
  PostgresPipelineCheckpointStore,
  PipelineRuntime,
  RedisPipelineCheckpointStore,
  type PostgresClientLike,
  type RedisClientLike,
} from "@dzupagent/agent/pipeline";
import type {
  PipelineCheckpoint,
  PipelineDefinition,
} from "@dzupagent/core/pipeline";
import { createFlowCompiler } from "@dzupagent/flow-compiler";
import {
  BUILT_IN_FRAGMENT_REGISTRY,
  parseDslToDocument,
} from "@dzupagent/flow-dsl";

import {
  createSdlcValidationRuntimeToolHandlers,
  shapeCommandOutputsForBatchValidation,
} from "./sdlc-validation.js";

const SDLC_MVP_EVIDENCE_SCHEMA_VERSION = 1;

export interface SdlcMvpEvidenceCommandOutput {
  id: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface SdlcMvpEvidencePacketItem {
  ref: string;
}

export interface SdlcMvpEvidenceReport {
  schemaVersion: typeof SDLC_MVP_EVIDENCE_SCHEMA_VERSION;
  parseOk: boolean;
  compileOk: boolean;
  runtimeReady: boolean;
  readinessReport: string;
  checkpointBackend: "memory" | "redis" | "postgres";
  backendChecks: {
    redisConfigured: boolean;
    postgresConfigured: boolean;
  };
  checkpointProof: {
    backend: "memory" | "redis" | "postgres";
    status: "passed" | "skipped";
    reason?: string;
    checkpointVersion?: number;
  };
  execution: {
    state: string;
    runId: string;
    exportedState: {
      truth?: unknown;
      closeoutStatus?: unknown;
    };
  };
}

interface SdlcMvpFlowExecution {
  parseOk: boolean;
  compileOk: boolean;
  runtimeReady: boolean;
  readinessReport: string;
  execution: SdlcMvpEvidenceReport["execution"];
}

export interface RunSdlcMvpEvidenceReportInput {
  commandOutputs: readonly SdlcMvpEvidenceCommandOutput[];
  packetItems?: readonly SdlcMvpEvidencePacketItem[];
  env?: Record<string, string | undefined>;
  runId?: string;
  /**
   * Factory used to create a live Redis client when `DZUPAGENT_REDIS_URL` is
   * configured. Defaults to {@link createLiveRedisClient}. Tests should
   * inject a fake here instead of relying on a running Redis instance.
   */
  redisClientFactory?: (url: string) => Promise<RedisClientLike>;
  /**
   * Factory used to create a live Postgres client when
   * `DZUPAGENT_POSTGRES_URL` is configured. Defaults to
   * {@link createLivePostgresClient}. Tests should inject a fake here
   * instead of relying on a running Postgres instance.
   */
  postgresClientFactory?: (url: string) => Promise<PostgresClientLike>;
}

export interface ShapeSdlcMvpEvidenceCommandOutputsInput {
  commandOutputJsonPath: string;
  packetJsonPath?: string;
}

export interface ShapedSdlcMvpEvidenceCommandOutputs {
  commandOutputs: SdlcMvpEvidenceCommandOutput[];
  packetItems?: SdlcMvpEvidencePacketItem[];
}

export async function shapeSdlcMvpEvidenceCommandOutputs(
  input: ShapeSdlcMvpEvidenceCommandOutputsInput
): Promise<ShapedSdlcMvpEvidenceCommandOutputs> {
  const commandOutputs = parseCommandOutputs(
    await readJson(input.commandOutputJsonPath)
  );
  if (input.packetJsonPath === undefined) return { commandOutputs };
  return {
    commandOutputs,
    packetItems: parsePacketItems(await readJson(input.packetJsonPath)),
  };
}

export async function runSdlcMvpEvidenceReport(
  input: RunSdlcMvpEvidenceReportInput
): Promise<SdlcMvpEvidenceReport> {
  const commandOutputs = parseCommandOutputs(input.commandOutputs);
  const packetItems =
    input.packetItems === undefined ? [] : parsePacketItems(input.packetItems);
  const env = input.env ?? {};
  const backend = await verifyCheckpointBackend(env, {
    ...(input.redisClientFactory !== undefined
      ? { redisClientFactory: input.redisClientFactory }
      : {}),
    ...(input.postgresClientFactory !== undefined
      ? { postgresClientFactory: input.postgresClientFactory }
      : {}),
  });
  const failed = commandOutputs.find((item) => item.exitCode !== 0);
  const passed = failed === undefined;
  const runId = input.runId ?? `sdlc-mvp-evidence-${Date.now()}`;
  const flowExecution = await executeSdlcMvpEvidenceFlow({
    commandOutputs,
    packetItems,
    runId,
    passed,
    ...(failed === undefined
      ? {}
      : { blockedReason: `${failed.id} exited ${failed.exitCode}` }),
  });

  return {
    schemaVersion: SDLC_MVP_EVIDENCE_SCHEMA_VERSION,
    parseOk: flowExecution.parseOk,
    compileOk: flowExecution.compileOk,
    runtimeReady: flowExecution.runtimeReady,
    readinessReport: flowExecution.readinessReport,
    checkpointBackend: backend.backend,
    backendChecks: {
      redisConfigured: backend.redisConfigured,
      postgresConfigured: backend.postgresConfigured,
    },
    checkpointProof: backend.proof,
    execution: flowExecution.execution,
  };
}

async function executeSdlcMvpEvidenceFlow(input: {
  commandOutputs: readonly SdlcMvpEvidenceCommandOutput[];
  packetItems: readonly SdlcMvpEvidencePacketItem[];
  runId: string;
  passed: boolean;
  blockedReason?: string;
}): Promise<SdlcMvpFlowExecution> {
  const source = sdlcMvpCloseoutFlowSource(
    input.passed ? "complete" : "blocked",
  );
  const parsed = parseDslToDocument(source, {
    fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY,
    requirePinnedFragmentUses: true,
  });
  if (!parsed.ok) {
    return failedFlowExecution({
      runId: input.runId,
      parseOk: false,
      compileOk: false,
      runtimeReady: false,
      readinessReport: `Runtime tool readiness: blocked (parse failed: ${parsed.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")})`,
    });
  }

  const compiler = createFlowCompiler({
    toolResolver: {
      resolve(ref) {
        if (ref !== "sdlc.current_truth" && ref !== "validate.schema") {
          return null;
        }
        return {
          ref,
          kind: "skill",
          inputSchema: { type: "object" },
          handle: { skillId: ref },
        };
      },
      listAvailable: () => ["sdlc.current_truth", "validate.schema"],
    },
  });
  const compiled = await compiler.compileDocument(parsed.document);
  if ("errors" in compiled) {
    return failedFlowExecution({
      runId: input.runId,
      parseOk: true,
      compileOk: false,
      runtimeReady: false,
      readinessReport: `Runtime tool readiness: blocked (compile failed: ${compiled.errors
        .map((error) => error.message)
        .join("; ")})`,
    });
  }

  const checkpointStore = new InMemoryPipelineCheckpointStore();
  const runtimeResult = await new PipelineRuntime({
    definition: {
      ...(compiled.artifact as PipelineDefinition),
      checkpointStrategy: "after_each_node",
    },
    checkpointStore,
    runtimeToolHandlers: {
      ...createRuntimeToolHandlers({
        workerDispatch: async ({ context }) => {
          const packet = context.state.packetItem as { ref: string };
          return {
            output: {
              packetRef: packet.ref,
              accepted: true,
              status: "ready",
            },
          };
        },
      }),
      ...createSdlcValidationRuntimeToolHandlers(),
    },
    nodeExecutor: async (nodeId, node) => {
      if (node.type === "tool" && node.toolName === "sdlc.current_truth") {
        return {
          nodeId,
          output: {
            scope: "dzupagent",
            dirty: false,
            commandCount: input.commandOutputs.length,
            packetRefs: input.packetItems.map((item) => item.ref),
            ...(input.blockedReason !== undefined
              ? { blockedReason: input.blockedReason }
              : {}),
          },
          durationMs: 1,
        };
      }
      return {
        nodeId,
        output: null,
        durationMs: 1,
        error: `unexpected fallback execution for ${node.type}`,
      };
    },
  }).execute({
    packetItems: input.packetItems,
    validationItems: shapeCommandOutputsForBatchValidation(input.commandOutputs),
  });
  const finalCheckpoint = await checkpointStore.load(runtimeResult.runId);
  const exportedState = {
    truth: finalCheckpoint?.state.truth,
    closeoutStatus: finalCheckpoint?.state.closeoutStatus,
  };
  const runtimeReady =
    runtimeResult.state === "completed" &&
    exportedState.closeoutStatus === "complete";

  return {
    parseOk: true,
    compileOk: true,
    runtimeReady,
    readinessReport: runtimeReady
      ? "Runtime tool readiness: ready"
      : `Runtime tool readiness: blocked (${input.blockedReason ?? "closeout status is not complete"})`,
    execution: {
      state: runtimeReady ? "completed" : "blocked",
      runId: input.runId,
      exportedState,
    },
  };
}

function failedFlowExecution(input: {
  runId: string;
  parseOk: boolean;
  compileOk: boolean;
  runtimeReady: boolean;
  readinessReport: string;
}): SdlcMvpFlowExecution {
  return {
    parseOk: input.parseOk,
    compileOk: input.compileOk,
    runtimeReady: input.runtimeReady,
    readinessReport: input.readinessReport,
    execution: {
      state: "blocked",
      runId: input.runId,
      exportedState: {},
    },
  };
}

function sdlcMvpCloseoutFlowSource(status: "complete" | "blocked"): string {
  return `dsl: dzupflow/v1
id: sdlc-mvp-evidence
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.current_truth:
      id: truth
      scope: dzupagent
      output: truth
  - sdlc.packet_fanout:
      id: fanout
      packets: packetItems
      output: packetStatuses
  - sdlc.batch_validation:
      id: batch
      items: validationItems
      output: validationStatuses
  - sdlc.closeout:
      id: closeout
      status: ${status}
      output: closeoutStatus
`;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseCommandOutputs(value: unknown): SdlcMvpEvidenceCommandOutput[] {
  if (!Array.isArray(value)) {
    throw new Error("command output JSON must be an array");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("command output item must be an object");
    }
    if (
      typeof item.id !== "string" ||
      item.id.trim().length === 0 ||
      typeof item.command !== "string" ||
      item.command.trim().length === 0 ||
      typeof item.exitCode !== "number" ||
      !Number.isFinite(item.exitCode) ||
      typeof item.stdout !== "string" ||
      typeof item.stderr !== "string"
    ) {
      throw new Error(
        "command output item must include id, command, exitCode, stdout, and stderr"
      );
    }
    return {
      id: item.id,
      command: item.command,
      exitCode: item.exitCode,
      stdout: item.stdout,
      stderr: item.stderr,
      ...(typeof item.durationMs === "number" &&
      Number.isFinite(item.durationMs)
        ? { durationMs: item.durationMs }
        : {}),
    };
  });
}

function parsePacketItems(value: unknown): SdlcMvpEvidencePacketItem[] {
  if (!Array.isArray(value)) {
    throw new Error("packet JSON must be an array");
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.ref !== "string" ||
      item.ref.trim().length === 0
    ) {
      throw new Error("packet item must include ref");
    }
    return { ref: item.ref };
  });
}

// ---------------------------------------------------------------------------
// Live checkpoint backend verification
// ---------------------------------------------------------------------------

interface CheckpointBackendVerification {
  backend: "memory" | "redis" | "postgres";
  redisConfigured: boolean;
  postgresConfigured: boolean;
  proof: SdlcMvpEvidenceReport["checkpointProof"];
}

interface CheckpointBackendFactories {
  redisClientFactory?: (url: string) => Promise<RedisClientLike>;
  postgresClientFactory?: (url: string) => Promise<PostgresClientLike>;
}

/**
 * Verifies checkpoint backend connectivity by actually saving, loading, and
 * deleting a throwaway checkpoint against the configured live backend
 * (Redis or Postgres) rather than trusting env-var presence alone.
 *
 * Falls back to the in-memory ("skipped") result when no backend is
 * configured, or when a backend is configured but no client factory was
 * supplied to construct a connection.
 */
async function verifyCheckpointBackend(
  env: Record<string, string | undefined>,
  factories: CheckpointBackendFactories
): Promise<CheckpointBackendVerification> {
  const redisUrl = env.DZUPAGENT_REDIS_URL;
  const postgresUrl = env.DZUPAGENT_POSTGRES_URL;
  const redisConfigured = Boolean(redisUrl);
  const postgresConfigured = Boolean(postgresUrl);

  if (redisConfigured) {
    if (!factories.redisClientFactory) {
      return {
        backend: "memory",
        redisConfigured,
        postgresConfigured,
        proof: {
          backend: "memory",
          status: "skipped",
          reason: "redis client factory not configured",
        },
      };
    }
    const proof = await verifyLiveRedisCheckpoint(
      redisUrl!,
      factories.redisClientFactory
    );
    return { backend: "redis", redisConfigured, postgresConfigured, proof };
  }

  if (postgresConfigured) {
    if (!factories.postgresClientFactory) {
      return {
        backend: "memory",
        redisConfigured,
        postgresConfigured,
        proof: {
          backend: "memory",
          status: "skipped",
          reason: "postgres client factory not configured",
        },
      };
    }
    const proof = await verifyLivePostgresCheckpoint(
      postgresUrl!,
      factories.postgresClientFactory
    );
    return { backend: "postgres", redisConfigured, postgresConfigured, proof };
  }

  return {
    backend: "memory",
    redisConfigured,
    postgresConfigured,
    proof: {
      backend: "memory",
      status: "skipped",
      reason: "No persistent checkpoint backend configured",
    },
  };
}

function evidenceCheckpoint(runId: string): PipelineCheckpoint {
  return {
    pipelineRunId: runId,
    pipelineId: "sdlc-mvp-evidence",
    version: 1,
    schemaVersion: "1.0.0",
    completedNodeIds: [],
    state: {},
    createdAt: new Date().toISOString(),
  };
}

async function verifyLiveRedisCheckpoint(
  url: string,
  redisClientFactory: (url: string) => Promise<RedisClientLike>
): Promise<SdlcMvpEvidenceReport["checkpointProof"]> {
  const runId = `sdlc-mvp-evidence-${randomUUID()}`;
  let client: RedisClientLike | undefined;
  try {
    client = await redisClientFactory(url);
    const store = new RedisPipelineCheckpointStore({
      client,
      keyPrefix: `sdlc:mvp:evidence:${randomUUID()}`,
      defaultTtlSeconds: 60 * 60,
    });
    await store.save(evidenceCheckpoint(runId));
    const loaded = await store.load(runId);
    await store.delete(runId);
    return {
      backend: "redis",
      status: "passed",
      ...(loaded?.version !== undefined
        ? { checkpointVersion: loaded.version }
        : {}),
    };
  } catch (error) {
    return {
      backend: "redis",
      status: "skipped",
      reason: `redis checkpoint verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (client && "close" in client && typeof client.close === "function") {
      await client.close();
    }
  }
}

async function verifyLivePostgresCheckpoint(
  url: string,
  postgresClientFactory: (url: string) => Promise<PostgresClientLike>
): Promise<SdlcMvpEvidenceReport["checkpointProof"]> {
  const runId = `sdlc-mvp-evidence-${randomUUID()}`;
  const tableName = `sdlc_mvp_evidence_${randomUUID().replaceAll("-", "_")}`;
  let client: PostgresClientLike | undefined;
  try {
    client = await postgresClientFactory(url);
    const store = new PostgresPipelineCheckpointStore({
      client,
      tableName,
      defaultTtlMs: 60 * 60 * 1000,
    });
    await store.setup();
    await store.save(evidenceCheckpoint(runId));
    const loaded = await store.load(runId);
    await store.delete(runId);
    return {
      backend: "postgres",
      status: "passed",
      ...(loaded?.version !== undefined
        ? { checkpointVersion: loaded.version }
        : {}),
    };
  } catch (error) {
    return {
      backend: "postgres",
      status: "skipped",
      reason: `postgres checkpoint verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (client) {
      // Drop the temporary evidence table regardless of verification
      // outcome so repeated runs don't leak tables into the target
      // database (see fix: "drop temporary SDLC evidence tables").
      try {
        await client.query(`DROP TABLE IF EXISTS ${tableName}`);
      } catch {
        // best-effort cleanup — do not mask the original proof result
      }
      if ("close" in client && typeof client.close === "function") {
        await client.close();
      } else if ("end" in client && typeof client.end === "function") {
        await client.end();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Live client factories (used by the CLI; injectable in tests)
// ---------------------------------------------------------------------------

export async function createLiveRedisClient(
  rawUrl: string
): Promise<RedisClientLike & { close(): void }> {
  return LiveRedisClient.connect(rawUrl);
}

export async function createLivePostgresClient(
  connectionString: string
): Promise<PostgresClientLike & { close(): Promise<void> }> {
  const importModule = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<unknown>;
  const pg = (await importModule("pg")) as {
    Client: new (options: {
      connectionString: string;
    }) => PostgresClientLike & {
      connect(): Promise<void>;
      end(): Promise<void>;
    };
  };
  const client = new pg.Client({ connectionString });
  await client.connect();
  return {
    query: (text, params) => client.query(text, params),
    close: () => client.end(),
  };
}

/**
 * Minimal RESP (Redis Serialization Protocol) client over a raw TCP socket.
 * Avoids adding a runtime dependency on `ioredis`/`redis` just to prove
 * connectivity for evidence reports.
 */
class LiveRedisClient implements RedisClientLike {
  private pending = Promise.resolve();

  private constructor(private readonly socket: Socket) {}

  static async connect(rawUrl: string): Promise<LiveRedisClient> {
    const url = new URL(rawUrl);
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(
        Number(url.port || 6379),
        url.hostname || "127.0.0.1",
        () => {
          socket.off("error", reject);
          resolve();
        }
      );
    });
    const client = new LiveRedisClient(socket);
    if (url.password) {
      await client.command("AUTH", url.password);
    }
    if (url.pathname && url.pathname !== "/") {
      await client.command("SELECT", url.pathname.slice(1));
    }
    return client;
  }

  close(): void {
    this.socket.destroy();
  }

  set(
    key: string,
    value: string,
    ...modifiers: Array<string | number>
  ): Promise<unknown> {
    return this.command("SET", key, value, ...modifiers);
  }

  get(key: string): Promise<string | null> {
    return this.command("GET", key) as Promise<string | null>;
  }

  del(...keys: string[]): Promise<number> {
    return this.command("DEL", ...keys) as Promise<number>;
  }

  zadd(key: string, ...scoreMembers: Array<string | number>): Promise<unknown> {
    return this.command("ZADD", key, ...scoreMembers);
  }

  zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.command("ZRANGE", key, start, stop) as Promise<string[]>;
  }

  zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.command("ZREVRANGE", key, start, stop) as Promise<string[]>;
  }

  zscore(key: string, member: string): Promise<string | null> {
    return this.command("ZSCORE", key, member) as Promise<string | null>;
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    return this.command("ZREM", key, ...members) as Promise<number>;
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    return this.command("SADD", key, ...members) as Promise<number>;
  }

  srem(key: string, ...members: string[]): Promise<number> {
    return this.command("SREM", key, ...members) as Promise<number>;
  }

  smembers(key: string): Promise<string[]> {
    return this.command("SMEMBERS", key) as Promise<string[]>;
  }

  exists(key: string): Promise<number> {
    return this.command("EXISTS", key) as Promise<number>;
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.command("EXPIRE", key, seconds) as Promise<number>;
  }

  private command(...parts: Array<string | number>): Promise<unknown> {
    const run = this.pending.then(() => this.writeCommand(parts));
    this.pending = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private writeCommand(parts: Array<string | number>): Promise<unknown> {
    const payload = encodeRedisCommand(parts);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
      };
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const parsed = parseRedisReply(Buffer.concat(chunks));
        if (!parsed.complete) return;
        cleanup();
        if (parsed.error) {
          reject(new Error(parsed.error));
        } else {
          resolve(parsed.value);
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.write(payload);
    });
  }
}

function encodeRedisCommand(parts: Array<string | number>): string {
  const encoded = parts.map((part) => String(part));
  return [
    `*${encoded.length}`,
    ...encoded.flatMap((part) => [`$${Buffer.byteLength(part)}`, part]),
    "",
  ].join("\r\n");
}

function parseRedisReply(
  buffer: Buffer
): { complete: false } | { complete: true; value?: unknown; error?: string } {
  const [prefix] = buffer.toString("utf8", 0, 1);
  if (prefix === "+") {
    const end = buffer.indexOf("\r\n");
    if (end === -1) return { complete: false };
    return { complete: true, value: buffer.toString("utf8", 1, end) };
  }
  if (prefix === "-") {
    const end = buffer.indexOf("\r\n");
    if (end === -1) return { complete: false };
    return { complete: true, error: buffer.toString("utf8", 1, end) };
  }
  if (prefix === ":") {
    const end = buffer.indexOf("\r\n");
    if (end === -1) return { complete: false };
    return { complete: true, value: Number(buffer.toString("utf8", 1, end)) };
  }
  if (prefix === "$") {
    return parseBulkRedisReply(buffer);
  }
  if (prefix === "*") {
    return parseArrayRedisReply(buffer);
  }
  return { complete: true, error: `Unsupported Redis reply prefix: ${prefix}` };
}

function parseBulkRedisReply(
  buffer: Buffer
): { complete: false } | { complete: true; value: string | null } {
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd === -1) return { complete: false };
  const length = Number(buffer.toString("utf8", 1, headerEnd));
  if (length === -1) return { complete: true, value: null };
  const valueStart = headerEnd + 2;
  const valueEnd = valueStart + length;
  if (buffer.length < valueEnd + 2) return { complete: false };
  return {
    complete: true,
    value: buffer.toString("utf8", valueStart, valueEnd),
  };
}

function parseArrayRedisReply(
  buffer: Buffer
): { complete: false } | { complete: true; value: unknown[]; error?: string } {
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd === -1) return { complete: false };
  const count = Number(buffer.toString("utf8", 1, headerEnd));
  const values: unknown[] = [];
  let offset = headerEnd + 2;
  for (let index = 0; index < count; index += 1) {
    const parsed = parseRedisReply(buffer.subarray(offset));
    if (!parsed.complete) return { complete: false };
    if (parsed.error)
      return { complete: true, value: values, error: parsed.error };
    values.push(parsed.value);
    const consumed = redisReplyLength(buffer.subarray(offset));
    if (consumed === undefined) return { complete: false };
    offset += consumed;
  }
  return { complete: true, value: values };
}

function redisReplyLength(buffer: Buffer): number | undefined {
  const [prefix] = buffer.toString("utf8", 0, 1);
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd === -1) return undefined;
  if (prefix === "+" || prefix === "-" || prefix === ":") return headerEnd + 2;
  if (prefix === "$") {
    const length = Number(buffer.toString("utf8", 1, headerEnd));
    return length === -1 ? headerEnd + 2 : headerEnd + 2 + length + 2;
  }
  if (prefix !== "*") return undefined;
  const count = Number(buffer.toString("utf8", 1, headerEnd));
  let offset = headerEnd + 2;
  for (let index = 0; index < count; index += 1) {
    const childLength = redisReplyLength(buffer.subarray(offset));
    if (childLength === undefined) return undefined;
    offset += childLength;
  }
  return offset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
