import type { AgentPort, AgentResult } from "./ports/agent-port.js";
import type { TracePort } from "./ports/trace-port.js";
import type { ValidatorPort } from "./ports/validator-port.js";
import type {
  WorkspaceEffect,
  WorkspacePort,
  WorkspaceSnapshot,
} from "./ports/workspace-port.js";
import { assertValidRunSpec, hashRunSpec } from "./run-spec-hash.js";
import {
  evaluateRuleDecision,
  parseDecisionBlock,
  shouldStopAfterDecision,
} from "./scheduler/decision-block.js";
import { evaluateModeGate } from "./scheduler/mode-gate.js";
import { expandRunSpecSchedule } from "./scheduler/schedule-expansion.js";
import {
  errorToAgentResult,
  errorToMessage,
  getTurnBoundaryStopReason,
  isAgentRunRequest,
  toTurnEventWorkspace,
  type BudgetUsage,
} from "./scheduler/turn-guards.js";
import {
  buildAgentRunRequest,
  buildRawTurnEvent,
  redactAndEmitTurnEvent,
} from "./scheduler/turn-event-builder.js";
import type { AgentRunRequest } from "./types/agent-run-request.js";
import type { RedactionPolicy } from "./types/redaction-policy.js";
import type {
  ParticipantSpec,
  RunSpec,
  RunSpecHash,
  RunTurnSpec,
} from "./types/run-spec.js";
import type {
  DecisionBlock,
  RawTurnEvent,
  TurnEventStatus,
  TurnEventWorkspace,
} from "./types/turn-event.js";

export type DialogueScheduleItem = RunTurnSpec | AgentRunRequest;

export interface DialogueSchedulerPorts {
  agentPort: AgentPort;
  workspacePort: WorkspacePort;
  validatorPort: ValidatorPort;
  tracePort: TracePort;
  redactionPolicy: RedactionPolicy;
}

export interface DialogueSchedulerClock {
  now(): Date;
}

export type DialogueSchedulerAgentRunNext = (
  requestOverride?: AgentRunRequest
) => Promise<AgentResult>;

export interface DialogueSchedulerAgentRunContext {
  request: AgentRunRequest;
}

export type DialogueSchedulerAgentRunMiddleware = (
  context: DialogueSchedulerAgentRunContext,
  next: DialogueSchedulerAgentRunNext
) => Promise<AgentResult>;

export interface DialogueSchedulerImplementationTurnBinding {
  workspacePort?: WorkspacePort;
}

export interface DialogueSchedulerImplementationTurnResult {
  request: AgentRunRequest;
  snapshot?: WorkspaceSnapshot | undefined;
  output?: AgentResult | undefined;
  effect?: WorkspaceEffect | undefined;
  status: "completed" | "failed";
}

export interface DialogueSchedulerImplementationTurnContext {
  request: AgentRunRequest;
}

export type DialogueSchedulerImplementationTurnNext = (
  binding?: DialogueSchedulerImplementationTurnBinding
) => Promise<DialogueSchedulerImplementationTurnResult>;

export type DialogueSchedulerImplementationTurnMiddleware = (
  context: DialogueSchedulerImplementationTurnContext,
  next: DialogueSchedulerImplementationTurnNext
) => Promise<DialogueSchedulerImplementationTurnResult>;

export interface DialogueSchedulerOptions {
  clock?: DialogueSchedulerClock;
  agentRunMiddleware?: DialogueSchedulerAgentRunMiddleware;
  implementationTurnMiddleware?: DialogueSchedulerImplementationTurnMiddleware;
}

export interface DialogueSchedulerRunInput {
  runId: string;
  runSpec: RunSpec;
  schedule?: DialogueScheduleItem[];
}

export interface DialogueSchedulerTelemetry {
  dialogue_core_turn_event_emitted: number;
  dialogue_core_mode_gate_skip_count: number;
  dialogue_core_escape_request_rejected_count: number;
}

export interface DialogueSchedulerResult {
  runId: string;
  runSpecHash: RunSpecHash;
  activeParticipantId?: string | undefined;
  stopReason?: string | undefined;
  turnsCompleted: number;
  turnsSkipped: number;
  turnsFailed: number;
  traceEmits: number;
  telemetry: DialogueSchedulerTelemetry;
}

interface RunContext {
  runId: string;
  runSpec: RunSpec;
  runSpecHash: RunSpecHash;
  participantsById: Map<string, ParticipantSpec>;
  activeParticipantId?: string | undefined;
  turnIndex: number;
  budgetUsage: BudgetUsage;
  result: DialogueSchedulerResult;
}

interface ExecutedTurn {
  rawEvent: RawTurnEvent;
  decision?: DecisionBlock | undefined;
}

const SYSTEM_PARTICIPANT: ParticipantSpec = {
  id: "scheduler",
  provider: "dialogue-core",
  model: "scheduler",
};

export class DialogueScheduler {
  private readonly agentPort: AgentPort;
  private readonly workspacePort: WorkspacePort;
  private readonly validatorPort: ValidatorPort;
  private readonly tracePort: TracePort;
  private readonly redactionPolicy: RedactionPolicy;
  private readonly clock: DialogueSchedulerClock;
  private readonly agentRunMiddleware:
    | DialogueSchedulerAgentRunMiddleware
    | undefined;
  private readonly implementationTurnMiddleware:
    | DialogueSchedulerImplementationTurnMiddleware
    | undefined;

  constructor(
    ports: DialogueSchedulerPorts,
    options: DialogueSchedulerOptions = {}
  ) {
    this.agentPort = ports.agentPort;
    this.workspacePort = ports.workspacePort;
    this.validatorPort = ports.validatorPort;
    this.tracePort = ports.tracePort;
    this.redactionPolicy = ports.redactionPolicy;
    this.agentRunMiddleware = options.agentRunMiddleware;
    this.implementationTurnMiddleware = options.implementationTurnMiddleware;
    this.clock = options.clock ?? {
      now: () => new Date(),
    };
  }

  async run(
    input: DialogueSchedulerRunInput
  ): Promise<DialogueSchedulerResult> {
    assertValidRunSpec(input.runSpec);

    const context = this.createRunContext(input);
    const schedulePlan: {
      items: DialogueScheduleItem[];
      stopReason?: string | undefined;
    } =
      input.schedule === undefined
        ? expandRunSpecSchedule(input.runSpec)
        : { items: input.schedule };

    for (const item of schedulePlan.items) {
      const turnBoundaryStop = getTurnBoundaryStopReason(
        context.runSpec,
        context.turnIndex,
        context.budgetUsage
      );

      if (turnBoundaryStop !== undefined) {
        await this.emitBoundarySkippedEvent(context, item, turnBoundaryStop);
        context.result.stopReason = turnBoundaryStop;
        break;
      }

      const executedTurn = isAgentRunRequest(item)
        ? await this.executeEscapeRequest(context, item)
        : await this.executeTurn(context, item);

      this.applyExecutedTurn(context, executedTurn);

      const stopDecision = executedTurn.decision;

      if (shouldStopAfterDecision(stopDecision)) {
        context.result.stopReason = `decision=${stopDecision.verdict}`;
        break;
      }
    }

    context.result.stopReason ??= schedulePlan.stopReason;
    context.result.activeParticipantId = context.activeParticipantId;

    return context.result;
  }

  private createRunContext(input: DialogueSchedulerRunInput): RunContext {
    const participantsById = new Map<string, ParticipantSpec>(
      input.runSpec.participants.map((participant) => [
        participant.id,
        participant,
      ])
    );
    const runSpecHash = hashRunSpec(input.runSpec);

    return {
      runId: input.runId,
      runSpec: input.runSpec,
      runSpecHash,
      participantsById,
      activeParticipantId: input.runSpec.participants[0]?.id,
      turnIndex: 0,
      budgetUsage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      result: {
        runId: input.runId,
        runSpecHash,
        turnsCompleted: 0,
        turnsSkipped: 0,
        turnsFailed: 0,
        traceEmits: 0,
        telemetry: {
          dialogue_core_turn_event_emitted: 0,
          dialogue_core_mode_gate_skip_count: 0,
          dialogue_core_escape_request_rejected_count: 0,
        },
      },
    };
  }

  private async executeTurn(
    context: RunContext,
    turn: RunTurnSpec
  ): Promise<ExecutedTurn> {
    const modeGateDecision = evaluateModeGate(context.runSpec.mode, turn.verb);
    const participant = this.resolveParticipant(context, turn.participantId);

    if (!modeGateDecision.shouldRun) {
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        status: "skipped",
        skipReason: modeGateDecision.skipReason ?? "mode=deliberate",
      });

      context.result.telemetry.dialogue_core_mode_gate_skip_count += 1;

      return {
        rawEvent,
      };
    }

    switch (turn.verb) {
      case "deliberate":
      case "review":
        return this.executeAgentTurn(context, turn, participant);
      case "decide":
        return this.executeDecideTurn(context, turn, participant);
      case "implement":
        return this.executeImplementTurn(context, turn, participant);
      case "validate":
        return this.executeValidateTurn(context, turn, participant);
      case "handoff":
        return this.executeHandoffTurn(context, turn);
    }
  }

  private async executeAgentTurn(
    context: RunContext,
    turn: RunTurnSpec,
    participant: ParticipantSpec
  ): Promise<ExecutedTurn> {
    const startedAt = this.clock.now();
    const request = buildAgentRunRequest({
      runId: context.runId,
      runSpecHash: context.runSpecHash,
      turnIndex: context.turnIndex,
      turnType: turn.verb,
      mode: context.runSpec.mode,
      participant,
      prompt: turn.prompt,
      escape: false,
    });

    try {
      const agentResult = await this.runAgent(request);
      this.recordAgentUsage(context, agentResult);
      const decision =
        turn.verb === "review"
          ? parseDecisionBlock(agentResult.raw)
          : undefined;
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        startedAt,
        status: "completed",
        input: request.input,
        output: agentResult,
        decision,
      });

      return {
        rawEvent,
        decision,
      };
    } catch (error) {
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        startedAt,
        status: "failed",
        input: request.input,
        output: errorToAgentResult(error),
      });

      return {
        rawEvent,
      };
    }
  }

  private async executeDecideTurn(
    context: RunContext,
    turn: RunTurnSpec,
    participant: ParticipantSpec
  ): Promise<ExecutedTurn> {
    if (context.runSpec.decidePolicy?.kind === "rule") {
      const decision = evaluateRuleDecision(
        context.runSpec.decidePolicy.ruleId
      );
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant: SYSTEM_PARTICIPANT,
        status: "completed",
        decision,
        output: {
          raw: JSON.stringify(decision),
        },
      });

      return {
        rawEvent,
        decision,
      };
    }

    const decideParticipant =
      context.runSpec.decidePolicy?.kind === "agent"
        ? this.resolveParticipant(
            context,
            context.runSpec.decidePolicy.participantId
          )
        : participant;

    const startedAt = this.clock.now();
    const request = buildAgentRunRequest({
      runId: context.runId,
      runSpecHash: context.runSpecHash,
      turnIndex: context.turnIndex,
      turnType: turn.verb,
      mode: context.runSpec.mode,
      participant: decideParticipant,
      prompt: turn.prompt,
      escape: false,
    });

    try {
      const agentResult = await this.runAgent(request);
      this.recordAgentUsage(context, agentResult);
      const decision = parseDecisionBlock(agentResult.raw);
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant: decideParticipant,
        startedAt,
        status: "completed",
        input: request.input,
        output: agentResult,
        decision,
      });

      return {
        rawEvent,
        decision,
      };
    } catch (error) {
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant: decideParticipant,
        startedAt,
        status: "failed",
        input: request.input,
        output: errorToAgentResult(error),
      });

      return {
        rawEvent,
      };
    }
  }

  private async executeImplementTurn(
    context: RunContext,
    turn: RunTurnSpec,
    participant: ParticipantSpec
  ): Promise<ExecutedTurn> {
    const startedAt = this.clock.now();
    const request = buildAgentRunRequest({
      runId: context.runId,
      runSpecHash: context.runSpecHash,
      turnIndex: context.turnIndex,
      turnType: turn.verb,
      mode: context.runSpec.mode,
      participant,
      prompt: turn.prompt,
      escape: false,
    });
    let output: AgentResult | undefined;
    let workspace: TurnEventWorkspace | undefined;
    let status: TurnEventStatus = "completed";

    try {
      const execution = await this.runImplementationTurn(context, request);
      output = execution.output;
      status = execution.status;
      if (execution.snapshot !== undefined && execution.effect !== undefined) {
        workspace = toTurnEventWorkspace(execution.snapshot, execution.effect);
      }
    } catch (error) {
      status = "failed";
      output = errorToAgentResult(error);
    }

    const rawEvent = await this.emitRawEvent(context, {
      turn,
      participant,
      startedAt,
      status,
      input: request.input,
      output,
      workspace,
    });

    return {
      rawEvent,
    };
  }

  private async executeValidateTurn(
    context: RunContext,
    turn: RunTurnSpec,
    participant: ParticipantSpec
  ): Promise<ExecutedTurn> {
    if (turn.validation === undefined) {
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        status: "failed",
        skipReason: "validation=missing",
      });

      return {
        rawEvent,
      };
    }

    try {
      const result = await this.validatorPort.validate(turn.validation);
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        status: result.ok ? "completed" : "failed",
        validation: {
          commandId: turn.validation.commandId,
          ok: result.ok,
          exitCode: result.exitCode,
          output: result.output,
          durationMs: result.durationMs,
        },
      });

      return {
        rawEvent,
      };
    } catch (error) {
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        status: "failed",
        validation: {
          commandId: turn.validation.commandId,
          ok: false,
          exitCode: 1,
          output: errorToMessage(error),
          durationMs: 0,
        },
      });

      return {
        rawEvent,
      };
    }
  }

  private async executeHandoffTurn(
    context: RunContext,
    turn: RunTurnSpec
  ): Promise<ExecutedTurn> {
    const handoff = turn.handoff;

    if (handoff === undefined) {
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant: SYSTEM_PARTICIPANT,
        status: "failed",
        skipReason: "handoff=missing",
      });

      return {
        rawEvent,
      };
    }

    const targetParticipant = context.participantsById.get(
      handoff.toParticipantId
    );
    const sourceParticipant =
      context.participantsById.get(handoff.fromParticipantId) ??
      SYSTEM_PARTICIPANT;
    const status: TurnEventStatus =
      targetParticipant === undefined ? "failed" : "completed";
    const rawEvent = await this.emitRawEvent(context, {
      turn,
      participant: sourceParticipant,
      status,
      skipReason:
        targetParticipant === undefined
          ? "handoff=unknown-participant"
          : undefined,
      output: {
        raw: JSON.stringify(handoff),
      },
    });

    if (targetParticipant !== undefined) {
      context.activeParticipantId = targetParticipant.id;
    }

    return {
      rawEvent,
    };
  }

  private async executeEscapeRequest(
    context: RunContext,
    request: AgentRunRequest
  ): Promise<ExecutedTurn> {
    const participant = this.resolveParticipant(context, request.participantId);
    const startedAt = this.clock.now();
    const turn: RunTurnSpec = {
      id: `escape:${request.turnIndex}`,
      verb: request.turnType,
      participantId: request.participantId,
      prompt: request.input.prompt,
    };

    if (context.runSpec.allowEscape !== true) {
      context.result.telemetry.dialogue_core_escape_request_rejected_count += 1;
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        startedAt,
        status: "skipped",
        skipReason: "allowEscape=false",
        input: request.input,
        escape: true,
      });

      return {
        rawEvent,
      };
    }

    try {
      const agentResult = await this.runAgent({
        ...request,
        runId: context.runId,
        runSpecHash: context.runSpecHash,
        turnIndex: context.turnIndex,
        escape: true,
      });
      this.recordAgentUsage(context, agentResult);
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        startedAt,
        status: "completed",
        input: request.input,
        output: agentResult,
        escape: true,
      });

      return {
        rawEvent,
      };
    } catch (error) {
      const rawEvent = await this.emitRawEvent(context, {
        turn,
        participant,
        startedAt,
        status: "failed",
        input: request.input,
        output: errorToAgentResult(error),
        escape: true,
      });

      return {
        rawEvent,
      };
    }
  }

  private async emitBoundarySkippedEvent(
    context: RunContext,
    item: DialogueScheduleItem,
    skipReason: string
  ): Promise<void> {
    const turn = isAgentRunRequest(item)
      ? {
          id: `escape:${item.turnIndex}`,
          verb: item.turnType,
          participantId: item.participantId,
          prompt: item.input.prompt,
        }
      : item;

    const participant = this.resolveParticipant(context, turn.participantId);

    await this.emitRawEvent(context, {
      turn,
      participant,
      status: "skipped",
      skipReason,
      input: isAgentRunRequest(item) ? item.input : undefined,
      escape: isAgentRunRequest(item),
    });

    context.result.turnsSkipped += 1;
    context.turnIndex += 1;
  }

  private async emitRawEvent(
    context: RunContext,
    input: {
      turn: RunTurnSpec;
      status: TurnEventStatus;
      participant?: ParticipantSpec | undefined;
      startedAt?: Date | undefined;
      input?: AgentRunRequest["input"] | undefined;
      output?: AgentResult | undefined;
      workspace?: TurnEventWorkspace | undefined;
      validation?: RawTurnEvent["validation"] | undefined;
      decision?: DecisionBlock | undefined;
      skipReason?: string | undefined;
      escape?: boolean | undefined;
    }
  ): Promise<RawTurnEvent> {
    const startedAt = input.startedAt ?? this.clock.now();
    const endedAt = this.clock.now();
    const rawEvent = buildRawTurnEvent({
      runId: context.runId,
      runSpecHash: context.runSpecHash,
      turnIndex: context.turnIndex,
      turnType: input.turn.verb,
      mode: context.runSpec.mode,
      startedAt: startedAt.toISOString(),
      ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      escape: input.escape ?? false,
      status: input.status,
      participant: input.participant,
      input: input.input,
      output: input.output,
      workspace: input.workspace,
      validation: input.validation,
      decision: input.decision,
      skipReason: input.skipReason,
    });

    await redactAndEmitTurnEvent(
      this.tracePort,
      this.redactionPolicy,
      rawEvent
    );

    context.result.telemetry.dialogue_core_turn_event_emitted += 1;
    context.result.traceEmits += 2;

    return rawEvent;
  }

  private applyExecutedTurn(
    context: RunContext,
    executedTurn: ExecutedTurn
  ): void {
    switch (executedTurn.rawEvent.status) {
      case "completed":
        context.result.turnsCompleted += 1;
        break;
      case "skipped":
        context.result.turnsSkipped += 1;
        break;
      case "failed":
        context.result.turnsFailed += 1;
        break;
    }

    context.turnIndex += 1;
  }

  private resolveParticipant(
    context: RunContext,
    participantId?: string
  ): ParticipantSpec {
    const resolvedId = participantId ?? context.activeParticipantId;

    if (resolvedId !== undefined) {
      const participant = context.participantsById.get(resolvedId);

      if (participant !== undefined) {
        return participant;
      }
    }

    return context.runSpec.participants[0] ?? SYSTEM_PARTICIPANT;
  }

  private recordAgentUsage(context: RunContext, result: AgentResult): void {
    context.budgetUsage.inputTokens += result.usage?.inputTokens ?? 0;
    context.budgetUsage.outputTokens += result.usage?.outputTokens ?? 0;
  }

  private runAgent(request: AgentRunRequest): Promise<AgentResult> {
    const next = (requestOverride: AgentRunRequest = request) =>
      this.agentPort.run(requestOverride);

    if (this.agentRunMiddleware === undefined) {
      return next();
    }

    return this.agentRunMiddleware({ request }, next);
  }

  private runImplementationTurn(
    context: RunContext,
    request: AgentRunRequest
  ): Promise<DialogueSchedulerImplementationTurnResult> {
    const next: DialogueSchedulerImplementationTurnNext = (binding = {}) =>
      this.executeBoundImplementationTurn(
        context,
        request,
        binding.workspacePort ?? this.workspacePort
      );

    if (this.implementationTurnMiddleware === undefined) {
      return next();
    }

    return this.implementationTurnMiddleware({ request }, next);
  }

  private async executeBoundImplementationTurn(
    context: RunContext,
    request: AgentRunRequest,
    workspacePort: WorkspacePort
  ): Promise<DialogueSchedulerImplementationTurnResult> {
    let snapshot: WorkspaceSnapshot | undefined;
    let output: AgentResult | undefined;
    let effect: WorkspaceEffect | undefined;
    let status: "completed" | "failed" = "completed";

    try {
      snapshot = await workspacePort.snapshot();
      output = await this.runAgent(request);
      this.recordAgentUsage(context, output);
      effect = await workspacePort.captureEffect(snapshot);
      status = effect.applyStatus === "failed" ? "failed" : "completed";
    } catch (error) {
      status = "failed";
      output = output ?? errorToAgentResult(error);
      if (snapshot !== undefined && effect === undefined) {
        effect = await this.captureWorkspaceEffectAfterFailure(
          snapshot,
          workspacePort
        );
      }
    }

    return { request, snapshot, output, effect, status };
  }

  private async captureWorkspaceEffectAfterFailure(
    snapshot: WorkspaceSnapshot,
    workspacePort: WorkspacePort = this.workspacePort
  ): Promise<WorkspaceEffect | undefined> {
    try {
      return await workspacePort.captureEffect(snapshot);
    } catch {
      return undefined;
    }
  }
}
