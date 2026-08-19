import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import { FleetSupervisor } from "../fleet-supervisor.js";
import { buildReconciliationDecisionEnvelope } from "../fleet-reconciliation.js";
import type {
  Assignment,
  ContractChange,
  ContractPayload,
  DecisionPayload,
  EscalationOutcome,
  EscalationReason,
  Executor,
  FleetPolicy,
  FleetRunSpec,
  FleetSupervisorApi,
  FleetTask,
  KnowledgeEnvelope,
  KnowledgeFilter,
  KnowledgeRef,
  KnowledgeStore,
  ReconciliationPlan,
  RepoAgentRef,
  RepoAgentResult,
  Unsubscribe,
  WorkerEvent,
  WorkerHandle,
  WorkerOutcome,
  WorkerSpec,
} from "@dzupagent/agent-types/fleet";

class MemoryKnowledgeStore implements KnowledgeStore {
  private readonly entries = new Map<string, KnowledgeEnvelope[]>();

  async append(
    scope: string,
    entry: KnowledgeEnvelope
  ): Promise<KnowledgeRef> {
    const scoped = this.entries.get(scope) ?? [];
    scoped.push(entry);
    this.entries.set(scope, scoped);
    return { id: entry.id, version: entry.version };
  }

  async read<T extends KnowledgeEnvelope = KnowledgeEnvelope>(
    scope: string,
    kind: KnowledgeEnvelope["kind"],
    key: string
  ): Promise<T | null> {
    const matches = (this.entries.get(scope) ?? []).filter(
      (entry) => entry.kind === kind && entry.key === key
    );
    return (matches.at(-1) as T | undefined) ?? null;
  }

  async *query(filter: KnowledgeFilter): AsyncIterable<KnowledgeEnvelope> {
    const scopes =
      filter.scope === undefined ? [...this.entries.keys()] : [filter.scope];
    for (const scope of scopes) {
      for (const entry of this.entries.get(scope) ?? []) {
        if (filter.kind !== undefined && entry.kind !== filter.kind) continue;
        if (filter.key !== undefined && entry.key !== filter.key) continue;
        if (filter.repo !== undefined && entry.repo !== filter.repo) continue;
        yield entry;
      }
    }
  }

  subscribe(
    _filter: KnowledgeFilter,
    _handler: (entry: KnowledgeEnvelope) => void
  ): Unsubscribe {
    return () => {};
  }

  all(scope: string): KnowledgeEnvelope[] {
    return [...(this.entries.get(scope) ?? [])];
  }
}

class RejectTransitionFailOnceStore extends MemoryKnowledgeStore {
  private shouldFail = true;

  override async append(
    scope: string,
    entry: KnowledgeEnvelope
  ): Promise<KnowledgeRef> {
    if (
      this.shouldFail
      && entry.kind === "contract"
      && (entry.payload as ContractPayload).status === "rejected"
    ) {
      this.shouldFail = false;
      throw new Error("injected rejected-transition failure");
    }
    return super.append(scope, entry);
  }
}

class ConflictingDecisionReadStore extends MemoryKnowledgeStore {
  constructor(private readonly conflict: KnowledgeEnvelope) {
    super();
  }

  override async read<T extends KnowledgeEnvelope = KnowledgeEnvelope>(
    scope: string,
    kind: KnowledgeEnvelope["kind"],
    key: string
  ): Promise<T | null> {
    if (kind === "decision" && key === this.conflict.key) {
      return this.conflict as T;
    }
    return super.read<T>(scope, kind, key);
  }
}

type SpawnHook = (
  spec: WorkerSpec,
  dispatchIndex: number
) => Promise<void> | void;

class RecordingExecutor implements Executor {
  readonly id = "recording";
  readonly dispatches: string[] = [];

  constructor(private readonly onSpawn?: SpawnHook) {}

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    this.dispatches.push(spec.taskBundle.id);
    await this.onSpawn?.(spec, this.dispatches.length - 1);
    const events: WorkerEvent[] = [
      { kind: "exit", code: 0, reason: null, at: "t" },
    ];
    const outcome: WorkerOutcome = { state: "completed", exitCode: 0 };
    return {
      workerId: spec.workerId,
      events: (async function* (): AsyncGenerator<WorkerEvent> {
        for (const event of events) yield event;
      })(),
      async send() {},
      async cancel() {},
      async wait(): Promise<WorkerOutcome> {
        return outcome;
      },
    };
  }
}

const NO_CHANGE: ReconciliationPlan = {
  ratified: null,
  rejectIds: [],
  pauseTasks: [],
  escalate: false,
};

type PlanFactory = (
  change: ContractChange,
  callIndex: number
) => Promise<ReconciliationPlan> | ReconciliationPlan;

class RecordingPolicy implements FleetPolicy {
  readonly id = "recording-reconciliation";
  readonly changes: ContractChange[] = [];
  readonly fleets: RepoAgentRef[][] = [];
  readonly assignmentFleets: RepoAgentRef[][] = [];
  readonly escalations: EscalationReason[] = [];

  constructor(
    private readonly planFor: PlanFactory = () => NO_CHANGE,
    private readonly escalationOutcome: EscalationOutcome = {
      kind: "human-handoff",
      note: "operator handoff",
    }
  ) {}

  async assignTask(
    task: FleetTask,
    fleet: RepoAgentRef[],
    _knowledge: KnowledgeStore
  ): Promise<Assignment> {
    this.assignmentFleets.push(fleet);
    const worker = fleet.find((candidate) => !candidate.busy);
    if (!worker) throw new Error("No idle worker for " + task.id);
    return {
      taskId: task.id,
      workerId: worker.workerId,
      rationale: "recording assignment",
    };
  }

  async onContractChange(
    change: ContractChange,
    fleet: RepoAgentRef[]
  ): Promise<ReconciliationPlan> {
    const callIndex = this.changes.length;
    this.changes.push(change);
    this.fleets.push(fleet);
    return await this.planFor(change, callIndex);
  }

  async onWorkerComplete(
    _result: RepoAgentResult,
    _supervisor: FleetSupervisorApi
  ): Promise<void> {}

  async onEscalation(
    reason: EscalationReason,
    _supervisor: FleetSupervisorApi
  ): Promise<EscalationOutcome> {
    this.escalations.push(reason);
    return this.escalationOutcome;
  }
}

function proposalEnvelope(
  id: string,
  runId: string,
  surface: string,
  status: ContractPayload["status"] = "proposed"
): KnowledgeEnvelope {
  return {
    id,
    runId,
    repo: null,
    kind: "contract",
    key: id,
    version: 1,
    authorWorkerId: null,
    parentId: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    supersededAt: null,
    payload: {
      surface,
      changeKind: "modify",
      before: null,
      after: { proposal: id },
      consumers: ["consumer"],
      rationale: "proposal " + id,
      status,
    },
    tags: [],
  };
}

function lessonEnvelope(id: string, runId: string): KnowledgeEnvelope {
  return {
    id,
    runId,
    repo: null,
    kind: "lesson",
    key: id,
    version: 1,
    authorWorkerId: null,
    parentId: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    supersededAt: null,
    payload: {
      scope: "this-run",
      rule: "not a contract",
      why: "filtering control",
      howToApply: "ignore it",
      evidenceLinks: [],
    },
    tags: [],
  };
}

function malformedContractEnvelope(
  id: string,
  runId: string
): KnowledgeEnvelope {
  return {
    ...proposalEnvelope(id, runId, "api"),
    payload: {
      surface: 42,
      status: "proposed",
    } as unknown as ContractPayload,
  };
}

function payloadOf(envelope: KnowledgeEnvelope): ContractPayload {
  return envelope.payload as ContractPayload;
}

function task(id: string): FleetTask {
  return { id, description: id, payload: {}, dependsOn: [] };
}

function spec(
  runId: string,
  tasks: FleetTask[] = [task("t1")],
  repos: FleetRunSpec["repos"] = [{ name: "repo-a", path: "/tmp/repo-a" }],
  seedKnowledge?: KnowledgeEnvelope[]
): FleetRunSpec {
  return {
    runId,
    scenario: "independent-tasks",
    repos,
    tasks,
    ...(seedKnowledge === undefined ? {} : { seedKnowledge }),
  };
}

function fanOutSpec(
  runId: string,
  tasks: FleetTask[],
  seedKnowledge?: KnowledgeEnvelope[]
): FleetRunSpec {
  return {
    ...spec(runId, tasks, undefined, seedKnowledge),
    scenario: "audit-fanout",
  };
}

function newSupervisor(
  store: KnowledgeStore,
  executor: RecordingExecutor
): FleetSupervisor {
  return new FleetSupervisor({
    knowledge: store,
    executorFor: () => executor,
  });
}

function decisions(entries: KnowledgeEnvelope[]): DecisionPayload[] {
  return entries
    .filter((entry) => entry.kind === "decision")
    .map((entry) => entry.payload as DecisionPayload);
}

function reconciliations(entries: KnowledgeEnvelope[]): DecisionPayload[] {
  return decisions(entries).filter(
    (decision) => decision.decisionKind === "reconciliation"
  );
}

function contracts(entries: KnowledgeEnvelope[]): KnowledgeEnvelope[] {
  return entries.filter((entry) => entry.kind === "contract");
}

function taskStates(entries: KnowledgeEnvelope[]): KnowledgeEnvelope[] {
  return entries.filter((entry) => entry.kind === "task-state");
}

describe("FleetSupervisor contract-change reconciliation admission", () => {
  it("groups seeded proposals for one surface in stable query order", async () => {
    const store = new MemoryKnowledgeStore();
    const first = proposalEnvelope("p-1", "group-one", "api");
    const second = proposalEnvelope("p-2", "group-one", "api");
    const policy = new RecordingPolicy();

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("group-one", [], undefined, [first, second]),
      policy
    );

    expect(policy.changes).toEqual([
      {
        surface: "api",
        proposalIds: ["p-1", "p-2"],
        proposals: [payloadOf(first), payloadOf(second)],
      },
    ]);
    expect(reconciliations(store.all("run:group-one"))[0]?.inputs).toEqual([
      "api",
      "p-1",
      "p-2",
    ]);
  });

  it("orders multiple surface callbacks by first appearance", async () => {
    const store = new MemoryKnowledgeStore();
    const storageOne = proposalEnvelope("storage-1", "multi", "storage");
    const api = proposalEnvelope("api-1", "multi", "api");
    const storageTwo = proposalEnvelope("storage-2", "multi", "storage");
    const policy = new RecordingPolicy();

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("multi", [], undefined, [storageOne, api, storageTwo]),
      policy
    );

    expect(policy.changes.map((change) => change.surface)).toEqual([
      "storage",
      "api",
    ]);
    expect(policy.changes[0]?.proposals).toEqual([
      payloadOf(storageOne),
      payloadOf(storageTwo),
    ]);
  });

  it("passes the real current fleet refs into reconciliation", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-fleet", "fleet-refs", "api");
    const policy = new RecordingPolicy();
    const result = await newSupervisor(
      store,
      new RecordingExecutor()
    ).run(
      spec(
        "fleet-refs",
        [task("work")],
        [
          { name: "repo-a", path: "/tmp/repo-a" },
          { name: "repo-b", path: "/tmp/repo-b" },
        ],
        [proposal]
      ),
      policy
    );

    expect(policy.fleets[0]?.map((ref) => ref.repo)).toEqual([
      "repo-a",
      "repo-b",
    ]);
    expect(policy.fleets[0]?.every((ref) => !ref.busy)).toBe(true);
    expect(policy.fleets[0]?.every((ref) => ref.workerId.startsWith("w-"))).toBe(
      true
    );
    expect(policy.fleets[0]?.[0]).toBe(policy.assignmentFleets[0]?.[0]);
    expect(result.taskOutcomes[0]?.workerId).toBe(
      policy.fleets[0]?.[0]?.workerId
    );
  });

  it("persists the complete returned plan as the reconciliation outcome", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-plan", "complete-plan", "api");
    const oldProposal = proposalEnvelope("p-old", "complete-plan", "api");
    const ratified: ContractPayload = {
      ...payloadOf(proposal),
      status: "ratified",
    };
    const plan: ReconciliationPlan = {
      ratified,
      rejectIds: ["p-old"],
      pauseTasks: ["blocked-task"],
      escalate: false,
    };
    const policy = new RecordingPolicy(() => plan);

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("complete-plan", [task("blocked-task")], undefined, [proposal, oldProposal]),
      policy
    );

    const decision = reconciliations(store.all("run:complete-plan"))[0];
    expect(decision?.outcome).toBe(plan);
    expect(decision?.outcome).toEqual({
      ratified,
      rejectIds: ["p-old"],
      pauseTasks: ["blocked-task"],
      escalate: false,
    });
    expect(decision?.policyId).toBe("recording-reconciliation");
  });

  it("does not process a seeded envelope again at later checkpoints", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-once", "once", "api");
    const policy = new RecordingPolicy();

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("once", [task("t1"), task("t2")], undefined, [proposal]),
      policy
    );

    expect(policy.changes).toHaveLength(1);
    expect(reconciliations(store.all("run:once"))).toHaveLength(1);
  });

  it("reconciles a worker proposal before the next sequential dispatch", async () => {
    const store = new MemoryKnowledgeStore();
    const order: string[] = [];
    const executor = new RecordingExecutor(async (workerSpec) => {
      order.push("spawn:" + workerSpec.taskBundle.id);
      if (workerSpec.taskBundle.id === "t1") {
        await workerSpec.knowledgeHandle.store.append(
          workerSpec.knowledgeHandle.scope,
          proposalEnvelope("p-worker", "worker-proposal", "api")
        );
      }
    });
    const policy = new RecordingPolicy((change) => {
      order.push("reconcile:" + change.surface);
      return NO_CHANGE;
    });

    await newSupervisor(store, executor).run(
      spec("worker-proposal", [task("t1"), task("t2")]),
      policy
    );

    expect(order).toEqual(["spawn:t1", "reconcile:api", "spawn:t2"]);
    expect(policy.changes).toHaveLength(1);
  });

  it("reconciles after a fan-out batch before starting the next batch", async () => {
    const store = new MemoryKnowledgeStore();
    const order: string[] = [];
    const executor = new RecordingExecutor(async (workerSpec) => {
      order.push("spawn:" + workerSpec.taskBundle.id);
      if (workerSpec.taskBundle.id === "batch-1") {
        await workerSpec.knowledgeHandle.store.append(
          workerSpec.knowledgeHandle.scope,
          proposalEnvelope("p-fanout", "fanout-proposal", "api")
        );
      }
    });
    const policy = new RecordingPolicy((change) => {
      order.push("reconcile:" + change.surface);
      return NO_CHANGE;
    });

    await newSupervisor(store, executor).run(
      fanOutSpec("fanout-proposal", [task("batch-1"), task("batch-2")]),
      policy
    );

    expect(order).toEqual([
      "spawn:batch-1",
      "reconcile:api",
      "spawn:batch-2",
    ]);
    expect(policy.changes).toHaveLength(1);
  });

  it("ignores non-proposed, malformed, non-contract, and wrong-run entries", async () => {
    const store = new MemoryKnowledgeStore();
    const valid = proposalEnvelope("valid", "filtering", "api");
    const ratified = proposalEnvelope(
      "ratified",
      "filtering",
      "api",
      "ratified"
    );
    const rejected = proposalEnvelope(
      "rejected",
      "filtering",
      "api",
      "rejected"
    );
    const wrongRun = proposalEnvelope("wrong-run", "another-run", "api");
    const malformed = malformedContractEnvelope("malformed", "filtering");
    const lesson = lessonEnvelope("lesson", "filtering");
    const policy = new RecordingPolicy();

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("filtering", [], undefined, [
        ratified,
        rejected,
        wrongRun,
        malformed,
        lesson,
        valid,
      ]),
      policy
    );

    expect(policy.changes).toEqual([
      {
        surface: "api",
        proposalIds: ["valid"],
        proposals: [payloadOf(valid)],
      },
    ]);
  });

  it("propagates callback rejection and starts no task", async () => {
    const store = new MemoryKnowledgeStore();
    const executor = new RecordingExecutor();
    const failure = new Error("reconciliation failed");
    const policy = new RecordingPolicy(() => {
      throw failure;
    });

    await expect(
      newSupervisor(store, executor).run(
        spec("callback-error", [task("t1"), task("t2")], undefined, [
          proposalEnvelope("p-error", "callback-error", "api"),
        ]),
        policy
      )
    ).rejects.toBe(failure);
    expect(executor.dispatches).toEqual([]);
    expect(reconciliations(store.all("run:callback-error"))).toEqual([]);
  });

  it("routes an escalating plan to human handoff before dispatch", async () => {
    const store = new MemoryKnowledgeStore();
    const executor = new RecordingExecutor();
    const plan: ReconciliationPlan = {
      ...NO_CHANGE,
      escalate: true,
    };
    const policy = new RecordingPolicy(() => plan, {
      kind: "human-handoff",
      note: "contract conflict",
    });

    const result = await newSupervisor(store, executor).run(
      spec("handoff", [task("t1"), task("t2")], undefined, [
        proposalEnvelope("p-conflict", "handoff", "api"),
      ]),
      policy
    );

    expect(result.status).toBe("escalated");
    expect(result.taskOutcomes).toEqual([]);
    expect(executor.dispatches).toEqual([]);
    expect(policy.escalations).toEqual(["contract-conflict"]);
    const persisted = decisions(store.all("run:handoff"));
    expect(persisted.map((decision) => decision.decisionKind)).toEqual([
      "reconciliation",
      "escalation",
    ]);
    expect(persisted[1]?.inputs).toEqual([
      "contract-conflict",
      "reconciliation",
      "api",
      "p-conflict",
    ]);
  });

  it("records retry escalation without replaying reconciliation", async () => {
    const store = new MemoryKnowledgeStore();
    const executor = new RecordingExecutor();
    const plan: ReconciliationPlan = {
      ...NO_CHANGE,
      escalate: true,
    };
    const policy = new RecordingPolicy(() => plan, {
      kind: "retry",
      delayMs: 25,
    });

    const result = await newSupervisor(store, executor).run(
      spec("retry", [task("t1")], undefined, [
        proposalEnvelope("p-retry", "retry", "api"),
      ]),
      policy
    );

    expect(result.status).toBe("completed");
    expect(executor.dispatches).toEqual(["t1"]);
    expect(policy.changes).toHaveLength(1);
    expect(policy.escalations).toEqual(["contract-conflict"]);
    expect(
      decisions(store.all("run:retry")).map(
        (decision) => decision.decisionKind
      )
    ).toEqual(["reconciliation", "escalation", "assignment"]);
  });

  it("preserves legacy behavior when no proposed contracts exist", async () => {
    const store = new MemoryKnowledgeStore();
    const executor = new RecordingExecutor();
    const policy = new RecordingPolicy();

    const result = await newSupervisor(store, executor).run(
      spec("legacy"),
      policy
    );

    expect(result.status).toBe("completed");
    expect(result.taskOutcomes).toHaveLength(1);
    expect(policy.changes).toEqual([]);
    expect(reconciliations(store.all("run:legacy"))).toEqual([]);
  });

  it("reconciles seeded proposals even when the task list is empty", async () => {
    const store = new MemoryKnowledgeStore();
    const policy = new RecordingPolicy();

    const result = await newSupervisor(
      store,
      new RecordingExecutor()
    ).run(
      spec("empty-tasks", [], undefined, [
        proposalEnvelope("p-empty", "empty-tasks", "api"),
      ]),
      policy
    );

    expect(result.status).toBe("completed");
    expect(result.taskOutcomes).toEqual([]);
    expect(policy.changes).toHaveLength(1);
    expect(reconciliations(store.all("run:empty-tasks"))).toHaveLength(1);
  });

  it("durably records the complete plan in FilesystemKnowledgeStore", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "fleet-reconciliation-")
    );
    const store = new FilesystemKnowledgeStore({ rootDir });
    const proposal = proposalEnvelope("p-durable", "durable", "api");
    const oldProposal = proposalEnvelope("old-proposal", "durable", "api");
    const plan: ReconciliationPlan = {
      ratified: { ...payloadOf(proposal), status: "ratified" },
      rejectIds: ["old-proposal"],
      pauseTasks: ["paused-task"],
      escalate: false,
    };
    const policy = new RecordingPolicy(() => plan);

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("durable", [task("paused-task")], undefined, [proposal, oldProposal]),
      policy
    );

    const entries: KnowledgeEnvelope[] = [];
    for await (const entry of store.query({ scope: "run:durable" })) {
      entries.push(entry);
    }
    expect(reconciliations(entries)).toHaveLength(1);
    expect(reconciliations(entries)[0]?.outcome).toEqual(plan);
  });

  it("appends exact ratified and rejected children for proposal envelope IDs", async () => {
    const store = new MemoryKnowledgeStore();
    const selected = proposalEnvelope("p-selected", "actions", "api");
    const rejected = proposalEnvelope("p-rejected", "actions", "api");
    const policy = new RecordingPolicy(() => ({
      ratified: { ...payloadOf(selected), status: "ratified" },
      rejectIds: [rejected.id],
      pauseTasks: [],
      escalate: false,
    }));

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("actions", [], undefined, [selected, rejected]),
      policy
    );

    const appended = contracts(store.all("run:actions")).slice(2);
    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatchObject({
      key: selected.key,
      version: selected.version + 1,
      parentId: selected.id,
      payload: { ...payloadOf(selected), status: "ratified" },
    });
    expect(appended[1]).toMatchObject({
      key: rejected.key,
      version: rejected.version + 1,
      parentId: rejected.id,
      payload: { ...payloadOf(rejected), status: "rejected" },
    });
    expect(appended[0]?.id).not.toBe(selected.id);
    expect(appended[1]?.id).not.toBe(rejected.id);
  });

  it("blocks a queued sequential task and never dispatches it", async () => {
    const store = new MemoryKnowledgeStore();
    const executor = new RecordingExecutor();
    const proposal = proposalEnvelope("p-pause", "pause-sequential", "api");
    const policy = new RecordingPolicy(() => ({
      ...NO_CHANGE,
      pauseTasks: ["t2"],
    }));

    const result = await newSupervisor(store, executor).run(
      spec("pause-sequential", [task("t1"), task("t2")], undefined, [proposal]),
      policy
    );

    expect(result.status).toBe("failed");
    expect(executor.dispatches).toEqual(["t1"]);
    expect(taskStates(store.all("run:pause-sequential"))).toContainEqual(
      expect.objectContaining({
        key: "t2",
        payload: expect.objectContaining({ taskId: "t2", state: "blocked" }),
      })
    );
  });

  it("blocks a queued fan-out batch for every repo", async () => {
    const store = new MemoryKnowledgeStore();
    const executor = new RecordingExecutor();
    const proposal = proposalEnvelope("p-fanout-pause", "pause-fanout", "api");
    const policy = new RecordingPolicy(() => ({
      ...NO_CHANGE,
      pauseTasks: ["batch-2"],
    }));
    const runSpec = fanOutSpec(
      "pause-fanout",
      [task("batch-1"), task("batch-2")],
      [proposal]
    );
    runSpec.repos = [
      { name: "repo-a", path: "/tmp/repo-a" },
      { name: "repo-b", path: "/tmp/repo-b" },
    ];

    const result = await newSupervisor(store, executor).run(runSpec, policy);

    expect(result.status).toBe("failed");
    expect(executor.dispatches).toEqual(["batch-1", "batch-1"]);
  });

  it("rejects an invalid action plan before writing any decision or action", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-invalid", "invalid-plan", "api");
    const policy = new RecordingPolicy(() => ({
      ratified: null,
      rejectIds: ["not-in-this-group"],
      pauseTasks: ["missing-task"],
      escalate: false,
    }));

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("invalid-plan", [task("known-task")], undefined, [proposal]),
      policy
    )).rejects.toThrow(/reconciliation/i);

    expect(decisions(store.all("run:invalid-plan"))).toEqual([]);
    expect(contracts(store.all("run:invalid-plan"))).toEqual([proposal]);
    expect(taskStates(store.all("run:invalid-plan"))).toEqual([]);
  });

  it("rejects an envelope ID outside the current proposal group", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-reject-scope", "reject-scope", "api");

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("reject-scope", [], undefined, [proposal]),
      new RecordingPolicy(() => ({
        ...NO_CHANGE,
        rejectIds: ["foreign-proposal"],
      }))
    )).rejects.toThrow(/outside the current group/i);
    expect(reconciliations(store.all("run:reject-scope"))).toEqual([]);
  });

  it("rejects an unknown queued-task reference independently", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-task-scope", "task-scope", "api");

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("task-scope", [task("known")], undefined, [proposal]),
      new RecordingPolicy(() => ({
        ...NO_CHANGE,
        pauseTasks: ["unknown"],
      }))
    )).rejects.toThrow(/unknown task/i);
    expect(reconciliations(store.all("run:task-scope"))).toEqual([]);
  });

  it("rejects a synthesized ratification that does not exactly select a proposal", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-synthetic", "synthetic", "api");

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("synthetic", [], undefined, [proposal]),
      new RecordingPolicy(() => ({
        ...NO_CHANGE,
        ratified: {
          ...payloadOf(proposal),
          after: { proposal: "different" },
          status: "ratified",
        },
      }))
    )).rejects.toThrow(/does not exactly select/i);
    expect(reconciliations(store.all("run:synthetic"))).toEqual([]);
  });

  it("rejects a plan that tries to pause an already settled task", async () => {
    const store = new MemoryKnowledgeStore();
    const executor = new RecordingExecutor(async (workerSpec) => {
      await workerSpec.knowledgeHandle.store.append(
        workerSpec.knowledgeHandle.scope,
        proposalEnvelope("p-late-pause", "settled-pause", "api")
      );
    });
    const policy = new RecordingPolicy(() => ({
      ...NO_CHANGE,
      pauseTasks: ["t1"],
    }));

    await expect(newSupervisor(store, executor).run(
      spec("settled-pause", [task("t1")]),
      policy
    )).rejects.toThrow(/settled/i);
    expect(reconciliations(store.all("run:settled-pause"))).toEqual([]);
  });

  it("applies lifecycle actions before invoking escalation", async () => {
    const store = new MemoryKnowledgeStore();
    const selected = proposalEnvelope("p-order", "action-order", "api");
    const policy = new RecordingPolicy(() => ({
      ratified: { ...payloadOf(selected), status: "ratified" },
      rejectIds: [],
      pauseTasks: ["t1"],
      escalate: true,
    }));

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("action-order", [task("t1")], undefined, [selected]),
      policy
    );

    expect(store.all("run:action-order").map((entry) => entry.kind)).toEqual([
      "contract",
      "decision",
      "contract",
      "task-state",
      "decision",
    ]);
  });

  it("does not duplicate a recorded no-action plan on a fresh supervisor replay", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-no-action", "no-action-replay", "api");
    const firstPolicy = new RecordingPolicy();
    const secondPolicy = new RecordingPolicy();

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("no-action-replay", [], undefined, [proposal]),
      firstPolicy
    );
    await newSupervisor(store, new RecordingExecutor()).run(
      spec("no-action-replay", []),
      secondPolicy
    );

    expect(reconciliations(store.all("run:no-action-replay"))).toHaveLength(1);
    expect(firstPolicy.changes).toHaveLength(1);
    expect(secondPolicy.changes).toEqual([]);
  });

  it("does not duplicate applied actions on a fresh supervisor replay", async () => {
    const store = new MemoryKnowledgeStore();
    const selected = proposalEnvelope("p-replay", "action-replay", "api");
    const plan: ReconciliationPlan = {
      ratified: { ...payloadOf(selected), status: "ratified" },
      rejectIds: [],
      pauseTasks: ["t1"],
      escalate: false,
    };

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("action-replay", [task("t1")], undefined, [selected]),
      new RecordingPolicy(() => plan)
    );
    await newSupervisor(store, new RecordingExecutor()).run(
      spec("action-replay", [task("t1")]),
      new RecordingPolicy(() => plan)
    );

    expect(reconciliations(store.all("run:action-replay"))).toHaveLength(1);
    expect(contracts(store.all("run:action-replay"))).toHaveLength(2);
    expect(taskStates(store.all("run:action-replay"))).toHaveLength(1);
  });

  it("uses the recorded plan instead of soliciting a conflicting replay", async () => {
    const store = new MemoryKnowledgeStore();
    const proposal = proposalEnvelope("p-conflict-replay", "conflict-replay", "api");

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("conflict-replay", [], undefined, [proposal]),
      new RecordingPolicy()
    );

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("conflict-replay", []),
      new RecordingPolicy(() => ({ ...NO_CHANGE, escalate: true }))
    )).resolves.toMatchObject({ status: "completed" });
    expect(reconciliations(store.all("run:conflict-replay"))).toHaveLength(1);
  });

  it("resumes a partially applied decision without duplicating prior actions", async () => {
    const store = new RejectTransitionFailOnceStore();
    const selected = proposalEnvelope("p-partial-selected", "partial-actions", "api");
    const rejected = proposalEnvelope("p-partial-rejected", "partial-actions", "api");
    const plan: ReconciliationPlan = {
      ratified: { ...payloadOf(selected), status: "ratified" },
      rejectIds: [rejected.id],
      pauseTasks: [],
      escalate: false,
    };

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("partial-actions", [], undefined, [selected, rejected]),
      new RecordingPolicy(() => plan)
    )).rejects.toThrow("injected rejected-transition failure");

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("partial-actions", []),
      new RecordingPolicy(() => plan)
    )).resolves.toMatchObject({ status: "completed" });

    expect(reconciliations(store.all("run:partial-actions"))).toHaveLength(1);
    expect(contracts(store.all("run:partial-actions"))).toHaveLength(4);
  });

  it("fails closed when a deterministic decision key contains conflicting bytes", async () => {
    const proposal = proposalEnvelope("p-key-conflict", "key-conflict", "api");
    const expected = buildReconciliationDecisionEnvelope({
      runId: "key-conflict",
      surface: "api",
      proposalIds: [proposal.id],
      policyId: "recording-reconciliation",
      plan: NO_CHANGE,
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const conflict: KnowledgeEnvelope = {
      ...expected,
      payload: {
        ...(expected.payload as DecisionPayload),
        policyId: "different-policy",
      },
    };
    const store = new ConflictingDecisionReadStore(conflict);

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("key-conflict", [], undefined, [proposal]),
      new RecordingPolicy()
    )).rejects.toThrow(/different bytes/i);
    expect(decisions(store.all("run:key-conflict"))).toEqual([]);
  });

  it("fails closed when a scoped reconciliation decision belongs to another run", async () => {
    const proposal = proposalEnvelope("p-wrong-decision-run", "decision-run", "api");
    const decision = buildReconciliationDecisionEnvelope({
      runId: "another-run",
      surface: "api",
      proposalIds: [proposal.id],
      policyId: "recording-reconciliation",
      plan: NO_CHANGE,
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const store = new MemoryKnowledgeStore();

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("decision-run", [], undefined, [proposal, decision]),
      new RecordingPolicy()
    )).rejects.toThrow(/belongs to run/i);
  });

  it("fails closed when a recorded decision repeats a proposal ID", async () => {
    const proposal = proposalEnvelope("p-duplicate-decision", "duplicate-decision", "api");
    const decision = buildReconciliationDecisionEnvelope({
      runId: "duplicate-decision",
      surface: "api",
      proposalIds: [proposal.id, proposal.id],
      policyId: "recording-reconciliation",
      plan: NO_CHANGE,
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const store = new MemoryKnowledgeStore();

    await expect(newSupervisor(store, new RecordingExecutor()).run(
      spec("duplicate-decision", [], undefined, [proposal, decision]),
      new RecordingPolicy()
    )).rejects.toThrow(/proposalIds contains duplicate IDs/i);
  });

  it("applies append-only actions durably in FilesystemKnowledgeStore", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-actions-"));
    const store = new FilesystemKnowledgeStore({ rootDir });
    const selected = proposalEnvelope("p-fs-selected", "fs-actions", "api");
    const rejected = proposalEnvelope("p-fs-rejected", "fs-actions", "api");
    const plan: ReconciliationPlan = {
      ratified: { ...payloadOf(selected), status: "ratified" },
      rejectIds: [rejected.id],
      pauseTasks: ["t1"],
      escalate: false,
    };

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("fs-actions", [task("t1")], undefined, [selected, rejected]),
      new RecordingPolicy(() => plan)
    );

    const entries: KnowledgeEnvelope[] = [];
    for await (const entry of store.query({ scope: "run:fs-actions" })) {
      entries.push(entry);
    }
    expect(contracts(entries)).toHaveLength(4);
    expect(taskStates(entries)).toHaveLength(1);
    expect(reconciliations(entries)).toHaveLength(1);
  });
});
