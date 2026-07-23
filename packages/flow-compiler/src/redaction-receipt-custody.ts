import {
  validateFlowRedactionResult,
  type FlowRedactionResult,
  type FlowSha256Digest,
} from "@dzupagent/flow-ast";

import {
  canonicalizeFlowSecurityJson,
  deepFreezeJson,
  digestFlowRedactionReceiptPayload,
  digestFlowSecurityJson,
  verifyFlowRedactionReceiptAttestation,
  type FlowRedactionReceiptPublicKeyResolver,
} from "./redaction-receipt-crypto.js";

export const FLOW_REDACTION_TERMINAL_RECORD_SCHEMA =
  "dzupagent.flowRedactionTerminalRecord/v1" as const;

export interface FlowRedactionTerminalRecord<T = unknown> {
  readonly schema: typeof FLOW_REDACTION_TERMINAL_RECORD_SCHEMA;
  readonly operationId: string;
  readonly terminalDigest: FlowSha256Digest;
  readonly committedAt: string;
  readonly result: FlowRedactionResult<T>;
}

export type FlowRedactionReceiptCustodyPut<T = unknown> =
  | { readonly status: "stored" }
  | {
      readonly status: "exists";
      readonly record: FlowRedactionTerminalRecord<T>;
    };

/**
 * Durable implementations must make `putIfAbsent` atomic on operationId.
 * The result contains the classified output and receipt as one write unit.
 */
export interface FlowRedactionReceiptCustodyStore<T = unknown> {
  putIfAbsent(
    record: FlowRedactionTerminalRecord<T>,
  ): Promise<FlowRedactionReceiptCustodyPut<T>>;
}

export type FlowRedactionReceiptCustodyCommit<T = unknown> =
  | {
      readonly status: "stored" | "duplicate";
      readonly record: FlowRedactionTerminalRecord<T>;
    }
  | {
      readonly status: "conflict";
      readonly existing: FlowRedactionTerminalRecord<T>;
      readonly attemptedTerminalDigest: FlowSha256Digest;
    }
  | {
      readonly status: "rejected";
      readonly issues: readonly string[];
    };

export interface CommitFlowRedactionResultRequest<T = unknown> {
  readonly result: FlowRedactionResult<T>;
  readonly store: FlowRedactionReceiptCustodyStore<T>;
  readonly resolvePublicKey: FlowRedactionReceiptPublicKeyResolver;
  readonly committedAt?: string;
}

/**
 * Verify structure, output digest, and Ed25519 authority before atomically
 * committing the first terminal result for an operation.
 */
export async function commitFlowRedactionResult<T>(
  request: CommitFlowRedactionResultRequest<T>,
): Promise<FlowRedactionReceiptCustodyCommit<T>> {
  const issues: string[] = [];
  const structural = validateFlowRedactionResult(request.result);
  issues.push(...structural.issues);
  const attestation = await verifyFlowRedactionReceiptAttestation(
    request.result.receipt,
    request.resolvePublicKey,
  );
  issues.push(...attestation.issues);
  if (request.result.status === "applied") {
    try {
      const actualDigest = digestFlowSecurityJson(request.result.output.value);
      if (actualDigest !== request.result.output.digest) {
        issues.push("result output digest does not match output value");
      }
    } catch {
      issues.push("result output value must be canonical JSON");
    }
  }
  const committedAt = request.committedAt ?? new Date().toISOString();
  if (!canonicalTimestamp(committedAt)) {
    issues.push("committedAt must be a canonical UTC timestamp");
  }
  if (issues.length > 0) {
    return Object.freeze({
      status: "rejected",
      issues: Object.freeze([...new Set(issues)]),
    });
  }
  const terminalDigest = digestTerminalResult(request.result);
  const record = deepFreezeJson({
    schema: FLOW_REDACTION_TERMINAL_RECORD_SCHEMA,
    operationId: request.result.receipt.operationId,
    terminalDigest,
    committedAt,
    result: cloneJson(request.result),
  }) as FlowRedactionTerminalRecord<T>;
  const stored = await request.store.putIfAbsent(record);
  if (stored.status === "stored") {
    return Object.freeze({ status: "stored", record });
  }
  if (stored.record.terminalDigest === terminalDigest) {
    return Object.freeze({ status: "duplicate", record: stored.record });
  }
  return Object.freeze({
    status: "conflict",
    existing: stored.record,
    attemptedTerminalDigest: terminalDigest,
  });
}

/** Provider-free reference store for qualification; not a durable backend. */
export class InMemoryFlowRedactionReceiptCustodyStore<T = unknown>
  implements FlowRedactionReceiptCustodyStore<T>
{
  readonly #records = new Map<string, FlowRedactionTerminalRecord<T>>();

  async putIfAbsent(
    record: FlowRedactionTerminalRecord<T>,
  ): Promise<FlowRedactionReceiptCustodyPut<T>> {
    const existing = this.#records.get(record.operationId);
    if (existing !== undefined) {
      return Object.freeze({ status: "exists", record: existing });
    }
    this.#records.set(record.operationId, record);
    return Object.freeze({ status: "stored" });
  }

  get(operationId: string): FlowRedactionTerminalRecord<T> | undefined {
    return this.#records.get(operationId);
  }
}

function digestTerminalResult<T>(
  result: FlowRedactionResult<T>,
): FlowSha256Digest {
  return digestFlowSecurityJson({
    receiptPayloadDigest: digestFlowRedactionReceiptPayload(result.receipt),
    receiptSignature: result.receipt.attestation.signature,
    status: result.status,
    ...(result.status === "applied"
      ? {
          output: {
            classification: result.output.classification,
            digest: result.output.digest,
          },
        }
      : {}),
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalizeFlowSecurityJson(value)) as T;
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
