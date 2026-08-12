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
import { GroupedReplayCoordinator } from "./grouped-replay-coordinator.js";
import { ReplayAssertionError } from "./replay-assertion-error.js";

export { ReplayAssertionError } from "./replay-assertion-error.js";

export interface ReplayDialogueResult {
  readonly schedulerResult: DialogueSchedulerResult;
  readonly actualVerbSequence: readonly TurnVerb[];
  readonly actualRunSpecHash: RunSpecHash;
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
  const actualRunSpecHash = hashRunSpec(trace.runSpec);
  if (actualRunSpecHash !== trace.runSpecHash) {
    throw new ReplayAssertionError("runSpecHash mismatch.", {
      code: "RUN_SPEC_HASH_MISMATCH",
    });
  }

  const coordinator = new GroupedReplayCoordinator(
    trace.turns,
    trace.runId,
    actualRunSpecHash,
  );

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
    agentPort: coordinator.agentPort,
    validatorPort: coordinator.validatorPort,
    workspacePort: coordinator.workspacePort,
    tracePort: coordinator.tracePort,
    redactionPolicy,
  });

  const schedulerResult = await scheduler.run({
    runId: trace.runId,
    runSpec: trace.runSpec,
  });

  coordinator.assertComplete();
  const actualVerbSequence: readonly TurnVerb[] =
    coordinator.actualVerbSequence;

  const goldenVerbs = trace.verbSequence;
  const maxLen = Math.max(actualVerbSequence.length, goldenVerbs.length);
  for (let i = 0; i < maxLen; i++) {
    const actual = actualVerbSequence[i];
    const expected = goldenVerbs[i];
    if (actual !== expected) {
      throw new ReplayAssertionError(
        `verbSequence diverged at turn index ${i}.`,
        { code: "VERB_SEQUENCE_MISMATCH", groupIndex: i },
      );
    }
  }

  return {
    schedulerResult,
    actualVerbSequence,
    actualRunSpecHash,
  };
}
