import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import { FleetSupervisor } from "../fleet-supervisor.js";
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
      spec("complete-plan", [], undefined, [proposal]),
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
      { surface: "api", proposals: [payloadOf(valid)] },
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
    const plan: ReconciliationPlan = {
      ratified: { ...payloadOf(proposal), status: "ratified" },
      rejectIds: ["old-proposal"],
      pauseTasks: ["paused-task"],
      escalate: false,
    };
    const policy = new RecordingPolicy(() => plan);

    await newSupervisor(store, new RecordingExecutor()).run(
      spec("durable", [], undefined, [proposal]),
      policy
    );

    const entries: KnowledgeEnvelope[] = [];
    for await (const entry of store.query({ scope: "run:durable" })) {
      entries.push(entry);
    }
    expect(reconciliations(entries)).toHaveLength(1);
    expect(reconciliations(entries)[0]?.outcome).toEqual(plan);
  });
});
