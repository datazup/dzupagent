import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FanoutBatchCompleteUpdate,
  FanoutBatchCreate,
  FanoutBatchItemUpdate,
  FanoutBatchRecord,
  FanoutBatchStore,
} from "../contracts/fanout-batch-store.js";
import type { FanoutReport } from "../tools/fanout-tool.js";
import { fanoutBatchRecordToReport } from "../tools/fanout-tool.js";

export interface HostFanoutBatchStoreOptions {
  directory: string;
}

/**
 * Host-backed fan-out batch ledger. Records are persisted as one JSON file per
 * batch so a replacement coordinator can reconstruct or resume by batchId.
 */
export class HostFanoutBatchStore implements FanoutBatchStore {
  private readonly directory: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: HostFanoutBatchStoreOptions) {
    this.directory = options.directory;
  }

  async create(batch: FanoutBatchCreate): Promise<void> {
    await this.mutate(async () => {
      const existing = await this.read(batch.batchId);
      if (existing !== null) {
        if (sameBatchIdentity(existing, batch)) return;
        throw new Error(`fanout batch "${batch.batchId}" already exists`);
      }

      await this.write({
        batchId: batch.batchId,
        parentRunId: batch.parentRunId,
        mode: batch.mode,
        status: "running",
        declared: [...batch.declared],
        items: batch.declared.map((key) => ({
          key,
          status: "never_dispatched",
          updatedAt: batch.startedAt,
        })),
        startedAt: batch.startedAt,
        updatedAt: batch.startedAt,
      });
    });
  }

  async get(batchId: string): Promise<FanoutBatchRecord | null> {
    const found = await this.read(batchId);
    return found === null ? null : structuredClone(found);
  }

  async recordItem(
    batchId: string,
    itemKey: string,
    update: FanoutBatchItemUpdate
  ): Promise<void> {
    await this.mutate(async () => {
      const record = await this.requireBatch(batchId);
      const index = record.items.findIndex((item) => item.key === itemKey);
      if (index === -1) {
        throw new Error(`fanout batch "${batchId}" has no item "${itemKey}"`);
      }

      const current = record.items[index]!;
      const next = { ...current, updatedAt: update.updatedAt };
      if (update.taskId !== undefined) next.taskId = update.taskId;
      if (update.status !== undefined) next.status = update.status;
      if (update.result !== undefined) {
        next.result = structuredClone(update.result);
      }
      if (update.resultTruncated !== undefined) {
        next.resultTruncated = update.resultTruncated;
      }
      if (update.provider !== undefined) next.provider = update.provider;
      if (update.error !== undefined) next.error = update.error;
      if (update.durationMs !== undefined) next.durationMs = update.durationMs;
      if (update.outputTokens !== undefined) {
        next.outputTokens = update.outputTokens;
      }
      if (update.costUsd !== undefined) next.costUsd = update.costUsd;

      record.items[index] = next;
      record.updatedAt = update.updatedAt;
      await this.write(record);
    });
  }

  async complete(
    batchId: string,
    update: FanoutBatchCompleteUpdate
  ): Promise<void> {
    await this.mutate(async () => {
      const record = await this.requireBatch(batchId);
      record.status = update.status;
      record.completedAt = update.completedAt;
      record.wallClockMs = update.wallClockMs;
      if (update.outputTokensUsed !== undefined) {
        record.outputTokensUsed = update.outputTokensUsed;
      }
      if (update.budgetUsdReserved !== undefined) {
        record.budgetUsdReserved = update.budgetUsdReserved;
      }
      if (update.budgetUsdActual !== undefined) {
        record.budgetUsdActual = update.budgetUsdActual;
      }
      record.updatedAt = update.completedAt;
      if (update.abortedReason !== undefined) {
        record.abortedReason = update.abortedReason;
      }
      if (update.budgetAborted !== undefined) {
        record.budgetAborted = update.budgetAborted;
      }
      await this.write(record);
    });
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    await next;
  }

  private async requireBatch(batchId: string): Promise<FanoutBatchRecord> {
    const found = await this.read(batchId);
    if (found === null) {
      throw new Error(`fanout batch "${batchId}" was not created`);
    }
    return found;
  }

  private async read(batchId: string): Promise<FanoutBatchRecord | null> {
    try {
      const payload = await readFile(this.pathFor(batchId), "utf8");
      return JSON.parse(payload) as FanoutBatchRecord;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async write(record: FanoutBatchRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(record.batchId);
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  private pathFor(batchId: string): string {
    return join(
      this.directory,
      `${Buffer.from(batchId).toString("base64url")}.json`
    );
  }
}

export async function recoverFanoutReport(
  store: FanoutBatchStore,
  batchId: string
): Promise<FanoutReport | null> {
  const record = await store.get(batchId);
  return record === null ? null : fanoutBatchRecordToReport(record);
}

function sameBatchIdentity(
  existing: FanoutBatchRecord,
  next: FanoutBatchCreate
): boolean {
  return (
    existing.parentRunId === next.parentRunId &&
    existing.mode === next.mode &&
    existing.declared.length === next.declared.length &&
    existing.declared.every((key, index) => key === next.declared[index])
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
