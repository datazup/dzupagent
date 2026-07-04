import type {
  FanoutBatchCompleteUpdate,
  FanoutBatchCreate,
  FanoutBatchItemUpdate,
  FanoutBatchRecord,
  FanoutBatchStore,
} from "../contracts/fanout-batch-store.js";

/**
 * In-process fan-out batch ledger. Durable hosts should provide their own
 * FanoutBatchStore implementation with the same contract.
 */
export class InMemoryFanoutBatchStore implements FanoutBatchStore {
  private readonly batches = new Map<string, FanoutBatchRecord>();

  async create(batch: FanoutBatchCreate): Promise<void> {
    const existing = this.batches.get(batch.batchId);
    if (existing !== undefined) {
      if (sameBatchIdentity(existing, batch)) return;
      throw new Error(`fanout batch "${batch.batchId}" already exists`);
    }

    this.batches.set(batch.batchId, {
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
  }

  async get(batchId: string): Promise<FanoutBatchRecord | null> {
    const found = this.batches.get(batchId);
    return found === undefined ? null : structuredClone(found);
  }

  async recordItem(
    batchId: string,
    itemKey: string,
    update: FanoutBatchItemUpdate,
  ): Promise<void> {
    const record = this.requireBatch(batchId);
    const index = record.items.findIndex((item) => item.key === itemKey);
    if (index === -1) {
      throw new Error(`fanout batch "${batchId}" has no item "${itemKey}"`);
    }

    const current = record.items[index]!;
    const next = { ...current, updatedAt: update.updatedAt };
    if (update.taskId !== undefined) next.taskId = update.taskId;
    if (update.status !== undefined) next.status = update.status;
    if (update.result !== undefined) next.result = structuredClone(update.result);
    if (update.resultTruncated !== undefined) {
      next.resultTruncated = update.resultTruncated;
    }
    if (update.error !== undefined) next.error = update.error;
    if (update.durationMs !== undefined) next.durationMs = update.durationMs;
    if (update.outputTokens !== undefined) next.outputTokens = update.outputTokens;

    record.items[index] = next;
    record.updatedAt = update.updatedAt;
  }

  async complete(
    batchId: string,
    update: FanoutBatchCompleteUpdate,
  ): Promise<void> {
    const record = this.requireBatch(batchId);
    record.status = update.status;
    record.completedAt = update.completedAt;
    record.wallClockMs = update.wallClockMs;
    if (update.outputTokensUsed !== undefined) {
      record.outputTokensUsed = update.outputTokensUsed;
    }
    record.updatedAt = update.completedAt;
    if (update.abortedReason !== undefined) {
      record.abortedReason = update.abortedReason;
    }
    if (update.budgetAborted !== undefined) {
      record.budgetAborted = update.budgetAborted;
    }
  }

  private requireBatch(batchId: string): FanoutBatchRecord {
    const found = this.batches.get(batchId);
    if (found === undefined) {
      throw new Error(`fanout batch "${batchId}" was not created`);
    }
    return found;
  }
}

function sameBatchIdentity(
  existing: FanoutBatchRecord,
  next: FanoutBatchCreate,
): boolean {
  return (
    existing.parentRunId === next.parentRunId &&
    existing.mode === next.mode &&
    existing.declared.length === next.declared.length &&
    existing.declared.every((key, index) => key === next.declared[index])
  );
}
