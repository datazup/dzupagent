# @dzupagent/subagents

Governed async background subagents for DzupAgent — spawn a subagent, get a task
id immediately, keep working, collect the result later. Portable (in-process or
durable queue), policy-gated, HITL-aware, checkpointer-backed.

See [`OWN-WRAP-CONVERGE.md`](./OWN-WRAP-CONVERGE.md) for the boundary policy.

## Quick start

```ts
import {
  createInProcessSubagentRuntime,
  createSubagentTools,
  OrchestratorBackgroundApi,
} from "@dzupagent/subagents";

// 1. Wire the runtime. The only required input is an executor (how a subagent
//    actually runs) and an event sink.
const runtime = createInProcessSubagentRuntime({
  executor: {
    run: async (spec, ctx) => ({ output: await myAgent.run(spec.input, ctx) }),
  },
  events: { emit: (e) => bus.emit(e) },
  // Optional governance:
  // policy: { check: (spec, runId) => myPolicyEngine.checkSpawn(spec, runId) },
  // approvalGate: hitlApprovalGate,
});
runtime.start(); // begins the TTL/GC sweep

// 2a. Programmatic surface
const api = new OrchestratorBackgroundApi(runtime);
const { handle } = await api.spawn(
  { agentId: "researcher", input: "survey X" },
  "run-1"
);
const result = await handle!.result({ timeoutMs: 60_000 });

// 2b. LLM-facing tools
const tools = createSubagentTools({
  runtime,
  resolveParentRunId: () => currentRunId,
});
// adapt `tools` to your model's tool type and bind them
```

## Lifecycle controls

`maxConcurrentBackground`, `maxQueuedTasks`, `defaultTtlMs`, `retentionMs`,
`gcIntervalMs` — see `DEFAULT_LIFECYCLE_POLICY`. Background tasks are a bounded
stock: TTL expiry, retention GC, and concurrency admission keep the store from
growing without limit.

## Seams (all injectable, all with in-memory defaults)

`TaskRunner` (execution) · `TaskStore` (persistence) · `CheckpointerPort`
(resumability) · `SubagentExecutorPort` (the actual agent run) · `SpawnPolicy` +
`SpawnApprovalGate` (governance).
