/**
 * Final-turn outcome for one run of the Codex CLI adapter (IPC-FINAL-TURN-20261116-R1).
 *
 * One pure function classifies the ordered events the adapter yielded
 * (normalized events and `adapter:provider_raw` events). It reads no file and
 * no clock, and it does not change its input.
 *
 * The steps run in a fixed order:
 *   qualification -> terminal event -> final turn -> result candidate
 *   -> structured result -> completed
 *
 * `refused` and `truncated` are declared outcome names, but nothing on this
 * surface identifies them, so the function never returns them: no outcome is
 * inferred from the wording of a message or from a parse failure. Which
 * message is the final answer is unqualified as well, so on the shipped
 * qualification table a call that expects a structured result is refused.
 *
 * The object is not validated against the schema here.
 */
import { canonicalDigestPrefixed } from "@dzupagent/canonical-json";

import {
  schemaSubsetViolation,
  type ManagedPreparationManifest,
} from "../prompts/managed-preparation.js";
import type { AgentStreamEvent, TokenUsage } from "../types.js";
import { getString } from "../utils/event-record.js";

export const CODEX_FINAL_TURN_OUTCOMES = ["completed", "refused", "truncated", "interrupted", "failed"] as const;
export type CodexFinalTurnOutcomeName = (typeof CODEX_FINAL_TURN_OUTCOMES)[number];

export type CodexFinalTurnSupport = "supported" | "unqualified";

/** What the surface is qualified to tell apart. `finalAnswer` is the final-message attribution rule. */
export interface CodexFinalTurnQualification {
  readonly refused: CodexFinalTurnSupport;
  readonly truncated: CodexFinalTurnSupport;
  readonly finalAnswer: CodexFinalTurnSupport;
}

/** The shipped table. No recording of a Codex run backs any of the three, so none is qualified. */
export const CODEX_CLI_FINAL_TURN_QUALIFICATION: CodexFinalTurnQualification = Object.freeze({
  refused: "unqualified",
  truncated: "unqualified",
  finalAnswer: "unqualified",
});

/** Given when a structured result is expected: the manifest holds a schema digest. A null digest expects none. */
export interface CodexFinalTurnExpectation {
  manifest: ManagedPreparationManifest;
  /** The exact text of the file the adapter passed with `--output-schema`. */
  schemaText?: string;
  /** The runtime the host observed for the run. */
  observed?: { connectorVersion: string | null; modelId: string };
}

export interface CodexFinalTurnInput {
  events: readonly AgentStreamEvent[];
  expected?: CodexFinalTurnExpectation;
}

export type CodexFinalTurnMismatchField =
  | "finalAnswer"
  | "target"
  | "observed"
  | "connectorVersion"
  | "modelId"
  | "startedModel"
  | "schemaText"
  | "outputSchemaSha256"
  | "schemaSubset";

export type CodexFinalTurnFailureReason =
  | "terminal_missing"
  | "adapter_failed"
  | "result_missing"
  | "result_unattributed"
  | "result_invalid"
  | "result_conflict";

/** Positions in the input of the events that decided. */
export interface CodexFinalTurnPositions {
  /** The deciding terminal event, or null when the stream has none. */
  terminal: number | null;
  /** The first event of the final turn. */
  turnStart: number;
  /** The event the result candidate was read from, or null. */
  result: number | null;
}

export type CodexFinalTurnClassification =
  | { kind: "refusal"; code: "qualification_mismatch"; field: CodexFinalTurnMismatchField; pointer?: string }
  | {
      kind: "outcome";
      outcome: "completed";
      result: Record<string, unknown> | null;
      resultSource: "native" | "final_message" | null;
      usage: TokenUsage | null;
      positions: CodexFinalTurnPositions;
    }
  | { kind: "outcome"; outcome: "interrupted"; reason: "aborted" | "timeout"; code: string | null; positions: CodexFinalTurnPositions }
  | { kind: "outcome"; outcome: "failed"; reason: CodexFinalTurnFailureReason; code: string | null; positions: CodexFinalTurnPositions };

/** The preset the manifest of managed preparation hashes its schema with. */
const PRESET = "adapter-digest-v1";
/** The raw record types the normalizer maps to `adapter:completed`. */
const RAW_COMPLETED = new Set(["turn.completed", "turn_completed", "run_completed", "thread.completed"]);
const FINAL_MARKERS = new Set<unknown>(["final_answer", "final"]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The payload of a raw event, or null for any other event. */
function rawPayload(event: AgentStreamEvent | undefined): Record<string, unknown> | null {
  if (event?.type !== "adapter:provider_raw") return null;
  const payload: unknown = event.rawEvent?.payload;
  return record(payload) ? payload : null;
}

const terminal = (event: AgentStreamEvent | undefined): boolean =>
  event?.type === "adapter:completed" || event?.type === "adapter:failed" || event?.type === "recovery:cancelled";

/** A `phase` or `channel` field with any value other than a final-answer value marks commentary. */
function commentary(value: unknown): boolean {
  if (!record(value)) return false;
  return ["phase", "channel"].some(key => value[key] !== undefined && !FINAL_MARKERS.has(value[key]));
}

/** The whole text must be one JSON object: prose, a code fence, a second object or an array is not one. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

function qualificationMismatch(
  events: readonly AgentStreamEvent[],
  expected: CodexFinalTurnExpectation,
  qualification: CodexFinalTurnQualification,
): CodexFinalTurnClassification | null {
  const mismatch = (field: CodexFinalTurnMismatchField, pointer?: string): CodexFinalTurnClassification =>
    ({ kind: "refusal", code: "qualification_mismatch", field, ...(pointer === undefined ? {} : { pointer }) });

  if (!record(qualification) || qualification.finalAnswer !== "supported") return mismatch("finalAnswer");

  const manifest: unknown = expected.manifest;
  const target: unknown = record(manifest) ? manifest["target"] : undefined;
  if (!record(target) || target.providerId !== "codex" || target.route !== "codex-cli"
    || typeof target.modelId !== "string" || target.modelId.length === 0
    || !(target.connectorVersion === null || typeof target.connectorVersion === "string")) return mismatch("target");

  const observed: unknown = expected.observed;
  if (!record(observed)) return mismatch("observed");
  if (observed.connectorVersion !== target.connectorVersion) return mismatch("connectorVersion");
  if (observed.modelId !== target.modelId) return mismatch("modelId");

  for (const event of events) {
    if (event?.type === "adapter:started" && event.model !== undefined && event.model !== target.modelId) {
      return mismatch("startedModel");
    }
  }

  if (typeof expected.schemaText !== "string") return mismatch("schemaText");
  let schema: unknown;
  try {
    schema = JSON.parse(expected.schemaText);
  } catch {
    return mismatch("schemaText");
  }
  let schemaSha256: string | null;
  try {
    schemaSha256 = canonicalDigestPrefixed(schema, PRESET);
  } catch {
    schemaSha256 = null;
  }
  if (schemaSha256 === null || !record(manifest) || schemaSha256 !== manifest["outputSchemaSha256"]) return mismatch("outputSchemaSha256");

  const violation = schemaSubsetViolation(schema, "", 1, { properties: 0 });
  return violation === null ? null : mismatch("schemaSubset", violation);
}

export function classifyCodexFinalTurn(
  input: CodexFinalTurnInput,
  qualification: CodexFinalTurnQualification = CODEX_CLI_FINAL_TURN_QUALIFICATION,
): CodexFinalTurnClassification {
  const events = input.events;
  const expected = input.expected;
  // Only a manifest that says "no schema" (a null digest) turns the expectation off; anything else is checked.
  const manifest: unknown = expected?.manifest;
  const schemaExpected = expected !== undefined && !(record(manifest) && manifest["outputSchemaSha256"] === null);

  // 1. Qualification first. A refusal here is not one of the outcomes.
  if (expected !== undefined && schemaExpected) {
    const refusal = qualificationMismatch(events, expected, qualification);
    if (refusal) return refusal;
  }

  // 2. The last terminal event decides.
  let terminalIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (terminal(events[index])) {
      terminalIndex = index;
      break;
    }
  }
  if (terminalIndex === -1) {
    return { kind: "outcome", outcome: "failed", reason: "terminal_missing", code: null, positions: { terminal: null, turnStart: 0, result: null } };
  }

  // 3. The final turn starts after the previous terminal event or the last raw `turn.started`, whichever is later.
  let turnStart = 0;
  for (let index = terminalIndex - 1; index >= 0; index -= 1) {
    if (terminal(events[index]) || rawPayload(events[index])?.["type"] === "turn.started") {
      turnStart = index + 1;
      break;
    }
  }
  const positions = (result: number | null): CodexFinalTurnPositions => ({ terminal: terminalIndex, turnStart, result });
  const failed = (reason: CodexFinalTurnFailureReason, result: number | null, code: string | null = null): CodexFinalTurnClassification =>
    ({ kind: "outcome", outcome: "failed", reason, code, positions: positions(result) });

  const decided = events[terminalIndex];
  if (decided?.type === "recovery:cancelled") {
    return { kind: "outcome", outcome: "interrupted", reason: "aborted", code: null, positions: positions(null) };
  }
  if (decided?.type === "adapter:failed") {
    const code = typeof decided.code === "string" ? decided.code : null;
    if (code === "AGENT_ABORTED") return { kind: "outcome", outcome: "interrupted", reason: "aborted", code, positions: positions(null) };
    if (code === "ADAPTER_TIMEOUT") return { kind: "outcome", outcome: "interrupted", reason: "timeout", code, positions: positions(null) };
    return failed("adapter_failed", null, code);
  }
  if (decided?.type !== "adapter:completed") return failed("terminal_missing", null);

  const completed = (
    result: Record<string, unknown> | null,
    resultSource: "native" | "final_message" | null,
    resultIndex: number | null,
  ): CodexFinalTurnClassification => ({
    kind: "outcome",
    outcome: "completed",
    result,
    resultSource,
    usage: decided.usage ?? null,
    positions: positions(resultIndex),
  });
  if (!schemaExpected) return completed(null, null, null);

  // 4. Result candidate. The raw terminal record is the raw event directly before the deciding event.
  const rawTerminalIndex = terminalIndex - 1;
  const rawTerminal = rawTerminalIndex >= turnStart ? rawPayload(events[rawTerminalIndex]) : null;
  const terminalRecord = rawTerminal && RAW_COMPLETED.has(String(rawTerminal["type"])) ? rawTerminal : null;
  // The keys and the empty-string rule are the normalizer's and the adapter's: an empty string is no result.
  const native = terminalRecord ? getString(terminalRecord, "result", "final_text", "text") : undefined;

  let messageIndex = -1;
  for (let index = terminalIndex - 1; index >= turnStart; index -= 1) {
    const event = events[index];
    if (event?.type === "adapter:message" && event.role === "assistant") {
      messageIndex = index;
      break;
    }
  }
  const message = events[messageIndex];
  const messageText = message?.type === "adapter:message" ? message.content : null;

  if (native) {
    // 5. The native result is the only candidate, whatever any message says.
    const parsed = parseObject(native);
    if (!parsed) return failed("result_invalid", rawTerminalIndex);
    if (messageText !== null && messageText !== native) return failed("result_conflict", rawTerminalIndex);
    return completed(parsed, "native", rawTerminalIndex);
  }
  if (messageText === null) return failed("result_missing", null);

  // The message counts only with its own raw record directly before it ...
  const itemRecord = messageIndex - 1 >= turnStart ? rawPayload(events[messageIndex - 1]) : null;
  const item = itemRecord?.["type"] === "item.completed" && record(itemRecord["item"]) ? itemRecord["item"] : null;
  let attributed = item !== null && item["type"] === "agent_message"
    && (getString(item, "text", "content") ?? "") === messageText
    && !commentary(itemRecord) && !commentary(item);
  // ... with nothing after it but the raw terminal record. Every other raw record inside a turn is an item record.
  for (let index = messageIndex + 1; attributed && index < terminalIndex; index += 1) {
    const event = events[index];
    if (event?.type === "adapter:tool_call" || event?.type === "adapter:tool_result" || event?.type === "adapter:message") attributed = false;
    if (event?.type === "adapter:provider_raw" && !(index === rawTerminalIndex && terminalRecord !== null)) attributed = false;
  }
  // ... and with no stream delta of the turn marked as commentary.
  for (let index = turnStart; attributed && index < terminalIndex; index += 1) {
    const event = events[index];
    if (event?.type === "adapter:stream_delta" && commentary(event)) attributed = false;
  }
  if (!attributed) return failed("result_unattributed", messageIndex);

  // 5. Structured result.
  const parsed = parseObject(messageText);
  if (!parsed) return failed("result_invalid", messageIndex);
  // 6. Completed.
  return completed(parsed, "final_message", messageIndex);
}
