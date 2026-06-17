import type { TracePort } from "../ports/trace-port.js";
import type {
  AgentRunInput,
  AgentRunRequest,
} from "../types/agent-run-request.js";
import type { RedactedEvents, RedactionPolicy } from "../types/redaction-policy.js";
import type {
  DialogueMode,
  ParticipantSpec,
  RunSpecHash,
} from "../types/run-spec.js";
import type {
  DecisionBlock,
  RawTurnEvent,
  TurnEventStatus,
  TurnEventValidation,
  TurnEventWorkspace,
} from "../types/turn-event.js";
import type { TurnVerb } from "../types/turn-verb.js";

export interface BuildAgentRunRequestInput {
  runId: string;
  runSpecHash: RunSpecHash;
  turnIndex: number;
  turnType: TurnVerb;
  mode: DialogueMode;
  participant: ParticipantSpec;
  prompt?: string | undefined;
  escape: boolean;
}

export interface BuildRawTurnEventInput {
  runId: string;
  runSpecHash: RunSpecHash;
  turnIndex: number;
  turnType: TurnVerb;
  mode: DialogueMode;
  startedAt: string;
  ms: number;
  escape: boolean;
  status: TurnEventStatus;
  participant?: ParticipantSpec | undefined;
  input?: AgentRunInput | undefined;
  output?: RawTurnEvent["output"] | undefined;
  workspace?: TurnEventWorkspace | undefined;
  validation?: TurnEventValidation | undefined;
  decision?: DecisionBlock | undefined;
  skipReason?: string | undefined;
}

export function buildAgentRunRequest(
  input: BuildAgentRunRequestInput,
): AgentRunRequest {
  const agentInput: AgentRunInput = {
    prompt: input.prompt ?? "",
    ...(input.participant.role !== undefined
      ? { role: input.participant.role }
      : {}),
    ...(input.participant.systemPrompt !== undefined
      ? { systemPrompt: input.participant.systemPrompt }
      : {}),
  };

  return {
    runId: input.runId,
    runSpecHash: input.runSpecHash,
    turnIndex: input.turnIndex,
    turnType: input.turnType,
    participantId: input.participant.id,
    provider: input.participant.provider,
    model: input.participant.model,
    mode: input.mode,
    input: agentInput,
    escape: input.escape,
  };
}

export function buildRawTurnEvent(input: BuildRawTurnEventInput): RawTurnEvent {
  return {
    runId: input.runId,
    runSpecHash: input.runSpecHash,
    turnIndex: input.turnIndex,
    turnType: input.turnType,
    ...(input.participant !== undefined
      ? {
          participantId: input.participant.id,
          provider: input.participant.provider,
          model: input.participant.model,
        }
      : {}),
    mode: input.mode,
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    ...(input.validation !== undefined ? { validation: input.validation } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    timing: {
      startedAt: input.startedAt,
      ms: input.ms,
    },
    escape: input.escape,
    status: input.status,
    ...(input.skipReason !== undefined ? { skipReason: input.skipReason } : {}),
    visibility: "raw",
  };
}

export async function redactAndEmitTurnEvent(
  tracePort: TracePort,
  redactionPolicy: RedactionPolicy,
  rawEvent: RawTurnEvent,
): Promise<RedactedEvents> {
  const redactedEvents = redactionPolicy.redact(rawEvent);

  assertRedactedEvents(rawEvent, redactedEvents);

  await tracePort.emit(redactedEvents.persisted);
  await tracePort.emit(redactedEvents.stream);

  return redactedEvents;
}

function assertRedactedEvents(
  rawEvent: RawTurnEvent,
  redactedEvents: RedactedEvents,
): void {
  if (redactedEvents.persisted.visibility !== "persisted") {
    throw new TypeError("RedactionPolicy must return a persisted TurnEvent.");
  }

  if (redactedEvents.stream.visibility !== "stream") {
    throw new TypeError("RedactionPolicy must return a stream TurnEvent.");
  }

  assertSinkEventMatchesRaw(rawEvent, redactedEvents.persisted);
  assertSinkEventMatchesRaw(rawEvent, redactedEvents.stream);
  assertNoRawSinkFields(redactedEvents.persisted);
  assertNoRawSinkFields(redactedEvents.stream);
}

function assertSinkEventMatchesRaw(
  rawEvent: RawTurnEvent,
  sinkEvent: RedactedEvents["persisted"] | RedactedEvents["stream"],
): void {
  if (sinkEvent.runId !== rawEvent.runId) {
    throw new TypeError("Redacted TurnEvent runId must match the raw event.");
  }

  if (sinkEvent.runSpecHash !== rawEvent.runSpecHash) {
    throw new TypeError("Redacted TurnEvent runSpecHash must match the raw event.");
  }

  if (sinkEvent.turnIndex !== rawEvent.turnIndex) {
    throw new TypeError("Redacted TurnEvent turnIndex must match the raw event.");
  }
}

function assertNoRawSinkFields(
  event: RedactedEvents["persisted"] | RedactedEvents["stream"],
): void {
  const candidate = event as unknown as Record<string, unknown>;

  assertMissingNestedKey(candidate, "input", "prompt");
  assertMissingNestedKey(candidate, "input", "systemPrompt");
  assertMissingNestedKey(candidate, "output", "raw");
  assertMissingNestedKey(candidate, "workspace", "diff");
  assertMissingNestedKey(candidate, "validation", "output");
}

function assertMissingNestedKey(
  candidate: Record<string, unknown>,
  parentKey: string,
  childKey: string,
): void {
  const nested = candidate[parentKey];

  if (
    nested !== undefined &&
    nested !== null &&
    typeof nested === "object" &&
    Object.prototype.hasOwnProperty.call(nested, childKey)
  ) {
    throw new TypeError(
      `Redacted TurnEvent must not expose ${parentKey}.${childKey}.`,
    );
  }
}
