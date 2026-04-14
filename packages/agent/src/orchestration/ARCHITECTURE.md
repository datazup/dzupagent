# Orchestration Architecture (`@dzupagent/agent`)

Last validated: April 4, 2026

## 1) Scope

This document describes the orchestration subsystem in:

- `packages/agent/src/orchestration/*`

It covers:

- feature set and design intent
- control/data flow for each orchestration pattern
- usage examples
- references from other packages
- current test coverage and important caveats

## 2) Module Map

### Core entrypoints

- `index.ts`
  - local barrel for orchestration exports
- `orchestration-error.ts`
  - shared error type with pattern tagging
- `orchestrator.ts`
  - high-level orchestration patterns: `sequential`, `parallel`, `supervisor`, `debate`, `contractNet`
- `map-reduce.ts`
  - chunked parallel execution with bounded concurrency
- `merge-strategies.ts`
  - built-in merge functions used by map-reduce and peer execution
- `delegation.ts`
  - typed supervisor-to-specialist delegation protocol (`SimpleDelegationTracker`)
- `delegating-supervisor.ts`
  - supervisor wrapper over delegation tracker with goal decomposition
- `planning-agent.ts`
  - DAG plan build/validate/decompose/execute

### Submodules

- `contract-net/*`
  - bid model, evaluation strategies, and protocol manager
- `topology/*`
  - topology recommendation and execution (`mesh`, `ring`, plus routing to orchestrator patterns)

## 3) Dependency Boundaries

The orchestration folder is intentionally layered:

- LLM execution boundary: `DzupAgent.generate(...)` and `DzupAgent.asTool()`
- Core runtime boundary: `@dzupagent/core` types/utilities
  - `RunStore`, `DzupEventBus` (delegation lifecycle)
  - `Semaphore` from `@dzupagent/core/orchestration` (map-reduce concurrency)
- Structured output boundary: `generateStructured(...)` + `zod` schemas in planning

No imports from `@dzupagent/server` are used inside this folder.

## 4) Public API Surface

The orchestration APIs are re-exported from package root:

- `packages/agent/src/index.ts`

This means consumers typically import from `@dzupagent/agent`, not deep paths.

## 5) Feature Breakdown

## 5.1 `OrchestrationError`

File: `orchestration-error.ts`

Purpose:

- standardizes orchestration failures with:
  - `message`
  - `pattern` discriminator (for telemetry/debug routing)
  - optional structured `context`

Used across all patterns for predictable failure typing.

---

## 5.2 `AgentOrchestrator`

File: `orchestrator.ts`

Implements five patterns:

1. `sequential(agents, initialInput)`
   - linear handoff: each agent receives previous output
2. `parallel(agents, input, merge?)`
   - same input to all agents, then merge
3. `supervisor(config)` (plus deprecated positional overload)
   - manager agent gets specialist tools (`asTool`) and delegates via tool-calling
4. `debate(proposers, judge, task, { rounds })`
   - iterative proposal rounds, judge chooses/synthesizes
5. `contractNet(config)`
   - thin delegator to `ContractNetManager.execute`

### Supervisor flow

```text
validate config -> optional specialist health check
-> convert specialists to tools
-> create manager clone with injected tools + supervisor instructions
-> manager.generate(task)
-> return synthesized output (+ metadata in config overload)
```

Notable behavior:

- health check path filters specialists by `asTool()` success
- supports `AbortSignal`
- legacy positional overload returns `string`; config overload returns `SupervisorResult`

---

## 5.3 Map-Reduce and Merge Strategies

Files:

- `map-reduce.ts`
- `merge-strategies.ts`

Capabilities:

- `mapReduce(agent, chunks, config?)`
  - single agent reused across all chunks
- `mapReduceMulti(tasks, config?)`
  - heterogeneous `(agent, input)` task list
- bounded concurrency via `Semaphore`
- non-fatal chunk failure model
  - uses `Promise.allSettled`
  - failed chunks recorded, successful chunks still merged

Built-in merge functions:

- `concatMerge`
- `voteMerge`
- `numberedMerge`
- `jsonArrayMerge`
- lookup with `getMergeStrategy(name)`

Flow:

```text
validate concurrency -> resolve merge fn
-> execute each task with semaphore
-> collect settled results
-> keep successful outputs in chunk order
-> merge outputs
-> return result + per-agent stats + durations
```

---

## 5.4 Contract-Net Protocol

Files:

- `contract-net/contract-net-types.ts`
- `contract-net/bid-strategies.ts`
- `contract-net/contract-net-manager.ts`

Lifecycle:

1. manager announces CFP
2. specialists submit bids (JSON response expected)
3. bids are ranked by strategy
4. best bidder is awarded
5. winner executes task
6. result returned

Strategies:

- `lowestCostStrategy`
- `fastestStrategy`
- `highestQualityStrategy`
- `createWeightedStrategy({ cost, speed, quality })`

Operational details:

- per-bid deadline enforcement (abort-race wrapper)
- optional retry on no bids
- event bus emissions via `protocol:message_sent` with `messageType` tags

---

## 5.5 Delegation Protocol (`SimpleDelegationTracker`)

File: `delegation.ts`

Core contract:

- input: `DelegationRequest`
- output: `DelegationResult`
- executor callback: `DelegationExecutor(runId, agentId, input, signal)`

Responsibilities:

- create child run in `RunStore`
- mark run status transitions (`running`, `completed`/`failed`/`cancelled`)
- track active delegations
- timeout and cancellation handling via `AbortController`
- emit lifecycle events (`delegation:started`, `completed`, `failed`, `timeout`, `cancelled`)

Flow:

```text
create run -> register active delegation
-> launch executor
-> wait for (executor completion OR abort)
-> read final run state
-> emit terminal event + return DelegationResult
-> cleanup active map entry
```

---

## 5.6 `DelegatingSupervisor`

File: `delegating-supervisor.ts`

Role:

- typed supervisor facade over `DelegationTracker`
- specialists are registry entries (`Map<string, AgentDefinition>`)

Main methods:

1. `delegateTask(task, specialistId, input)`
   - single delegation with events
2. `delegateAndCollect(assignments[])`
   - parallel delegations, all-settled aggregation
3. `planAndDelegate(goal, options?)`
   - LLM-first decomposition path via `PlanningAgent`
   - keyword/tag fallback decomposition on failure or when no LLM provided

Matching heuristic (fallback mode):

- specialist id/name match
- metadata tags
- tool-name overlap
- built-in keyword category map (`database`, `api`, `ui`, `test`, `security`, `deploy`)

---

## 5.7 `PlanningAgent` (DAG Planning + Execution)

File: `planning-agent.ts`

Features:

- `buildExecutionLevels(nodes)` (Kahn topological layering)
- `validatePlanStructure(plan, availableSpecialists?)`
- `PlanningAgent.buildPlan(goal, tasks)`
- `planningAgent.decompose(goal, llm, options?)`
  - structured LLM output (`zod` schema)
  - filters unknown specialists
  - removes dangling dependencies
  - recomputes execution levels
- `planningAgent.executePlan(plan)`
  - executes by level
  - per-level chunking by `maxParallelism`
  - injects predecessor outputs into child inputs (`_predecessorResults`)
  - skips descendants of failed nodes

Execution model:

```text
validate plan
-> for each level:
  - mark nodes with failed deps as skipped
  - execute runnable nodes in chunks
  - collect delegation results
  - mark failures and propagate skip ancestry
-> return full PlanExecutionResult
```

---

## 5.8 Topology Analysis + Execution

Files:

- `topology/topology-types.ts`
- `topology/topology-analyzer.ts`
- `topology/topology-executor.ts`

Topologies:

- `hierarchical`
- `pipeline`
- `star`
- `mesh`
- `ring`

Analyzer:

- heuristic scoring from `TaskCharacteristics`
- returns recommendation + confidence + ranked alternatives

Executor:

- native implementations:
  - `executeMesh`
  - `executeRing`
- routed implementations via `AgentOrchestrator`:
  - `pipeline` -> `sequential`
  - `star` -> `parallel`
  - `hierarchical` -> `supervisor`
- optional auto-switch on high error rate

## 6) End-to-End Pattern Flows

## A) Supervisor + Delegation stack

```text
Client
  -> DelegatingSupervisor.planAndDelegate(goal, llm?)
    -> PlanningAgent.decompose(...) OR keyword decomposition
    -> PlanningAgent.executePlan(...)
      -> DelegatingSupervisor.delegateAndCollect(...)
        -> SimpleDelegationTracker.delegate(...)
          -> RunStore + executor + events
```

## B) Contract-net stack

```text
AgentOrchestrator.contractNet(config)
  -> ContractNetManager.execute(config)
    -> collect bids -> strategy rank -> award -> execute winner
```

## C) Topology stack

```text
TopologyAnalyzer.analyze(chars) -> topology recommendation
TopologyExecutor.execute({ topology, ... })
  -> mesh/ring direct OR pipeline/star/hierarchical through AgentOrchestrator
```

## 7) Usage Examples

## 7.1 Supervisor orchestration

```ts
import { AgentOrchestrator, DzupAgent } from '@dzupagent/agent'

const result = await AgentOrchestrator.supervisor({
  manager: managerAgent,
  specialists: [dbAgent, apiAgent, uiAgent],
  task: 'Build user profile feature end-to-end',
  healthCheck: true,
})

console.log(result.content)
console.log(result.availableSpecialists)
```

## 7.2 Map-reduce over chunked input

```ts
import { mapReduce, numberedMerge } from '@dzupagent/agent'

const chunks = ['part A', 'part B', 'part C']

const out = await mapReduce(workerAgent, chunks, {
  concurrency: 3,
  mergeStrategy: 'custom',
  customMerge: numberedMerge,
})

console.log(out.result)
console.log(out.stats)
```

## 7.3 Contract-net with weighted strategy

```ts
import { ContractNetManager, createWeightedStrategy } from '@dzupagent/agent'

const result = await ContractNetManager.execute({
  manager: managerAgent,
  specialists: [agentA, agentB, agentC],
  task: 'Produce migration plan',
  strategy: createWeightedStrategy({ cost: 0.2, speed: 0.3, quality: 0.5 }),
  bidDeadlineMs: 10_000,
})
```

## 7.4 Planning DAG execution

```ts
import {
  PlanningAgent,
  DelegatingSupervisor,
  SimpleDelegationTracker,
} from '@dzupagent/agent'

const supervisor = new DelegatingSupervisor({
  specialists,
  tracker,
  eventBus,
})

const planner = new PlanningAgent({ supervisor, maxParallelism: 4 })
const plan = PlanningAgent.buildPlan('Ship feature', [
  { task: 'Design schema', specialistId: 'db-agent', input: {}, dependsOn: [] },
  { task: 'Build API', specialistId: 'api-agent', input: {}, dependsOn: ['node-0'] },
])

const execution = await planner.executePlan(plan)
```

## 7.5 Topology recommendation + execution

```ts
import { TopologyAnalyzer, TopologyExecutor } from '@dzupagent/agent'

const analyzer = new TopologyAnalyzer()
const rec = analyzer.analyze({
  subtaskCount: 4,
  interdependence: 0.8,
  iterativeRefinement: 0.2,
  coordinationComplexity: 0.7,
  speedPriority: 0.4,
  sequentialNature: 0.2,
})

const result = await TopologyExecutor.execute({
  topology: rec.recommended,
  agents,
  task: 'Solve distributed planning problem',
  autoSwitch: true,
  errorThreshold: 0.5,
})
```

## 8) References in Other Packages

The orchestration primitives are primarily consumed inside `@dzupagent/agent`, with selective cross-package coupling:

1. **`packages/agent/src/playground/team-coordinator.ts`**
   - runtime use of `AgentOrchestrator.supervisor` and `AgentOrchestrator.parallel`
   - runtime use of `getMergeStrategy(...)`
2. **`packages/workflow-domain/src/services/plan-task-bridge.ts`**
   - introduces `PlanNodeLike` shape compatible with `PlanningAgent` plan nodes
   - imports are intentionally structural to avoid hard package coupling
3. **`packages/server/src/routes/workflows.ts`**
   - `/runs/:id/import-plan` endpoint accepts `PlanNodeLike[]`
   - uses `PlanTaskBridge` to import planning DAGs into workflow task graphs

Additional note:

- `packages/domain-nl2sql/src/workflows/index.ts` documents `AgentOrchestrator.supervisor` usage as an integration pattern (comment-level reference).

## 9) Test Coverage (Executed)

Executed on April 4, 2026:

- command:  
  `yarn workspace @dzupagent/agent test src/__tests__/orchestrator-patterns.test.ts src/__tests__/supervisor.test.ts src/__tests__/map-reduce.test.ts src/__tests__/contract-net.test.ts src/__tests__/delegation.test.ts src/__tests__/delegating-supervisor.test.ts src/__tests__/planning-agent.test.ts src/__tests__/plan-decomposition.test.ts src/__tests__/topology.test.ts`
- result: **9/9 files passed, 189/189 tests passed**

Suite breakdown:

- `orchestrator-patterns.test.ts` (30)
  - sequential/parallel/supervisor/debate behavior and error propagation
- `supervisor.test.ts` (8)
  - tool wiring, health check, abort, legacy signature
- `map-reduce.test.ts` (37)
  - concurrency bounds, partial failure, merge behavior, abort handling
- `contract-net.test.ts` (18)
  - strategy ordering, retry/no-bid, deadline, event emission, execution failure
- `delegation.test.ts` (22)
  - run-store lifecycle, timeout/cancel/failure events, active delegation tracking
- `delegating-supervisor.test.ts` (15)
  - delegation aggregation, specialist matching, planning fallback events
- `planning-agent.test.ts` (24)
  - DAG construction/validation, skip propagation, predecessor context, chunking
- `plan-decomposition.test.ts` (13)
  - schema validation, LLM decomposition sanitation/filtering, fallback to keywords
- `topology.test.ts` (22)
  - analyzer recommendations, mesh/ring execution, auto-switch, metrics, abort

## 10) Known Constraints and Gaps

1. `PlanningAgent.executePlan(...)` maps aggregated results by `specialistId`.
   - If multiple nodes in the same chunk share one specialist ID, results can collide.
2. `DelegatingSupervisor.planAndDelegate(...)` (LLM path) builds `succeeded/failed` arrays from node IDs, while `AggregatedDelegationResult` docs describe specialist IDs.
3. `MapReduceConfig.mergeStrategy` string union omits `'numbered'` and `'json'`, although `getMergeStrategy(...)` supports both.
4. `ContractNetConfig.manager` is accepted but currently unused by `ContractNetManager.execute(...)` runtime logic.
5. Topology executor metric semantics differ by topology:
   - some paths return partial-error metrics (`mesh`, `ring`)
   - routed paths (`pipeline`, `star`, `hierarchical`) currently assume `errorCount: 0` unless they throw.

These are important when extending orchestration behavior or relying on strict metric semantics.

## 11) Practical Extension Guidance

1. Reuse `OrchestrationError` with a precise `pattern` and contextual metadata.
2. Keep execution engines side-effect-light; push lifecycle persistence into `RunStore` + tracker.
3. For new planner features, preserve DAG invariants (`validatePlanStructure` + topological levels).
4. When adding new merge strategies, register via `getMergeStrategy` and add map-reduce tests for:
   - ordering
   - empty input
   - mixed success/failure behavior.

