# Boundary Policy — `@dzupagent/subagents`

> Why this capability is **owned** rather than adopted from upstream, and the
> **exit cost** of every external seam. Re-evaluate on each LangChain / LangGraph
> / deepagents release. (Meadows leverage point: make the own/wrap/converge rule
> explicit and self-correcting.)

## Verdict: OWN

Governed async/background subagents are the framework's **moat**, not a commodity.
LangChain deepagents ships async subagents, but only on an **alpha** runtime that
**requires LangSmith hosted deployment**. Our differentiation is structural and
defensible from where we sit:

- **Portable** — runs anywhere (in-process or durable queue) with no hosted
  dependency.
- **Governed** — every spawn passes the host policy engine and optional HITL
  approval gate; lifecycle events flow on the existing governance + runtime event
  buses.
- **Multi-provider** — the subagent executor is an injected port; nothing here is
  provider- or vendor-locked.

We borrow only the **protocol shape** (task-id handle, structured results,
completion notification) from deepagents. We depend on **nothing alpha or
hosted**.

## Injected seams and their exit cost

| Seam                                | Default shipped                                 | Exit cost if we must swap/remove                                                     |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `TaskRunner`                        | `InProcessRunner` + `DurableQueueRunner`        | Low — interface; a new substrate is one class + the runner contract suite.           |
| `TaskStore`                         | `InMemoryTaskStore`                             | Low — interface; Postgres impl is one class + the store contract suite.              |
| `CheckpointerPort`                  | `InMemoryCheckpointer`                          | Low — port forwards to the real `WorkflowCheckpointer` (wired in agent-adapters).    |
| `SubagentExecutorPort`              | (host-provided; fake in tests)                  | Low — keeps the agent runtime out of this layer; swap by re-implementing one method. |
| `SpawnPolicy` / `SpawnApprovalGate` | `allowAllSpawnPolicy` / hitl-kit `ApprovalGate` | Low — interfaces; host plugs in its policy engine.                                   |

Every seam ships an in-memory/default implementation, so the package is usable
standalone and any external dependency is **rip-out-able in a sprint** (Taleb
barbell).

## Layer position

`@dzupagent/subagents` is **layer 2 (domain)**. It depends only on layer-0
contracts (`adapter-types`, `hitl-kit`) and layer-1 foundation (`core`). It
**must not** import `agent-adapters` (layer 4, home of the concrete checkpointer
and agent runtime) — those are injected via ports. `agent-adapters` is the wiring
point that binds the real checkpointer + executor.

## Re-evaluation triggers

- A new deepagents release changes the async-subagent protocol → review whether
  our protocol shape should track it.
- LangChain ships a **portable, self-hostable, governed** async-subagent runtime
  → re-open the own-vs-wrap decision (the moat assumption would weaken).
- A provider ships server-side background execution that satisfies the governance
  JTBD → evaluate wrapping it behind `SubagentExecutorPort`.
