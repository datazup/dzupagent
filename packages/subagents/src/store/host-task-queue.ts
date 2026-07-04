import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskId } from "../contracts/background-task.js";
import { SubagentErrorCode } from "../contracts/error-codes.js";
import type { SubagentLogger } from "../contracts/logger.js";
import { defaultSubagentLogger } from "../contracts/logger.js";
import type { TaskQueue } from "../runner/durable-queue-runner.js";

export interface HostTaskQueueOptions {
  directory: string;
  workerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  clock?: () => number;
  autoDrain?: boolean;
  logger?: SubagentLogger;
}

interface QueueRecord {
  taskId: TaskId;
  enqueuedAt: number;
  availableAt: number;
  attempts: number;
  leasedBy?: string;
  leaseUntil?: number;
  lastClaimedAt?: number;
}

/**
 * Host-backed durable task queue. Records are persisted in a JSON queue file and
 * claimed under an atomic directory lock, which gives tests and simple hosts a
 * concrete queue seam without binding the package to Redis/Postgres/BullMQ.
 */
export class HostTaskQueue implements TaskQueue {
  private readonly directory: string;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  private readonly autoDrain: boolean;
  private readonly logger: SubagentLogger;
  private handler: ((taskId: TaskId) => Promise<void>) | undefined;
  private draining = false;
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: HostTaskQueueOptions) {
    this.directory = options.directory;
    this.workerId =
      options.workerId ??
      `worker-${process.pid}-${Math.random().toString(36).slice(2)}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.clock = options.clock ?? Date.now;
    this.autoDrain = options.autoDrain ?? true;
    this.logger = options.logger ?? defaultSubagentLogger;
  }

  async enqueue(taskId: TaskId): Promise<void> {
    await this.withLock(async () => {
      const records = await this.readRecords();
      if (records.some((record) => record.taskId === taskId)) return;
      const now = this.clock();
      records.push({
        taskId,
        enqueuedAt: now,
        availableAt: now,
        attempts: 0,
      });
      await this.writeRecords(records);
    });
    this.kick();
  }

  consume(handler: (taskId: TaskId) => Promise<void>): () => void {
    this.handler = handler;
    this.stopped = false;
    this.kick();
    return () => {
      this.stopped = true;
      this.handler = undefined;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
      }
    };
  }

  /** Deterministic drain hook for tests and hosts that schedule externally. */
  async drainAvailable(): Promise<void> {
    if (this.draining || !this.handler || this.stopped) return;
    this.draining = true;
    try {
      for (;;) {
        const record = await this.claimNext();
        if (!record || !this.handler || this.stopped) return;
        try {
          await this.handler(record.taskId);
          await this.ack(record.taskId, record.leasedBy);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error({
            taskId: record.taskId,
            code: SubagentErrorCode.TASK_EXECUTION_FAILED,
            message,
            detail: "host_queue_handler_threw",
          });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Claim and invoke one item without acknowledging it. This simulates a worker
   * that dies mid-handler and is intentionally test-only surface.
   */
  async claimNextForTest(): Promise<TaskId | null> {
    const record = await this.claimNext();
    if (!record) return null;
    await this.handler?.(record.taskId);
    return record.taskId;
  }

  async pendingCount(): Promise<number> {
    return this.withLock(async () => (await this.readRecords()).length);
  }

  private kick(): void {
    if (!this.autoDrain) return;
    void this.drainAvailable().finally(() => {
      if (this.stopped || !this.handler) return;
      if (this.pollTimer) return;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        this.kick();
      }, this.pollIntervalMs);
    });
  }

  private async claimNext(): Promise<
    (QueueRecord & { leasedBy: string }) | null
  > {
    return this.withLock(async () => {
      const records = await this.readRecords();
      const now = this.clock();
      const index = records.findIndex(
        (record) =>
          record.availableAt <= now &&
          (record.leaseUntil === undefined || record.leaseUntil <= now),
      );
      if (index === -1) return null;

      const current = records[index]!;
      const claimed: QueueRecord & { leasedBy: string } = {
        ...current,
        attempts: current.attempts + 1,
        leasedBy: this.workerId,
        leaseUntil: now + this.leaseMs,
        lastClaimedAt: now,
      };
      records[index] = claimed;
      await this.writeRecords(records);
      return claimed;
    });
  }

  private async ack(taskId: TaskId, leasedBy: string): Promise<void> {
    await this.withLock(async () => {
      const records = await this.readRecords();
      await this.writeRecords(
        records.filter(
          (record) =>
            record.taskId !== taskId ||
            (record.leasedBy !== undefined && record.leasedBy !== leasedBy),
        ),
      );
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockDir = join(this.directory, ".queue.lock");
    for (;;) {
      try {
        await mkdir(lockDir);
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await sleep(5);
      }
    }
    try {
      return await operation();
    } finally {
      await rmdir(lockDir);
    }
  }

  private async readRecords(): Promise<QueueRecord[]> {
    try {
      const parsed = JSON.parse(
        await readFile(this.queuePath(), "utf8"),
      ) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isQueueRecord);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeRecords(records: QueueRecord[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.queuePath();
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  private queuePath(): string {
    return join(this.directory, "queue.json");
  }
}

function isQueueRecord(value: unknown): value is QueueRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<QueueRecord>;
  return (
    typeof record.taskId === "string" &&
    typeof record.enqueuedAt === "number" &&
    typeof record.availableAt === "number" &&
    typeof record.attempts === "number"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
