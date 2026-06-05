import type {
  DialogueScheduler,
  DialogueSchedulerOptions,
  DialogueSchedulerPorts,
  DialogueSchedulerResult,
  PersistedTurnEvent,
  RedactedEvents,
  RawTurnEvent,
  RunSpecHash,
  StreamTurnEvent,
  TurnVerb,
} from "@dzupagent/dialogue-core";
import { hashRunSpec } from "@dzupagent/dialogue-core";

import { validateGoldenTrace } from "./golden-trace.js";
import { RecordedAgentPort } from "./recorded-agent-port.js";
import { RecordedValidatorPort } from "./recorded-validator-port.js";
import { RecordedWorkspacePort } from "./recorded-workspace-port.js";

export interface ReplayDialogueResult {
  readonly schedulerResult: DialogueSchedulerResult;
  readonly actualVerbSequence: readonly TurnVerb[];
  readonly actualRunSpecHash: RunSpecHash;
}

export class ReplayAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayAssertionError";
  }
}

export type SchedulerFactory = (
  ports: DialogueSchedulerPorts,
  options?: DialogueSchedulerOptions
) => DialogueScheduler;

export async function replayDialogue(
  goldenTrace: unknown,
  schedulerFactory: SchedulerFactory
): Promise<ReplayDialogueResult> {
  const trace = validateGoldenTrace(goldenTrace);

  const agentCalls = trace.turns.flatMap((t) => [...t.agentCalls]);
  const validatorCalls = trace.turns.flatMap((t) => [...t.validatorCalls]);
  const snapshots = trace.turns.flatMap((t) => [...t.workspaceSnapshots]);
  const effects = trace.turns.flatMap((t) => [...t.workspaceEffects]);

  const agentPort = new RecordedAgentPort(agentCalls);
  const validatorPort = new RecordedValidatorPort(validatorCalls);
  const workspacePort = new RecordedWorkspacePort({ snapshots, effects });

  const capturedVerbs: TurnVerb[] = [];
  const tracePort = {
    async emit(event: PersistedTurnEvent | StreamTurnEvent): Promise<void> {
      // Capture only persisted events to avoid double-counting (each turn
      // emits both persisted + stream via redactAndEmitTurnEvent).
      if (event.visibility === "persisted" && event.status === "completed") {
        capturedVerbs.push(event.turnType);
      }
    },
  };

  const redactionPolicy = {
    redact(event: RawTurnEvent): RedactedEvents {
      const persisted: PersistedTurnEvent = {
        visibility: "persisted",
        runId: event.runId,
        runSpecHash: event.runSpecHash,
        turnIndex: event.turnIndex,
        turnType: event.turnType,
        mode: event.mode,
        timing: event.timing,
        escape: event.escape,
        status: event.status,
        ...(event.participantId !== undefined
          ? { participantId: event.participantId }
          : {}),
        ...(event.provider !== undefined ? { provider: event.provider } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.decision !== undefined ? { decision: event.decision } : {}),
        ...(event.cost !== undefined ? { cost: event.cost } : {}),
        ...(event.skipReason !== undefined
          ? { skipReason: event.skipReason }
          : {}),
      };
      const stream: StreamTurnEvent = {
        visibility: "stream",
        runId: event.runId,
        runSpecHash: event.runSpecHash,
        turnIndex: event.turnIndex,
        turnType: event.turnType,
        mode: event.mode,
        timing: event.timing,
        escape: event.escape,
        status: event.status,
        ...(event.participantId !== undefined
          ? { participantId: event.participantId }
          : {}),
        ...(event.provider !== undefined ? { provider: event.provider } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.decision !== undefined ? { decision: event.decision } : {}),
        ...(event.cost !== undefined ? { cost: event.cost } : {}),
        ...(event.skipReason !== undefined
          ? { skipReason: event.skipReason }
          : {}),
      };
      return { persisted, stream };
    },
  };

  const scheduler = schedulerFactory({
    agentPort,
    validatorPort,
    workspacePort,
    tracePort,
    redactionPolicy,
  });

  const schedulerResult = await scheduler.run({
    runId: trace.runId,
    runSpec: trace.runSpec,
  });

  const actualRunSpecHash = hashRunSpec(trace.runSpec);
  const actualVerbSequence: readonly TurnVerb[] = capturedVerbs;

  if (actualRunSpecHash !== trace.runSpecHash) {
    throw new ReplayAssertionError(
      `runSpecHash mismatch: expected ${trace.runSpecHash}, got ${actualRunSpecHash}.`
    );
  }

  const goldenVerbs = trace.verbSequence;
  const maxLen = Math.max(actualVerbSequence.length, goldenVerbs.length);
  for (let i = 0; i < maxLen; i++) {
    const actual = actualVerbSequence[i];
    const expected = goldenVerbs[i];
    if (actual !== expected) {
      throw new ReplayAssertionError(
        `verbSequence diverged at turn index ${i}: expected "${String(
          expected
        )}", got "${String(actual)}".`
      );
    }
  }

  return {
    schedulerResult,
    actualVerbSequence,
    actualRunSpecHash,
  };
}
