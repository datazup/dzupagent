import {
  canonicalInputDigest,
  validatePipelineInteractionResumeV1,
  validatePipelineInteractionSpecV1,
  validatePipelinePendingInteractionV1,
  type PipelineInteractionRecordV1,
  type PipelineInteractionResumeV1,
  type PipelineInteractionSpecV1,
  type PipelineInteractionStatePortV1,
  type PipelinePendingInteractionV1,
} from "@dzupagent/runtime-contracts";

export type PipelineInteractionStoreErrorCode =
  | "INVALID_INTERACTION"
  | "PENDING_PAYLOAD_DRIFT"
  | "UNKNOWN_INTERACTION"
  | "INTERACTION_EXPIRED"
  | "TERMINAL_RECEIPT_CONFLICT";

export class PipelineInteractionStoreError extends Error {
  constructor(
    readonly code: PipelineInteractionStoreErrorCode,
    readonly interactionId: string,
    message: string,
  ) {
    super(message);
    this.name = "PipelineInteractionStoreError";
  }
}

export interface InMemoryPipelineInteractionStatePortOptions {
  now?: () => Date;
}

/** Provider-free single-process adapter implementing the canonical protocol. */
export class InMemoryPipelineInteractionStatePort
  implements PipelineInteractionStatePortV1
{
  private readonly records = new Map<string, PipelineInteractionRecordV1>();
  private readonly now: () => Date;

  constructor(options: InMemoryPipelineInteractionStatePortOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async ensurePending(
    spec: PipelineInteractionSpecV1,
    pending: PipelinePendingInteractionV1,
  ): Promise<PipelineInteractionRecordV1> {
    const specResult = validatePipelineInteractionSpecV1(spec);
    const pendingResult = validatePipelinePendingInteractionV1(pending);
    if (
      !specResult.valid ||
      !pendingResult.valid ||
      spec.kind !== pending.kind ||
      spec.requestDigest !== pending.requestDigest
    ) {
      throw new PipelineInteractionStoreError(
        "INVALID_INTERACTION",
        pending.interactionId,
        "Pending interaction does not match a valid authored request.",
      );
    }

    const existing = this.records.get(pending.interactionId);
    if (existing !== undefined) {
      if (
        canonicalInputDigest(existing.spec) !== canonicalInputDigest(spec) ||
        canonicalInputDigest(existing.pending) !== canonicalInputDigest(pending)
      ) {
        throw new PipelineInteractionStoreError(
          "PENDING_PAYLOAD_DRIFT",
          pending.interactionId,
          "An interaction with the same ID has different pending payload.",
        );
      }
      return cloneRecord(existing);
    }

    const record = structuredClone({ spec, pending }) satisfies PipelineInteractionRecordV1;
    this.records.set(pending.interactionId, record);
    return cloneRecord(record);
  }

  async recordReceipt(
    receipt: PipelineInteractionResumeV1,
  ): Promise<PipelineInteractionRecordV1> {
    const existing = this.records.get(receipt.interactionId);
    if (existing === undefined) {
      throw new PipelineInteractionStoreError(
        "UNKNOWN_INTERACTION",
        receipt.interactionId,
        "No pending interaction exists for this receipt.",
      );
    }
    const validation = validatePipelineInteractionResumeV1(receipt, {
      spec: existing.spec,
      pending: existing.pending,
    });
    if (!validation.valid) {
      throw new PipelineInteractionStoreError(
        "INVALID_INTERACTION",
        receipt.interactionId,
        "Receipt does not match the pending interaction.",
      );
    }
    if (existing.receipt !== undefined) {
      if (existing.receipt.receiptHash === receipt.receiptHash) {
        return cloneRecord(existing);
      }
      throw new PipelineInteractionStoreError(
        "TERMINAL_RECEIPT_CONFLICT",
        receipt.interactionId,
        "A different terminal receipt is already committed.",
      );
    }
    if (this.now().getTime() >= Date.parse(existing.pending.expiresAt)) {
      throw new PipelineInteractionStoreError(
        "INTERACTION_EXPIRED",
        receipt.interactionId,
        "The pending interaction has expired.",
      );
    }
    const terminal = structuredClone({
      ...existing,
      receipt,
    }) satisfies PipelineInteractionRecordV1;
    this.records.set(receipt.interactionId, terminal);
    return cloneRecord(terminal);
  }

  async get(interactionId: string): Promise<PipelineInteractionRecordV1 | null> {
    const record = this.records.get(interactionId);
    return record === undefined ? null : cloneRecord(record);
  }
}

function cloneRecord(
  record: PipelineInteractionRecordV1,
): PipelineInteractionRecordV1 {
  return structuredClone(record);
}
