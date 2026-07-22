import type { SubagentSpec } from "../../contracts/background-task.js";
import type { FanoutItem } from "./types.js";

/**
 * Pure, dependency-light helpers for the `fanout_template` coordinator:
 * placeholder substitution, byte-accurate result capping, budget rounding, and
 * per-item budget-hint extraction. Kept side-effect free (except the shared
 * `batchCounter` used by the default batch-id generator).
 */

let batchCounter = 0;

/** Monotonic counter backing the default `fanout-<clock>-<n>` batch-id generator. */
export function nextBatchCounter(): number {
  batchCounter += 1;
  return batchCounter;
}

/** Substitute `{{key}}` / `{{input}}` placeholders in an instruction template. */
export function substitutePlaceholders(
  template: string,
  item: FanoutItem
): string {
  const inputText =
    typeof item.input === "string" ? item.input : JSON.stringify(item.input);
  return template
    .replaceAll("{{key}}", item.key)
    .replaceAll("{{input}}", inputText);
}

/**
 * Truncate an item result to the per-item byte cap. The `taskId` stays in the
 * report so a supervisor can `check_subagent` for the full output.
 */
export function capResult(
  output: unknown,
  maxResultBytes: number
): { result?: unknown; resultTruncated?: boolean } {
  if (output === undefined) {
    return {};
  }
  const serialized =
    typeof output === "string" ? output : JSON.stringify(output);
  if (serialized === undefined) {
    return {};
  }
  if (Buffer.byteLength(serialized, "utf8") <= maxResultBytes) {
    return { result: output };
  }
  // Byte-accurate truncation; a split multi-byte tail is dropped by decode.
  const truncated = Buffer.from(serialized, "utf8")
    .subarray(0, maxResultBytes)
    .toString("utf8");
  return { result: truncated, resultTruncated: true };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Round a USD figure to 6 decimal places to avoid float drift in aggregates. */
export function roundBudgetUsd(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

/** Per-item budget hint carried by the (possibly resolved) template definition. */
export function templateBudgetHints(template: SubagentSpec): {
  perItemBudgetUsd?: number;
  estimatedCostUsd?: number;
} {
  const constraints = (template.resolvedDefinition ?? template.definition)
    ?.constraints;
  return {
    ...(constraints?.maxBudgetUsd !== undefined
      ? { perItemBudgetUsd: constraints.maxBudgetUsd }
      : {}),
    ...(constraints?.estimatedCostUsd !== undefined
      ? { estimatedCostUsd: constraints.estimatedCostUsd }
      : {}),
  };
}
