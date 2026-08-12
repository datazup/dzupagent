import { isDeepStrictEqual } from "node:util";

import type {
  AgentPort,
  AgentResult,
  AgentRunRequest,
  PersistedTurnEvent,
  RunSpecHash,
  StreamTurnEvent,
  TracePort,
  TurnVerb,
  ValidationResult,
  ValidationSpec,
  ValidatorPort,
  WorkspaceEffect,
  WorkspacePort,
  WorkspaceSnapshot,
} from "@dzupagent/dialogue-core";

import type { GoldenTraceTurn } from "./golden-trace-contract.js";
import { RecordedAgentPort } from "./recorded-agent-port.js";
import {
  ReplayAssertionError,
  type ReplayAssertionCode,
  type ReplayAssertionDetails,
  type ReplayRecordingMethod,
} from "./replay-assertion-error.js";
import { RecordedValidatorPort } from "./recorded-validator-port.js";
import { RecordedWorkspacePort } from "./recorded-workspace-port.js";

type SinkEvent = PersistedTurnEvent | StreamTurnEvent;

interface MethodCounts {
  agent: number;
  validator: number;
  snapshots: number;
  effects: number;
}

interface ReplayGroupState {
  readonly turn: GoldenTraceTurn;
  readonly agentPort: RecordedAgentPort;
  readonly validatorPort: RecordedValidatorPort;
  readonly workspacePort: RecordedWorkspacePort;
  readonly counts: MethodCounts;
}

interface EventOutcomeSnapshot {
  readonly runId: SinkEvent["runId"];
  readonly runSpecHash: SinkEvent["runSpecHash"];
  readonly turnIndex: SinkEvent["turnIndex"];
  readonly turnType: SinkEvent["turnType"];
  readonly participantId: SinkEvent["participantId"];
  readonly provider: SinkEvent["provider"];
  readonly model: SinkEvent["model"];
  readonly mode: SinkEvent["mode"];
  readonly decision: SinkEvent["decision"];
  readonly cost: SinkEvent["cost"];
  readonly timing: SinkEvent["timing"];
  readonly escape: SinkEvent["escape"];
  readonly status: SinkEvent["status"];
  readonly skipReason: SinkEvent["skipReason"];
}

const RECORDING_METHODS: readonly ReplayRecordingMethod[] = [
  "agent.run",
  "validator.validate",
  "workspace.snapshot",
  "workspace.captureEffect",
];

export class GroupedReplayCoordinator {
  readonly agentPort: AgentPort;
  readonly validatorPort: ValidatorPort;
  readonly workspacePort: WorkspacePort;
  readonly tracePort: TracePort;

  private readonly groups: readonly ReplayGroupState[];
  private readonly completedVerbs: TurnVerb[] = [];
  private groupIndex = 0;
  private pendingOutcome: EventOutcomeSnapshot | undefined;
  private violation: ReplayAssertionError | undefined;

  constructor(
    turns: readonly GoldenTraceTurn[],
    private readonly expectedRunId: string,
    private readonly expectedRunSpecHash: RunSpecHash,
  ) {
    this.groups = turns.map((turn) => ({
      turn,
      agentPort: new RecordedAgentPort(turn.agentCalls),
      validatorPort: new RecordedValidatorPort(turn.validatorCalls),
      workspacePort: new RecordedWorkspacePort({
        snapshots: turn.workspaceSnapshots,
        effects: turn.workspaceEffects,
      }),
      counts: { agent: 0, validator: 0, snapshots: 0, effects: 0 },
    }));
    this.agentPort = new GroupedAgentPort(this);
    this.validatorPort = new GroupedValidatorPort(this);
    this.workspacePort = new GroupedWorkspacePort(this);
    this.tracePort = new GroupedTracePort(this);
  }

  get actualVerbSequence(): readonly TurnVerb[] {
    return [...this.completedVerbs];
  }

  get agentCallCount(): number {
    return sumCounts(this.groups, "agent");
  }

  get validatorCallCount(): number {
    return sumCounts(this.groups, "validator");
  }

  get workspaceCallCount(): number {
    return (
      sumCounts(this.groups, "snapshots") + sumCounts(this.groups, "effects")
    );
  }

  get workspaceMismatchCount(): number {
    return this.groups.reduce(
      (total, group) =>
        total + group.workspacePort.dialogueReplayWorkspaceWriteMismatchCount,
      0,
    );
  }

  async runAgent(request: AgentRunRequest): Promise<AgentResult> {
    const group = this.requireRecording("agent.run");
    this.assertAgentIdentity(request, group);
    group.counts.agent += 1;

    try {
      const result = await group.agentPort.run(request);
      return result;
    } catch {
      this.failRecordingMismatch("agent.run");
    }
  }

  async validate(spec: ValidationSpec): Promise<ValidationResult> {
    const group = this.requireRecording("validator.validate");
    group.counts.validator += 1;

    try {
      const result = await group.validatorPort.validate(spec);
      return result;
    } catch {
      this.failRecordingMismatch("validator.validate");
    }
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const group = this.requireRecording("workspace.snapshot");
    group.counts.snapshots += 1;

    try {
      const snapshot = await group.workspacePort.snapshot();
      return snapshot;
    } catch {
      this.failRecordingMismatch("workspace.snapshot");
    }
  }

  async captureEffect(
    beforeSnapshot: WorkspaceSnapshot,
  ): Promise<WorkspaceEffect> {
    const group = this.requireRecording("workspace.captureEffect");
    group.counts.effects += 1;

    try {
      const effect = await group.workspacePort.captureEffect(beforeSnapshot);
      return effect;
    } catch {
      this.failRecordingMismatch("workspace.captureEffect");
    }
  }

  async emit(event: SinkEvent): Promise<void> {
    this.throwIfViolated();

    if (event.visibility === "persisted") {
      this.acceptPersistedEvent(event);
      return;
    }

    this.acceptStreamEvent(event);
  }

  assertComplete(): void {
    this.throwIfViolated();

    if (this.pendingOutcome !== undefined) {
      this.fail(
        "EVENT_ORDER_MISMATCH",
        `Replay event pair is incomplete at group ${this.groupIndex}.`,
      );
    }

    if (this.groupIndex !== this.groups.length) {
      this.fail(
        "GROUP_COUNT_MISMATCH",
        `Replay stopped before consuming every supplied group.`,
        {
          expectedCount: this.groups.length,
          actualCount: this.groupIndex,
        },
      );
    }
  }

  private requireRecording(method: ReplayRecordingMethod): ReplayGroupState {
    this.throwIfViolated();

    if (this.pendingOutcome !== undefined) {
      this.fail(
        "EVENT_ORDER_MISMATCH",
        `Replay method ${method} was called inside a terminal event pair.`,
        { methodName: method },
      );
    }

    const group = this.groups[this.groupIndex];
    if (group === undefined) {
      this.fail(
        "RECORDING_OVERRUN",
        `Replay method ${method} exceeded the supplied groups.`,
        { methodName: method, expectedCount: 0, actualCount: 1 },
      );
    }

    const expectedCount = getExpectedCount(group, method);
    const consumedCount = getConsumedCount(group, method);
    if (consumedCount >= expectedCount) {
      this.fail(
        "RECORDING_OVERRUN",
        `Replay method ${method} exceeded group ${this.groupIndex}.`,
        {
          methodName: method,
          expectedCount,
          actualCount: consumedCount + 1,
        },
      );
    }

    return group;
  }

  private assertAgentIdentity(
    request: AgentRunRequest,
    group: ReplayGroupState,
  ): void {
    if (
      request.runId !== this.expectedRunId ||
      request.runSpecHash !== this.expectedRunSpecHash ||
      request.turnIndex !== this.groupIndex ||
      request.turnType !== group.turn.verb
    ) {
      this.failRecordingMismatch("agent.run");
    }
  }

  private failRecordingMismatch(method: ReplayRecordingMethod): never {
    this.fail(
      "RECORDING_MISMATCH",
      `Replay input did not match the supplied ${method} recording.`,
      { methodName: method },
    );
  }

  private acceptPersistedEvent(event: PersistedTurnEvent): void {
    if (this.pendingOutcome !== undefined) {
      this.fail(
        "EVENT_ORDER_MISMATCH",
        `Replay received duplicate persisted events at group ${this.groupIndex}.`,
      );
    }

    const group = this.requireActiveEventGroup();
    this.assertEventIdentity(event, group);
    this.pendingOutcome = snapshotEventOutcome(event);
  }

  private acceptStreamEvent(event: StreamTurnEvent): void {
    const pendingOutcome = this.pendingOutcome;
    if (pendingOutcome === undefined) {
      this.fail(
        "EVENT_ORDER_MISMATCH",
        `Replay received a stream event before its persisted pair.`,
      );
    }

    const group = this.requireActiveEventGroup();
    this.assertEventIdentity(event, group);

    if (!isDeepStrictEqual(snapshotEventOutcome(event), pendingOutcome)) {
      this.fail(
        "EVENT_OUTCOME_MISMATCH",
        `Replay terminal event outcomes differ at group ${this.groupIndex}.`,
      );
    }

    this.assertGroupExhausted(group);
    if (event.status === "completed") {
      this.completedVerbs.push(event.turnType);
    }
    this.pendingOutcome = undefined;
    this.groupIndex += 1;
  }

  private requireActiveEventGroup(): ReplayGroupState {
    const group = this.groups[this.groupIndex];
    if (group === undefined) {
      this.fail(
        "GROUP_COUNT_MISMATCH",
        `Replay emitted more terminal turns than supplied groups.`,
        {
          expectedCount: this.groups.length,
          actualCount: this.groupIndex + 1,
        },
      );
    }
    return group;
  }

  private assertEventIdentity(
    event: SinkEvent,
    group: ReplayGroupState,
  ): void {
    if (
      event.runId !== this.expectedRunId ||
      event.runSpecHash !== this.expectedRunSpecHash ||
      event.turnIndex !== this.groupIndex ||
      event.turnType !== group.turn.verb
    ) {
      this.fail(
        "EVENT_IDENTITY_MISMATCH",
        `Replay terminal event identity differs at group ${this.groupIndex}.`,
      );
    }
  }

  private assertGroupExhausted(group: ReplayGroupState): void {
    for (const method of RECORDING_METHODS) {
      const expectedCount = getExpectedCount(group, method);
      const actualCount = getConsumedCount(group, method);
      if (actualCount !== expectedCount) {
        this.fail(
          "RECORDING_UNDERRUN",
          `Replay method ${method} did not exhaust group ${this.groupIndex}.`,
          { methodName: method, expectedCount, actualCount },
        );
      }
    }
  }

  private throwIfViolated(): void {
    if (this.violation !== undefined) {
      throw this.violation;
    }
  }

  private fail(
    code: ReplayAssertionCode,
    message: string,
    details: ReplayAssertionDetails = {},
  ): never {
    const error = new ReplayAssertionError(message, {
      ...details,
      code,
      groupIndex: details.groupIndex ?? this.groupIndex,
    });
    this.violation ??= error;
    throw this.violation;
  }
}

class GroupedAgentPort implements AgentPort {
  constructor(private readonly coordinator: GroupedReplayCoordinator) {}

  get dialogueReplayRecordedPortCallCount(): number {
    return this.coordinator.agentCallCount;
  }

  run(request: AgentRunRequest): Promise<AgentResult> {
    return this.coordinator.runAgent(request);
  }
}

class GroupedValidatorPort implements ValidatorPort {
  constructor(private readonly coordinator: GroupedReplayCoordinator) {}

  get dialogueReplayRecordedPortCallCount(): number {
    return this.coordinator.validatorCallCount;
  }

  validate(spec: ValidationSpec): Promise<ValidationResult> {
    return this.coordinator.validate(spec);
  }
}

class GroupedWorkspacePort implements WorkspacePort {
  constructor(private readonly coordinator: GroupedReplayCoordinator) {}

  get dialogueReplayRecordedPortCallCount(): number {
    return this.coordinator.workspaceCallCount;
  }

  get dialogueReplayWorkspaceWriteMismatchCount(): number {
    return this.coordinator.workspaceMismatchCount;
  }

  snapshot(): Promise<WorkspaceSnapshot> {
    return this.coordinator.snapshot();
  }

  captureEffect(beforeSnapshot: WorkspaceSnapshot): Promise<WorkspaceEffect> {
    return this.coordinator.captureEffect(beforeSnapshot);
  }
}

class GroupedTracePort implements TracePort {
  constructor(private readonly coordinator: GroupedReplayCoordinator) {}

  emit(event: SinkEvent): Promise<void> {
    return this.coordinator.emit(event);
  }
}

function getExpectedCount(
  group: ReplayGroupState,
  method: ReplayRecordingMethod,
): number {
  switch (method) {
    case "agent.run":
      return group.turn.agentCalls.length;
    case "validator.validate":
      return group.turn.validatorCalls.length;
    case "workspace.snapshot":
      return group.turn.workspaceSnapshots.length;
    case "workspace.captureEffect":
      return group.turn.workspaceEffects.length;
  }
}

function getConsumedCount(
  group: ReplayGroupState,
  method: ReplayRecordingMethod,
): number {
  switch (method) {
    case "agent.run":
      return group.counts.agent;
    case "validator.validate":
      return group.counts.validator;
    case "workspace.snapshot":
      return group.counts.snapshots;
    case "workspace.captureEffect":
      return group.counts.effects;
  }
}

function sumCounts(
  groups: readonly ReplayGroupState[],
  key: keyof MethodCounts,
): number {
  return groups.reduce((total, group) => total + group.counts[key], 0);
}

function snapshotEventOutcome(event: SinkEvent): EventOutcomeSnapshot {
  return {
    runId: event.runId,
    runSpecHash: event.runSpecHash,
    turnIndex: event.turnIndex,
    turnType: event.turnType,
    participantId: event.participantId,
    provider: event.provider,
    model: event.model,
    mode: event.mode,
    decision:
      event.decision === undefined
        ? undefined
        : {
            ...event.decision,
            criteria: event.decision.criteria.map((criterion) => ({
              ...criterion,
            })),
          },
    cost: event.cost === undefined ? undefined : { ...event.cost },
    timing: { ...event.timing },
    escape: event.escape,
    status: event.status,
    skipReason: event.skipReason,
  };
}
