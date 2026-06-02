# Design Spec — `@dzupagent/subagents`: Governed Async Background Subagents

**Date:** 2026-06-01
**Status:** Approved (brainstorming) → ready for implementation plan
**Author:** session (ninel.hodzic)
**Companion research:** `claudedocs/research_langchain_v1_dzupagent_2026-06-01.md`
**Strategic basis:** Business panel synthesis — _"Stop paying to own commodities; spend that capacity making 'governed autonomous agents that run anywhere' the thing only you do."_ Async subagents is the one identified **moat** (the other three LangChain-v1 moves are hygiene that funds it).

---

## 1. Problem & Goal

dzupagent has rich **blocking/inline** multi-agent orchestration (`SupervisorOrchestrator`, `MapReduceOrchestrator`, `ContractNetOrchestrator`, `ParallelExecutor`) but **no async/background subagent surface**: there is no way to spawn a subagent, get a handle back immediately, keep the main agent (or caller) working, and collect the result later. LangChain's deepagents v1.9 ships this — but only on their **alpha** runtime and requires **LangSmith hosted deployment**.

**Goal:** a first-class, **owned**, **portable**, **governed** background-subagent runtime that runs anywhere (in-process or durable-queue), under dzupagent's existing policy engine, HITL approval gates, checkpointer, and event bus — depending on **nothing alpha or hosted**.

**Non-goals:** replacing inline orchestrators (they coexist); building a distributed scheduler (the durable tier delegates to a pluggable queue); remote sandbox execution of subagents (the runner interface allows it later, not in this spec).

---

## 2. Strategic Constraints (panel non-negotiables — baked into the design)

1. **Native + portable** — borrow deepagents' _protocol shape_ only; depend on no alpha/hosted package. (Taleb antifragility)
2. **Governed (the JTBD)** — spawn passes the policy engine + optional HITL gate; this _is_ the moat, not the bare feature. (Christensen/Porter)
3. **Lifecycle-stock design first** — TTL, max-concurrency, dead-task GC designed before the feature ships; background tasks are an accumulating stock with a bounded outflow. (Meadows)
4. **Documented exit cost** — every upstream/external seam is an interface with an in-memory default shipped, rip-out-able in a sprint. (Taleb barbell)
5. **Explicit own/wrap/converge boundary** — a policy doc in the package ties this decision to the capability matrix, re-evaluated each upstream release. (Meadows highest-leverage)

---

## 3. Architecture & Package Boundary

### 3.1 New package `@dzupagent/subagents` — **layer 2 (domain)**, tier 2, status `supported`

The layer DAG (`config/architecture-boundaries.json`) forbids same-layer edges and only allows depending on lower layers. The checkpointer (`WorkflowCheckpointer`) lives in `agent-adapters` (**layer 4**). Therefore subagents **must not** import agent-adapters; it takes the checkpointer as an **injected port interface**. Resulting dependency set:

- `@dzupagent/core` (L1) — event bus, policy engine, error types, logger
- `@dzupagent/hitl-kit` (L0) — approval gate primitives
- `@dzupagent/adapter-types` (L0) — `GovernanceEvent`, `AgentEvent`, run-store contracts

This places `@dzupagent/subagents` cleanly in **layer 2**. `@dzupagent/agent-adapters` (L4) is the wiring point that injects the concrete Postgres checkpointer + the real agent runner. **`config/architecture-boundaries.json` layer 2 `packages` array gains `subagents`; `config/package-tiers.json` gains an `@dzupagent/subagents` tier-2 entry.**

### 3.2 Internal structure (each unit one purpose, tested against fakes)

```
@dzupagent/subagents/src
├── contracts/          # types + interfaces (no logic) — the seams
│   ├── background-task.ts        # BackgroundTask, TaskId, TaskStatus, SubagentSpec, SubagentResult
│   ├── task-runner.ts            # TaskRunner interface + RunnerCapabilities
│   ├── task-store.ts             # TaskStore interface + TaskFilter
│   ├── checkpointer-port.ts      # injected port (no agent-adapters import)
│   ├── subagent-executor-port.ts # injected port: how a SubagentSpec actually runs an agent
│   └── events.ts                 # subagent:* lifecycle events
├── runtime/
│   └── background-subagent-runtime.ts   # orchestrates spawn→govern→admit→run→persist→emit
├── runner/
│   ├── in-process-runner.ts      # default: async worker pool in same process
│   └── durable-queue-runner.ts   # opt-in: drains a pluggable queue (interface; in-mem queue default)
├── store/
│   └── in-memory-task-store.ts   # default TaskStore
├── governance/
│   └── spawn-gate.ts             # policy-engine check + optional HITL approval
├── lifecycle/
│   └── lifecycle-controller.ts   # admission (concurrency cap) + TTL sweep + dead-task GC + reconciler
├── tools/
│   └── subagent-tools.ts         # spawn_subagent / check_subagent / await_subagent / cancel_subagent
├── api/
│   └── orchestrator-background-api.ts   # programmatic surface (same runtime)
├── index.ts
└── __tests__/
```

---

## 4. Core Interfaces

```ts
// contracts/background-task.ts
export type TaskId = string;
export type TaskStatus =
  | "queued"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface SubagentSpec {
  /** Logical agent identity to dispatch; resolved by the injected executor port. */
  agentId: string;
  instructions?: string;
  input: string | Record<string, unknown>;
  /** Governance-relevant metadata the spawn-gate inspects. */
  outboundScope?: string[];
  memoryScope?: "global" | "workspace" | "project" | "agent";
}

export interface SubagentResult {
  output: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface BackgroundTask {
  id: TaskId;
  parentRunId: string;
  spec: SubagentSpec;
  status: TaskStatus;
  result?: SubagentResult;
  error?: string;
  createdAt: number;
  admittedAt?: number;
  startedAt?: number;
  endedAt?: number;
  ttlMs: number;
  checkpointRef?: string;
  approvalId?: string;
}

// contracts/task-runner.ts
export interface RunnerCapabilities {
  durable: boolean;
  horizontal: boolean;
}
export interface TaskRunner {
  /** Begin executing an already-admitted task. Persists progress/result via injected store. */
  start(taskId: TaskId, signal: AbortSignal): Promise<void>;
  capabilities(): RunnerCapabilities;
}

// contracts/task-store.ts
export interface TaskFilter {
  parentRunId?: string;
  status?: TaskStatus | TaskStatus[];
  endedBefore?: number; // for GC
}
export interface TaskStore {
  put(t: BackgroundTask): Promise<void>;
  get(id: TaskId): Promise<BackgroundTask | null>;
  list(filter: TaskFilter): Promise<BackgroundTask[]>;
  patch(id: TaskId, p: Partial<BackgroundTask>): Promise<void>;
}

// contracts/checkpointer-port.ts — injected; no agent-adapters dependency
export interface CheckpointerPort {
  save(taskId: TaskId, snapshot: unknown): Promise<string>; // returns checkpointRef
  load(checkpointRef: string): Promise<unknown | null>;
}

// contracts/subagent-executor-port.ts — injected; how a spec actually runs
export interface SubagentExecutorPort {
  run(
    spec: SubagentSpec,
    ctx: {
      taskId: TaskId;
      signal: AbortSignal;
      onProgress?: (note: string) => void;
      checkpointer?: CheckpointerPort;
    }
  ): Promise<SubagentResult>;
}
```

**Two independent seams** (per approved design): `TaskRunner` (execution) and `TaskStore` (persistence) are orthogonal — an in-process runner can use any store; a durable runner can use the in-memory store in tests. `SubagentExecutorPort` keeps the _actual agent invocation_ outside this package (wired by agent-adapters), preserving the layer boundary.

---

## 5. Events (compose with existing bus)

Following the existing `MapReduceRuntimeEvent` precedent, add to the adapter runtime event union:

```ts
export type SubagentRuntimeEvent =
  | {
      type: "subagent:spawned";
      taskId: TaskId;
      parentRunId: string;
      agentId: string;
    }
  | { type: "subagent:admitted"; taskId: TaskId }
  | { type: "subagent:progress"; taskId: TaskId; note: string }
  | { type: "subagent:completed"; taskId: TaskId; durationMs: number }
  | {
      type: "subagent:failed";
      taskId: TaskId;
      error: string;
      durationMs: number;
    }
  | { type: "subagent:cancelled"; taskId: TaskId }
  | { type: "subagent:expired"; taskId: TaskId };
```

Governance reuses the existing `GovernanceEvent` side-channel: `governance:approval_requested` / `governance:approval_resolved` on spawn approval; `governance:rule_violation` on policy denial. **No new governance event types invented.**

---

## 6. Data Flow

1. **Spawn** (tool or `OrchestratorBackgroundApi.spawn`) → build `BackgroundTask` (`queued`, ttl from per-spawn override or runtime default), `store.put`.
2. **Governance gate** (`spawn-gate`): policy-engine check (allowed `agentId`, `outboundScope`, per-parent concurrency). On denial → `governance:rule_violation`, task `failed`, typed denial returned (no throw). If HITL required → `governance:approval_requested`, status `awaiting_approval`; await resolution → `governance:approval_resolved` (approve → continue; reject → `cancelled`).
3. **Admission** (`lifecycle-controller`): enforce `maxConcurrentBackground`. If at cap → stays `queued` (backpressure); if `maxQueuedTasks` exceeded → typed "queue full" result to caller. On admit → `admittedAt`, emit `subagent:admitted` + `subagent:spawned`.
4. **Run** (`TaskRunner.start`): invokes `SubagentExecutorPort.run`; `onProgress` → `subagent:progress`; checkpointer snapshots → `checkpointRef`.
5. **Deliver** (pull + push): on success → `result` persisted, status `succeeded`, `subagent:completed`. On error → `failed`, `subagent:failed`. Caller pulls via `check_subagent`/`await_subagent`; subscribers react to events.
6. **GC** (`lifecycle-controller` sweep): past-TTL non-terminal → `expired` (+ free slot, `subagent:expired`); terminal tasks older than retention window → removed from store.

---

## 7. Failure Handling & Lifecycle Caps

| Concern                         | Policy                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process death (in-process tier) | Reconciler on startup scans store for orphaned `running`; durable runner resumes from `checkpointRef`; in-process marks `failed` with `checkpointRef` preserved (resumable later). |
| Concurrency                     | `maxConcurrentBackground` (default 4) gates admission.                                                                                                                             |
| Queue backpressure              | `maxQueuedTasks` (default 100) → typed "queue full" result (not throw); LLM/caller can react.                                                                                      |
| TTL                             | per-task `ttlMs` (default 15 min, per-spawn override); sweep expires.                                                                                                              |
| Retention                       | terminal tasks GC'd after `retentionMs` (default 1 h).                                                                                                                             |
| Sweep interval                  | `gcIntervalMs` (default 60 s); injectable timer for deterministic tests.                                                                                                           |
| Cancellation                    | `cancel_subagent` → `AbortSignal` → `subagent:cancelled`.                                                                                                                          |
| Exit cost                       | `TaskRunner`, `TaskStore`, `CheckpointerPort`, `SubagentExecutorPort` all interfaces with in-memory/default impls shipped.                                                         |

---

## 8. Interaction Surfaces (both)

**LLM-facing tools** (`StructuredToolInterface`, governed by the existing tool-governance preset):

- `spawn_subagent({ agentId, input, instructions?, ttlMs? }) → { taskId, status }`
- `check_subagent({ taskId }) → { status, result?, error? }`
- `await_subagent({ taskId, timeoutMs? }) → { status, result?, error? }`
- `cancel_subagent({ taskId }) → { status }`

**Programmatic** `OrchestratorBackgroundApi` over the same runtime: `spawn(spec, opts) → TaskHandle`, `get(taskId)`, `await(taskId, opts)`, `cancel(taskId)`, `list(filter)`. `TaskHandle` exposes `id`, `status()`, `result()` (promise), `cancel()`.

---

## 9. Testing Strategy

- **Unit** — runtime, spawn-gate, lifecycle-controller, in-process-runner, in-memory-store against fakes; injectable clock/timer (no real `Date.now()`/timers → deterministic; respects the workspace's no-`Date.now()` constraints in deterministic paths).
- **Contract suites** — `runTaskRunnerContract(factory)` and `runTaskStoreContract(factory)` that BOTH implementations must pass (barbell guarantee).
- **Integration** — happy path (spawn→approve→run→deliver), policy-denial, HITL-reject, concurrency-cap backpressure, TTL-expiry, orphan-reconcile, cancellation, pull+push parity.
- **Gates** — `yarn typecheck`, `yarn lint`, `yarn test` green for the package; `yarn check:package-tiers`, `yarn check:domain-boundaries`, `yarn check:circular-deps` pass with the new registrations.

---

## 10. Boundary Policy Artifact (Meadows leverage point)

`packages/subagents/OWN-WRAP-CONVERGE.md`: states _why subagents is owned_ (governance/portability moat), the **exit cost** per external seam, and the trigger to re-evaluate (each LangChain/deepagents release). Linked from the package README and referenced in the capability matrix.

---

## 11. Out of Scope / Follow-ups

- Postgres `TaskStore` + BullMQ/Redis `DurableQueueRunner` concrete impls (interfaces shipped here; concretes are follow-up wired in agent-adapters).
- Remote-sandbox subagent execution (runner interface permits; not built).
- Wiring `SubagentExecutorPort` to the real agent runtime in `agent-adapters` (separate packet; this spec ships the runtime + a fake executor for tests).
- Completion-callback middleware auto-injection (deferred until middleware convergence lands — Parallel-track B).

---

## 12. Sequencing (Parallel track B)

Depends only on: the first-only `wrapModelCall` bug being fixed (does **not** depend on full middleware convergence or StateSchema migration). Self-contained behind ports, so it ships regardless of those tracks' timing.
