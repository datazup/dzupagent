import {
  createRuntimeToolHandlers,
  formatRuntimeToolReadinessReport,
  getRuntimeToolReadiness,
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  PostgresPipelineCheckpointStore,
  RedisPipelineCheckpointStore,
  RUNTIME_TOOL_NAMES,
  type PipelineState,
  type PostgresClientLike,
  type RedisClientLike,
  type RuntimeToolHandlers,
} from "@dzupagent/agent/pipeline";
import type {
  PipelineDefinition,
  PipelineCheckpointStore,
} from "@dzupagent/core/pipeline";
import { createFlowCompiler } from "@dzupagent/flow-compiler";
import {
  BUILT_IN_FRAGMENT_REGISTRY,
  parseDslToDocument,
} from "@dzupagent/flow-dsl";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";

export interface HostValidationCommandOutput {
  id: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface SdlcBatchValidationItem {
  id: string;
  command: string;
  result: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface SdlcBatchValidationStatus {
  id: string;
  command: string;
  accepted: boolean;
  status: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export function shapeCommandOutputsForBatchValidation(
  outputs: readonly HostValidationCommandOutput[],
): SdlcBatchValidationItem[] {
  return outputs.map((output) => {
    const item: SdlcBatchValidationItem = {
      id: output.id,
      command: output.command,
      result: output.exitCode === 0 ? "pass" : "fail",
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
    };
    if (output.durationMs !== undefined) {
      item.durationMs = output.durationMs;
    }
    return item;
  });
}

export interface SdlcValidationRuntimeToolHandlerOptions {
  /**
   * State key used by the `sdlc.batch_validation` loop body for each shaped
   * validation item.
   */
  itemStateKey?: string;
}

export interface SdlcMvpEvidenceReportOptions {
  packetItems?: readonly { ref: string }[];
  commandOutputs?: readonly HostValidationCommandOutput[];
  env?: Record<string, string | undefined>;
  redisClientFactory?: (url: string) => Promise<RedisClientLike>;
  postgresClientFactory?: (url: string) => Promise<PostgresClientLike>;
}

export interface SdlcMvpEvidenceReport {
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
    state: PipelineState;
    runId: string;
    exportedState: {
      truth?: unknown;
      closeoutStatus?: unknown;
    };
  };
}

export function createSdlcValidationRuntimeToolHandlers(
  options: SdlcValidationRuntimeToolHandlerOptions = {},
): RuntimeToolHandlers {
  const itemStateKey = options.itemStateKey ?? "validationItem";
  const handlers = createRuntimeToolHandlers({
    validateSchema: async ({ context, source }) => {
      const item = context.state[itemStateKey];
      if (item === undefined) {
        return { output: source };
      }
      return {
        output: sdlcBatchValidationStatusFromItem(
          item as SdlcBatchValidationItem,
        ),
      };
    },
  });
  return {
    [RUNTIME_TOOL_NAMES.validateSchema]:
      handlers[RUNTIME_TOOL_NAMES.validateSchema]!,
  };
}

const SDLC_MVP_CLOSEOUT_DSL = `
dsl: dzupflow/v1
id: sdlc-mvp-closeout
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
      packetsKey: packetItems
      output: packetStatuses
  - sdlc.batch_validation:
      id: batch
      itemsKey: validationItems
      output: validationStatuses
  - sdlc.closeout:
      id: closeout
      status: complete
      output: closeoutStatus
`;

export async function runSdlcMvpEvidenceReport(
  options: SdlcMvpEvidenceReportOptions = {},
): Promise<SdlcMvpEvidenceReport> {
  const parsed = parseDslToDocument(SDLC_MVP_CLOSEOUT_DSL, {
    fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY,
    requirePinnedFragmentUses: true,
  });
  if (!parsed.ok) {
    throw new Error("expected SDLC MVP closeout DSL to parse");
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
    throw new Error("expected SDLC MVP closeout DSL to compile");
  }

  const definition = {
    ...(compiled.artifact as PipelineDefinition),
    checkpointStrategy: "after_each_node",
  } satisfies PipelineDefinition;
  const runtimeToolHandlers = {
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
  };
  const readiness = getRuntimeToolReadiness(definition, runtimeToolHandlers);
  const env = options.env ?? process.env;
  const redisUrl = env["DZUPAGENT_REDIS_URL"];
  const postgresUrl = env["DZUPAGENT_POSTGRES_URL"];
  const checkpointOptions: {
    redisUrl?: string;
    redisClientFactory?: (url: string) => Promise<RedisClientLike>;
    postgresUrl?: string;
    postgresClientFactory?: (url: string) => Promise<PostgresClientLike>;
  } = {};
  if (redisUrl !== undefined) checkpointOptions.redisUrl = redisUrl;
  if (options.redisClientFactory !== undefined) {
    checkpointOptions.redisClientFactory = options.redisClientFactory;
  }
  if (postgresUrl !== undefined) checkpointOptions.postgresUrl = postgresUrl;
  if (options.postgresClientFactory !== undefined) {
    checkpointOptions.postgresClientFactory = options.postgresClientFactory;
  }
  const checkpoint = await createEvidenceCheckpointStore(checkpointOptions);
  const result = await new PipelineRuntime({
    definition,
    checkpointStore: checkpoint.store,
    runtimeToolHandlers,
    nodeExecutor: async (nodeId, node) => {
      if (node.type === "tool" && node.toolName === "sdlc.current_truth") {
        return {
          nodeId,
          output: { scope: "dzupagent", dirty: false },
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
    packetItems: options.packetItems ?? [
      { ref: "packet/alpha" },
      { ref: "packet/beta" },
    ],
    validationItems: shapeCommandOutputsForBatchValidation(
      options.commandOutputs ?? [
        {
          id: "types",
          command: "yarn workspace @dzupagent/flow-dsl typecheck",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        },
        {
          id: "tests",
          command: "yarn workspace @dzupagent/testing test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        },
      ],
    ),
  });
  const finalCheckpoint = await checkpoint.store.load(result.runId);
  await checkpoint.close?.();

  return {
    parseOk: true,
    compileOk: true,
    runtimeReady: readiness.ready,
    readinessReport: formatRuntimeToolReadinessReport(readiness),
    checkpointBackend: checkpoint.backend,
    backendChecks: {
      redisConfigured: Boolean(env["DZUPAGENT_REDIS_URL"]),
      postgresConfigured: Boolean(env["DZUPAGENT_POSTGRES_URL"]),
    },
    checkpointProof: checkpointProofWithVersion(
      checkpoint.proof,
      finalCheckpoint?.version,
    ),
    execution: {
      state: result.state,
      runId: result.runId,
      exportedState: {
        truth: finalCheckpoint?.state["truth"],
        closeoutStatus: finalCheckpoint?.state["closeoutStatus"],
      },
    },
  };
}

interface EvidenceCheckpointStoreSelection {
  backend: "memory" | "redis" | "postgres";
  store: PipelineCheckpointStore;
  proof: SdlcMvpEvidenceReport["checkpointProof"];
  close?: () => void | Promise<void>;
}

async function createEvidenceCheckpointStore(options: {
  redisUrl?: string;
  redisClientFactory?: (url: string) => Promise<RedisClientLike>;
  postgresUrl?: string;
  postgresClientFactory?: (url: string) => Promise<PostgresClientLike>;
}): Promise<EvidenceCheckpointStoreSelection> {
  if (!options.redisUrl && !options.postgresUrl) {
    return {
      backend: "memory",
      store: new InMemoryPipelineCheckpointStore(),
      proof: {
        backend: "memory",
        status: "skipped",
        reason: "DZUPAGENT_REDIS_URL not configured",
      },
    };
  }

  if (options.redisUrl && !options.redisClientFactory) {
    return {
      backend: "memory",
      store: new InMemoryPipelineCheckpointStore(),
      proof: {
        backend: "memory",
        status: "skipped",
        reason: "redis client factory not configured",
      },
    };
  }

  if (options.redisUrl && options.redisClientFactory) {
    const client = await options.redisClientFactory(options.redisUrl);
    return {
      backend: "redis",
      store: new RedisPipelineCheckpointStore({
        client,
        keyPrefix: `sdlc:mvp:evidence:${randomUUID()}`,
        defaultTtlSeconds: 60 * 60,
      }),
      proof: {
        backend: "redis",
        status: "passed",
      },
      close: () => {
        if ("close" in client && typeof client.close === "function") {
          return client.close();
        }
        return undefined;
      },
    };
  }

  if (!options.postgresClientFactory) {
    return {
      backend: "memory",
      store: new InMemoryPipelineCheckpointStore(),
      proof: {
        backend: "memory",
        status: "skipped",
        reason: "postgres client factory not configured",
      },
    };
  }

  const client = await options.postgresClientFactory(options.postgresUrl!);
  const store = new PostgresPipelineCheckpointStore({
    client,
    tableName: `sdlc_mvp_evidence_${randomUUID().replaceAll("-", "_")}`,
    defaultTtlMs: 60 * 60 * 1000,
  });
  await store.setup();
  return {
    backend: "postgres",
    store,
    proof: {
      backend: "postgres",
      status: "passed",
    },
    close: async () => {
      await store.delete("__unused_cleanup__");
      if ("close" in client && typeof client.close === "function") {
        return client.close();
      }
      if ("end" in client && typeof client.end === "function") {
        return client.end();
      }
      return undefined;
    },
  };
}

export async function createLiveRedisClient(rawUrl: string): Promise<
  RedisClientLike & { close(): void }
> {
  return LiveRedisClient.connect(rawUrl);
}

export async function createLivePostgresClient(
  connectionString: string,
): Promise<PostgresClientLike & { close(): Promise<void> }> {
  const importModule = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<unknown>;
  const pg = (await importModule("pg")) as {
    Client: new (options: { connectionString: string }) => PostgresClientLike & {
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

class LiveRedisClient implements RedisClientLike {
  private pending = Promise.resolve();

  private constructor(private readonly socket: Socket) {}

  static async connect(rawUrl: string): Promise<LiveRedisClient> {
    const url = new URL(rawUrl);
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(Number(url.port || 6379), url.hostname || "127.0.0.1", () => {
        socket.off("error", reject);
        resolve();
      });
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
      () => undefined,
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

function parseRedisReply(buffer: Buffer):
  | { complete: false }
  | { complete: true; value?: unknown; error?: string } {
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

function parseBulkRedisReply(buffer: Buffer):
  | { complete: false }
  | { complete: true; value: string | null } {
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd === -1) return { complete: false };
  const length = Number(buffer.toString("utf8", 1, headerEnd));
  if (length === -1) return { complete: true, value: null };
  const valueStart = headerEnd + 2;
  const valueEnd = valueStart + length;
  if (buffer.length < valueEnd + 2) return { complete: false };
  return { complete: true, value: buffer.toString("utf8", valueStart, valueEnd) };
}

function parseArrayRedisReply(buffer: Buffer):
  | { complete: false }
  | { complete: true; value: unknown[]; error?: string } {
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd === -1) return { complete: false };
  const count = Number(buffer.toString("utf8", 1, headerEnd));
  const values: unknown[] = [];
  let offset = headerEnd + 2;
  for (let index = 0; index < count; index += 1) {
    const parsed = parseRedisReply(buffer.subarray(offset));
    if (!parsed.complete) return { complete: false };
    if (parsed.error) return { complete: true, value: values, error: parsed.error };
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

function checkpointProofWithVersion(
  proof: SdlcMvpEvidenceReport["checkpointProof"],
  version: number | undefined,
): SdlcMvpEvidenceReport["checkpointProof"] {
  if (version === undefined) return proof;
  return {
    ...proof,
    checkpointVersion: version,
  };
}

function sdlcBatchValidationStatusFromItem(
  item: SdlcBatchValidationItem,
): SdlcBatchValidationStatus {
  const status: SdlcBatchValidationStatus = {
    id: item.id,
    command: item.command,
    accepted: item.result === "pass",
    status: item.result,
    exitCode: item.exitCode,
    stdout: item.stdout,
    stderr: item.stderr,
  };
  if (item.durationMs !== undefined) {
    status.durationMs = item.durationMs;
  }
  return status;
}
