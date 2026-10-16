/**
 * Durable per-item aggregate receipt for the `for_each` loop executor.
 *
 * Split out of `for-each-loop.ts` (DZUPAGENT-CODE-H-11). The receipt is the
 * only evidence a resumed loop accepts to restore a completed item without
 * dispatching its body again.
 *
 * @module pipeline/loop-executor/for-each-aggregate-receipt
 */

import type { LoopNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import type { NodeResult } from "../pipeline-runtime-types.js";
import { resolveStatePath } from "./state-path.js";

export type ForEachContract = NonNullable<LoopNode["forEach"]>;

const FOR_EACH_AGGREGATE_RECEIPT_V1 =
  "dzupagent/for-each-aggregate-receipt/v1" as const;

export interface ForEachKnownValue {
  readonly status: "known";
  readonly value?: unknown;
}

export interface ForEachAggregateReceiptV1 {
  readonly schema: typeof FOR_EACH_AGGREGATE_RECEIPT_V1;
  readonly loopNodeId: string;
  readonly itemIndex: number;
  readonly itemValue: ForEachKnownValue;
  readonly collectedValue?: ForEachKnownValue;
  readonly finalBodyResult: {
    readonly nodeId: string;
    readonly output: ForEachKnownValue;
  };
}

/**
 * The loop node cannot be one of its own admitted leaf body nodes, so its id is
 * a collision-free slot in the durable `bodyResults` record. Keeping the
 * receipt inside that already-serialized record avoids widening the core
 * checkpoint schema while the checkpoint's root definition digest, loop id,
 * source digest and item-index key bind the receipt to its definition.
 */
export function aggregateReceiptResult(
  loopNodeId: string,
  itemIndex: number,
  itemValue: unknown,
  collectedValue: ForEachKnownValue | undefined,
  finalBodyResult: NodeResult
): NodeResult {
  const receipt: ForEachAggregateReceiptV1 = {
    schema: FOR_EACH_AGGREGATE_RECEIPT_V1,
    loopNodeId,
    itemIndex,
    itemValue: { status: "known", value: itemValue },
    ...(collectedValue === undefined ? {} : { collectedValue }),
    finalBodyResult: {
      nodeId: finalBodyResult.nodeId,
      output: { status: "known", value: finalBodyResult.output },
    },
  };
  return { nodeId: loopNodeId, output: receipt, durationMs: 0 };
}

export function readAggregateReceipt(
  loopNodeId: string,
  itemIndex: number,
  itemValue: unknown,
  bodyResults: Readonly<Record<string, NodeResult>> | undefined
): ForEachAggregateReceiptV1 | undefined {
  const receiptResult = bodyResults?.[loopNodeId];
  if (receiptResult?.nodeId !== loopNodeId) return undefined;
  const candidate = receiptResult.output;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Partial<ForEachAggregateReceiptV1>;
  const collected = record.collectedValue;
  const final = record.finalBodyResult;
  if (
    record.schema !== FOR_EACH_AGGREGATE_RECEIPT_V1 ||
    record.loopNodeId !== loopNodeId ||
    record.itemIndex !== itemIndex ||
    record.itemValue?.status !== "known" ||
    (collected !== undefined && collected.status !== "known") ||
    typeof final !== "object" ||
    final === null ||
    typeof final.nodeId !== "string" ||
    final.nodeId.length === 0 ||
    typeof final.output !== "object" ||
    final.output === null ||
    final.output.status !== "known"
  ) {
    return undefined;
  }
  try {
    if (
      canonicalInputDigest(record.itemValue.value) !==
      canonicalInputDigest(itemValue)
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return record as ForEachAggregateReceiptV1;
}

export function collectIterationValue(
  state: Record<string, unknown>,
  previousResults: Map<string, NodeResult>,
  from: string
): unknown {
  const resolved = resolveStatePath(state, from);
  if (resolved.found) return resolved.value;
  return previousResults.get(from)?.output;
}
