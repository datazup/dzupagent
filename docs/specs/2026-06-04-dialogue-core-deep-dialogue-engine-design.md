# Deep Dialogue Engine (`@dzupagent/dialogue-core`) — Design

**Date:** 2026-06-04
**Status:** Approved design (SP1 of a 4-sub-project program)
**Author:** ninel.hodzic (brainstormed with Claude)

---

## 0. Context & program decomposition

The workspace already has **four overlapping systems** that each partly do "Claude
challenges Codex," at very different maturity. Verified by reading the code:

- **`adapter-console` peer-dialogue** (codev-app) — production-wired multi-provider
  relay. `peer-dialogue-executor.adapter-caller.ts` actually executes live providers
  via `getOrCreateOrchestrator(tenant, providerId, modelId).run(...)`. The providers
  **actually registered in codev** (`adapter-registry.setup.ts`) are
  **`claude`, `codex`, `gemini`, `qwen`, `openrouter`**. (The wider framework catalog
  `dzupagent/packages/agent-adapters/src/provider-catalog.ts` also lists
  `crush`/`openai`/`gemini-sdk`, but those are **not** registered in codev — SP1 must
  not assume they are available.) Has a UI route
  (`/orchestration/peer-dialogue/:runId`), SLA monitor, telemetry, SSE, budget,
  pause/cancel/resume lifecycle, checkpoint tables, multi-tenant. **But it is a _talk_
  loop** — `orchestrator.run()` returns `{ result, usage }` (model text + token usage
  only), with **no native "implement" (it returns no workspace diff) and no "validate
  between turns."**
- **`flow-prompt-lab` DSL** — a real ~50KB runtime engine (`run_agent_flow.js`) with a
  canonical-ref verb table (`agent.codex.run`, `flow.loop.advance`, `flow.loop.init`),
  `lib/loop-state`, `lib/cost-meter`, `lib/validation`, and an `analyzer`
  (verifier/extractor/provenance-gap). `claude_orchestrates_gpt55.yaml` is a genuine
  plan→implement→review→decide loop that **edits the repo and runs validation**. **But
  it is CLI dev-tooling** — no product UI, single-tenant, no pause/resume.
- **`agent-planning:review:multi`** — parallel multi-repo planning, mixed providers
  per target. **But it is parallel _isolated_ runs** — `spawn`s N independent children,
  no shared state, no cross-repo reconciliation.
- **`scripts/fleet`** — multi-repo primitive, **mostly unwired**. Only `InProcessExecutor`
  (scripted no-op) + `CodexSubprocessExecutor` exist (no Claude executor). The
  supervisor `run()` only calls `assignTask` + `onWorkerComplete` — `onContractChange`
  / `onEscalation` are dead code. The knowledge store is **append-only** (nobody reads
  peers' decisions before acting). `pauseTask`/`cancelTask`/`reassign` throw
  `unimplementedControl`. Treat as Phase-2+ infrastructure, not a near-term path.

**Program (build order chosen by user):**

| #   | Sub-project              | One-line                                                                                                    | Builds on                           |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| SP1 | **Deep Dialogue Engine** | Claude↔Codex (+others) genuine multi-turn challenge/implement/review with full observability to debug _why_ | peer-dialogue + flow loop           |
| SP2 | **Orchestration DSL**    | declarative, easy-to-author flows composing any LLM agent/API into these dialogues                          | flow-prompt-lab DSL + codev editor  |
| SP3 | **Multi-Repo Scale**     | same orchestration across N repos in parallel + cross-repo decision reconciliation                          | review:multi + reconciler (+ fleet) |
| SP4 | **Enterprise Cockpit**   | author→run→observe→debug→ship, multi-tenant, in codev-app                                                   | all of the above                    |

**This document specifies SP1 only.** SP2–SP4 appear as forward seams (§5) so the
engine is built with their hooks in place. Each sub-project gets its own
spec → plan → implementation cycle.

---

## 1. Architecture & boundaries

A new provider-agnostic package — **`@dzupagent/dialogue-core`** (in `dzupagent/`,
where the framework primitives live) — owns the loop semantics and **nothing else**.
It depends on no provider, no DB, no HTTP, no CLI. **Four** interfaces plug into it,
plus one injected **redaction policy** the core enforces before any trace leaves it:

```
                  ┌──────────────────────────────────────────┐
                  │          @dzupagent/dialogue-core          │
                  │  • turn vocabulary (6 verbs + escape)      │
                  │  • scheduler / loop / handoff / branch     │
                  │  • mode gate (deliberate | build)          │
                  │  • RawTurnEvent → [RedactionPolicy] →      │
                  │       PersistedTurnEvent / StreamTurnEvent │
                  │  • decision-introspection capture          │
                  └──┬────────────┬────────────┬───────────┬──┘
            AgentPort │ Workspace  │ Validator  │  Trace    │
                      │   Port     │   Port     │   Port    │
        ┌─────────────┘     │          │            └────────────┐
 ┌──────┴───────┐   ┌───────┴──────┐ ┌─┴────────────┐  ┌─────────┴────────┐
 │ codev: live  │   │ codev: git + │ │ codev:       │  │ codev: DB + SSE  │
 │   registry   │   │  sandbox FS  │ │  sandboxed   │  │   (post-redact)  │
 │ flow-lab:    │   │ flow-lab:    │ │  Validation  │  │ flow-lab: NDJSON │
 │ CLI dispatch │   │  git/worktree│ │   Spec runner│  │  (raw, local)    │
 └──────────────┘   └──────────────┘ └──────────────┘  └──────────────────┘
```

**The four ports (dependency inversion — the core never knows _how_):**

- **`AgentPort`** — `run(turnSpec) → AgentResult`. The _only_ way the core invokes an
  agent. **`AgentResult` is text + usage only** (`{ raw, usage }`) — this matches
  reality: codev's `orchestrator.run()` returns `{ result, usage }` and cannot return a
  diff. The agent _proposes_; the workspace effect is captured separately (see
  `WorkspacePort`). codev injects its production registry adapter (multi-tenant,
  rate-limited, live providers); flow-lab injects CLI subprocess dispatch; tests/replay
  inject a fake/recorded port. **Adding any new LLM agent/API = write a port adapter;
  the core does not change.**
- **`WorkspacePort`** — owns the repo as a first-class entity. The diff/snapshot
  problem the agent call cannot solve. Minimum surface:
  - `snapshot() → { baseRevision, treeHash }` — captured before an `implement` turn.
  - `captureEffect(beforeSnapshot) → { diff, changedFiles[], postRevision, treeHash, applyStatus }` —
    captured after, by **observing the workspace**, not by trusting agent text.
    `applyStatus ∈ { clean | partial | failed | no-op }`.
  - `dirtyPolicy` — how a pre-existing dirty worktree is handled (reject | isolate |
    allow), set per environment.
    codev injects git + the worker/dispatch sandbox FS; flow-lab injects git/worktree
    ops (`lib/git-ops` already exists). **In deliberate-only mode this port is never
    called** (no `implement` turns run).
- **`ValidatorPort`** — `validate(spec: ValidationSpec) → ValidationResult`. **Not** a
  bare `(cmd, cwd)`. `ValidationSpec = { commandId, args?, cwdRoot, timeoutMs, env,
maxOutputBytes, tenantScope, sandboxPolicy }` — `commandId` resolves against an
  **allowlist**, never an arbitrary shell string in production. codev injects a
  sandboxed runner bound to tenant/workspace/project; flow-lab injects an allowlisted
  shell exec. **Never called in deliberate-only mode** — that is how the mode gate is
  implemented.
- **`TracePort`** — `emit(event: PersistedTurnEvent | StreamTurnEvent)`. **Receives
  already-redacted events** (see §3) — the sink no longer carries the redaction
  obligation. codev injects DB-write + SSE-broadcast; flow-lab injects NDJSON append;
  replay injects nothing.

**Plus one injected policy the core enforces (not a port the sink owns):**

- **`RedactionPolicy`** — `redact(RawTurnEvent) → { persisted, stream }`. The core
  builds a `RawTurnEvent` internally, runs it through the injected `RedactionPolicy`
  **before** handing anything to `TracePort`. codev injects a tenant-aware policy
  (strips secrets/credentials, applies field-level rules to prompts/diffs/validation
  logs); flow-lab injects an identity policy (writes raw, local-only). **Redaction is
  structurally unskippable** — there is no code path from a raw field to a sink that
  bypasses it.

The core is unit-testable end-to-end with fakes for all four ports + an identity
redaction policy. peer-dialogue and flow-prompt-lab become **thin adapters** over it —
not two divergent loops. This is the decision that prevents a _third_ divergent
work-loop (the trap fleet fell into).

---

## 2. Turn vocabulary & the run model

A **run** is an ordered sequence of **turns**. Each turn is one typed move.

**Six first-class verbs + one escape hatch:**

| Verb                   | What it does                                                         | Port(s)                           | Emits                                                                             |
| ---------------------- | -------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| `deliberate`           | An agent speaks/argues a position. No repo change.                   | `AgentPort`                       | full prompt, raw output, agent/provider/model, tokens, latency                    |
| `implement`            | An agent proposes edits; the core captures the effect.               | `AgentPort` **+ `WorkspacePort`** | agent output + `{ diff, changedFiles, base/postRevision, treeHash, applyStatus }` |
| `validate`             | Run an allowlisted command, gate on result. _Skipped in deliberate._ | `ValidatorPort`                   | `ValidationSpec` (commandId, scope) + `{ ok, exitCode, output, durationMs }`      |
| `review`               | An agent inspects a diff/output and judges it.                       | `AgentPort`                       | same as deliberate + **structured verdict JSON**                                  |
| `decide`               | Structured continue/stop/branch based on prior turns.                | `AgentPort` or rule               | **decision JSON + criteria + would-flip-if**                                      |
| `handoff`              | Pass control to a named participant.                                 | — (orchestration)                 | from, to, reason                                                                  |
| `agent.run` _(escape)_ | Run an arbitrary agent with a free-form role/prompt.                 | `AgentPort`                       | input + raw output (flagged `escape` — semantically opaque)                       |

**`implement` semantics (the key correction).** The agent call returns only text/usage
— it cannot promise a diff. So `implement` is a **two-phase** turn the scheduler runs:
(1) `WorkspacePort.snapshot()` captures `{ baseRevision, treeHash }`; (2) `AgentPort.run()`
lets the agent act (via its environment's edit mechanism — codev's sandbox FS, flow-lab's
subprocess); (3) `WorkspacePort.captureEffect(snapshot)` derives the **observed** diff,
changed files, post-revision, tree hash, and `applyStatus` by inspecting the workspace.
The trace records the _observed_ effect, never the agent's _claimed_ effect. A `failed`
or `partial` `applyStatus` is a first-class outcome the next `decide` can react to.

**`agent.run` is constrained, not a free pass.** It is allowed only where a `RunSpec`
explicitly opts in (a per-run `allowEscape` flag, default `false`); canonical
product/cockpit flows keep it off so every turn stays semantically traceable. Escape
turns are always flagged `escape: true` and cannot perform workspace effects (no
`WorkspacePort` access) — anything that edits the repo must be a real `implement` turn.

**Orchestration glue** (control flow the scheduler applies; not turns): `loop { ... }`
with `condition` + `maxIterations`, and `branch` for conditional paths. The loop-state
logic is **harvested** from flow-prompt-lab's `flow.loop.advance` / `lib/loop-state`,
not reinvented.

**The mode gate** (single run-level flag — implements the "both modes on one engine"
requirement):

- `mode: "deliberate"` → `implement` and `validate` turns are **inert**: the scheduler
  skips them, emitting a `skipped` event with `skipReason: "mode=deliberate"`. Output
  is a decision/spec.
- `mode: "build"` → all verbs active. Output is reviewed, validated code.

Because the gate is "skip these two verb types," **deliberate-only is provably a strict
subset of build** — one code path, no divergence.

**Decisions:**

- **(a) `decide` defaults to agent-driven** (an LLM makes the continue/stop/branch
  call, as `claude_orchestrates_gpt55` does with Claude-as-reviewer), with
  **rule-based decide** available as an option (e.g. "stop when validate passes 2×
  consecutively"). Agent-driven = genuine deliberation; rule-based = cheap
  deterministic fallback.
- **(b) N participants from the start.** The core supports an ordered list of N
  participants (not hardcoded left/right). First demo uses 2 (Claude + Codex), but a
  multi-agent review panel (cf. existing `multi_agent_review_loop.yaml`) is expressible
  with no refactor. `handoff` targets a participant by id.

`review` and `decide` **always** emit structured JSON as first-class traced fields
(not parsed from prose). The flow loop already produces this via
`responseMode: decision-json`; we promote it to a typed trace field.

---

## 3. Trace, replay & decision-introspection

**Invariant: the trace is the source of truth for replaying the _orchestration_.** Every
turn produces exactly one `TurnEvent`, appended in order. The run's **scheduler/loop/
decide path** is fully reconstructable from its trace — given recorded agent _and_
validation outputs plus the captured workspace effects, the engine reaches the same
decisions. (Caveat made explicit: replay reproduces the engine's logic, not the live
filesystem; it does not re-apply diffs to a real repo. See replay layer below.)

**`TurnEvent` contract** (three shapes — see redaction model below). The full
`RawTurnEvent` the core builds internally:

```jsonc
{
  "runId": "...",
  "runSpecHash": "sha256:...", // ties the event to the exact RunSpec that produced it
  "turnIndex": 0,
  "turnType": "implement",
  "participantId": "codex-1",
  "provider": "codex",
  "model": "gpt-5.5",
  "mode": "build", // deliberate | build (for skip-audit)
  "input": { "prompt": "...", "scopeFiles": [], "role": "persona-worker" },
  "output": { "raw": "...", "usage": { "inputTokens": 0, "outputTokens": 0 } },
  "workspace": {
    // present on implement turns (WorkspacePort)
    "baseRevision": "abc123",
    "postRevision": "def456",
    "baseTreeHash": "sha256:...",
    "postTreeHash": "sha256:...",
    "changedFiles": ["apps/api/src/x.ts"],
    "diff": "...unified diff (observed, not claimed)...",
    "applyStatus": "clean", // clean | partial | failed | no-op
  },
  "validation": {
    // present on validate turns (ValidatorPort)
    "commandId": "api:test",
    "ok": false,
    "exitCode": 1,
    "output": "...captured, capped at maxOutputBytes...",
    "durationMs": 0,
  },
  "decision": {
    // present on decide/review only
    "verdict": "continue", // continue|stop|branch|accept|reject
    "criteria": [{ "name": "tests-green", "met": false, "weight": 1 }],
    "rationale": "...",
    "wouldFlipIf": "validate exits 0",
  },
  "cost": { "usd": 0 },
  "timing": { "startedAt": "...", "ms": 0 },
  "escape": false, // true on agent.run (opaque) turns
  "status": "completed", // completed | skipped | failed
  "skipReason": null, // e.g. "mode=deliberate"
}
```

**Three observability layers — all in SP1:**

1. **Live stream.** The core emits each event (post-redaction) to `TracePort` as it is
   produced. codev injects SSE-broadcast (reusing the peer-dialogue SSE pattern);
   flow-lab injects stdout + NDJSON. You _watch_ a run unfold turn by turn.
2. **Deterministic replay — of the orchestration, not the filesystem.** Replay injects a
   **`RecordedAgentPort`** _and_ a **`RecordedValidatorPort`** that return the recorded
   `output.raw` / `validation` per `turnIndex` instead of calling the LLM or running
   commands, and a **`RecordedWorkspacePort`** that returns the recorded `workspace`
   effect (revisions, treeHash, diff, applyStatus) without touching a real repo. The core
   re-runs its _own_ scheduler/loop/decide logic against these recordings and must reach
   the **same decisions and the same `runSpecHash`**. This isolates **"the engine did the
   wrong thing"** (reproduces on replay) from **"the model gave a bad answer"** (frozen in
   the recording). Replay is deterministic _because_ all three non-deterministic sources
   (agent, validator, workspace) are recorded — recording only the agent, as the prior
   draft claimed, would have left validation and FS state unreproducible.
3. **Decision-introspection.** The `decision` block is first-class, not parsed from
   prose. Every `decide`/`review` turn answers _why_ semantically. The cockpit and the
   existing flow-lab analyzer read `criteria` + `wouldFlipIf` directly.

**Redaction is an enforced core stage, not a per-sink obligation.** Three event shapes:

- **`RawTurnEvent`** — built inside the core, carries raw `input.prompt`, `output.raw`,
  `workspace.diff`, `validation.output`. **Never leaves the core un-redacted.**
- **`PersistedTurnEvent`** — what `TracePort` writes to durable storage.
- **`StreamTurnEvent`** — what `TracePort` broadcasts live (may redact more aggressively
  than persisted, e.g. truncate large diffs for the wire).

The core runs `RawTurnEvent` through the injected **`RedactionPolicy`** (§1) to produce
the persisted + stream shapes **before** calling `TracePort`. The sink physically never
receives a raw field. codev injects a tenant-aware policy (secret/credential scrubbing +
field rules on prompts/diffs/validation logs); flow-lab injects an identity policy
(raw, local-only). **Acceptance requires a test proving codev's DB-write and SSE-broadcast
receive only redacted fields** — i.e. the security boundary is verified, not assumed.

---

## 4. Front-end adapters, error handling & the SP1 deliverable

**Two adapters in SP1** (both must work — proves the extraction is real, not a
one-front-end fiction). Each must satisfy **all five injection points**: `AgentPort`,
`WorkspacePort`, `ValidatorPort`, `TracePort`, `RedactionPolicy`.

**Phase 0 — Codev compatibility spike (lands FIRST, before flow-lab build-out).** A
reviewer-mandated de-risk: a thin vertical slice that proves the four contracts fit
production _before_ we iterate the engine against the easier flow-lab environment.
Concretely, pin down against codev: (1) the `PersistedTurnEvent` DB shape (does it
extend peer-dialogue checkpoint/message tables or need a new table?), (2) the
`RedactionPolicy` against codev's tenant redaction rules, (3) the `ValidationSpec`
allowlist + sandbox identity against the worker/dispatch sandbox, (4) the
`WorkspacePort` capture mechanism against codev's sandbox FS. Output: a confirmed
schema + a stub codev adapter that compiles and round-trips one fake turn. This
prevents fast flow-lab iteration from producing a core that later doesn't fit
production (the reviewer's explicit risk).

**A. flow-prompt-lab adapter** _(primary iteration loop — built after Phase 0 schema is pinned)_

- `AgentPort` → existing `lib/agent-dispatch` (CLI subprocess to claude/codex)
- `WorkspacePort` → existing `lib/git-ops` (snapshot = `git rev-parse` + tree hash;
  captureEffect = `git diff` / `git status --porcelain` against the base snapshot)
- `ValidatorPort` → allowlisted shell exec wrapping `lib/validation` (a `commandId` map,
  not arbitrary strings)
- `TracePort` → NDJSON append + stdout (reuse `metrics.jsonl` / `summary.json`
  conventions; the existing `analyzer` already consumes this shape)
- `RedactionPolicy` → identity (local-only, raw)
- `claude_orchestrates_gpt55.yaml` is **re-pointed onto the core** as proof the core
  reproduces today's behavior. `lib/loop-state` / `flow.loop.advance` harvested into
  the core scheduler.

**B. codev-app peer-dialogue adapter** _(completes the Phase 0 stub into a real adapter — proves production wiring)_

- `AgentPort` → existing `getOrCreateOrchestrator` registry (live providers:
  claude/codex/gemini/qwen/openrouter, multi-tenant, rate-limited)
- `WorkspacePort` → git + the worker/dispatch sandbox FS; `dirtyPolicy` per tenant config
- `ValidatorPort` → sandboxed `ValidationSpec` runner (worker/dispatch sandbox, bound to
  tenant/workspace/project, allowlisted `commandId`, timeout + output caps)
- `TracePort` → DB-write (`PersistedTurnEvent` shape from Phase 0) + existing SSE broadcast
- `RedactionPolicy` → tenant-aware (secret/credential scrub + field rules) — the
  security boundary; covered by the §3 acceptance test
- peer-dialogue's relay becomes a **2-participant, deliberate-mode** instance of the
  core; adding `mode: build` lights up implement+validate inside the _existing_ product
  UI route (`/orchestration/peer-dialogue/:runId`).

**Error handling** (core-level, traced — failures are first-class events, never silent):

- **Agent failure** (port throws/times out) → `status: failed` event; the next `decide`
  sees it and can retry/escalate/stop per policy. Mirrors flow-lab per-iteration
  handling.
- **Validation failure** → _not_ an error; a `validate` event with `ok:false` that
  _feeds_ the next `review`/`decide`. The loop is supposed to react to red tests — this
  is the build-mode heartbeat.
- **Budget exhaustion** → core checks cost against a run-level cap before each turn;
  over-cap → `stop` decision, reason `budget`. Reuses flow-lab `cost-meter` +
  peer-dialogue budget enforcement.
- **Runaway loop** → `maxIterations` hard cap on every loop; non-negotiable.
- **Lifecycle** (pause/cancel/resume) → core exposes a cooperative checkpoint between
  turns; codev injects existing lifecycle controls, flow-lab gets cancel-only. _This is
  exactly the control surface fleet lacks — here it is free because the trace is the
  checkpoint._

**The SP1 deliverable — the demo:**

> One real task (e.g. "add input validation to endpoint X"), run **twice** through the
> _same engine_ from the **same `RunSpec` (same `runSpecHash`)**, differing only in
> `mode`: once in **deliberate mode** (Claude and Codex argue toward a spec) and once in
> **build mode** (same two agents; Codex implements between turns, tests run, Claude
> reviews the diff, loop continues until green). Both runs **streamed live**, **fully
> traced**, **replayable offline**; for every stop/reject you can read **why** (criteria
>
> - would-flip). Demonstrated through _both_ the flow-lab CLI and the codev-app UI route.

**Acceptance criteria (tightened — these are pass/fail gates, not aspirations):**

1. **Same RunSpec, two modes** — both runs carry the identical `runSpecHash`; the only
   difference in their traces is `mode` and the presence/absence of implement+validate
   turns.
2. **Deliberate leaves the repo untouched** — the deliberate run's `WorkspacePort` is
   never called; `baseTreeHash == postTreeHash` for the repo across the whole run
   (asserted, not assumed).
3. **Build records workspace provenance** — every `implement` turn has
   `base/postRevision`, `base/postTreeHash`, and a non-`failed` `applyStatus`; the final
   state's tree hash is recorded.
4. **Deterministic replay** — replaying either run (recorded agent + validator +
   workspace ports) reproduces the identical decision sequence and `runSpecHash`.
5. **Redaction verified** — the codev run's `TracePort` (DB + SSE) provably receives only
   redacted fields (the §3 acceptance test).
6. **One schema, two front-ends** — flow-lab CLI and codev UI consume the identical
   `PersistedTurnEvent` / `StreamTurnEvent` schema (a shared schema test asserts this).

This single deliverable exercises every architectural decision: mode-gate-as-subset,
N-participant, AgentPort inversion, WorkspacePort capture, enforced redaction, the three
observability layers, both adapters.

**Testing strategy:**

- Core: exhaustive unit tests with all-fake ports (Agent/Workspace/Validator/Trace) +
  identity redaction (deterministic, no LLM calls, no real FS).
- Workspace capture: a test that a known agent edit yields the expected observed diff +
  `applyStatus`, and that a no-op edit yields `applyStatus: "no-op"` with equal tree
  hashes.
- Redaction: a test that a `RawTurnEvent` carrying a planted secret produces
  `Persisted`/`Stream` events with the secret removed — run against the codev policy.
- Each adapter: one integration test with a real round-trip.
- Replay: a golden-trace test (record once; replay with all three recorded ports; assert
  identical decision sequence + `runSpecHash`).

---

## 5. Forward seams for SP2–SP4 (designed-in, not built)

Extension points SP1 must leave open so later sub-projects plug in cleanly.

- **SP2 — Orchestration DSL.** SP1 defines the **`RunSpec`** — a plain-data run
  description: `{ mode, participants[], turns[]/loops[], decidePolicy, budget,
maxIterations, allowEscape, dirtyPolicy }`. The core executes a `RunSpec`; it does
  **not** parse YAML. **The `RunSpec` is content-hashed (`runSpecHash`)** and that hash
  is stamped on every `TurnEvent` — this is what lets the deliverable assert "same spec,
  two modes" and lets replay verify it re-ran the same definition. The DSL is just a
  `RunSpec` producer — flow-lab YAML, a future visual editor, or a JSON API all compile
  to the same hashed `RunSpec`. SP1 ships the `RunSpec` schema + validator + hasher; SP2
  builds authoring on top. _Seam: `RunSpec` (+ its hash) is the stable contract; the 6
  verbs + escape are its vocabulary._
- **SP3 — Multi-repo scale.** A multi-repo run is **N `RunSpec` executions sharing one
  trace namespace + a reconciliation turn**. SP1 guarantees: (1) `TracePort` is keyed by
  `runId` so N runs write to one queryable store; (2) `decide`/`review` emit structured
  `decision` blocks, so a future cross-repo reconciler is _just another core run_ whose
  participants consume those blocks. _Seam: queryable cross-run trace + structured
  decisions = the communication layer fleet never had._
- **SP4 — Enterprise cockpit.** Everything the cockpit needs is a _read_ over the trace
  plus a _write_ of a `RunSpec`. The `TurnEvent` stream is the live feed
  (author→run→observe→debug→ship all read it); `RunSpec` is what "author" produces;
  replay is what "debug" uses; the codev adapter already lands SP1 _inside_ the product
  (multi-tenant via the registry). _Seam: cockpit = RunSpec-in, TurnEvent-stream-out,
  nothing bespoke._

**Explicit SP1 non-goals (YAGNI guard):**

- No DSL authoring UI (SP2).
- No multi-repo execution or reconciler (SP3).
- No new cockpit views beyond lighting up build-mode in the _existing_ peer-dialogue
  route (SP4).
- No fleet changes — SP1 routes _around_ fleet; fleet's negotiation/store rework is a
  separate, later decision only if SP3 proves it's needed.
- No new providers — AgentPort makes them trivial later; SP1 ships with codev's
  **already-registered** set (`claude`, `codex`, `gemini`, `qwen`, `openrouter`) and
  flow-lab's CLI providers (`claude`, `codex`). No adding `crush`/`openai`/`gemini-sdk`.

**Thesis:** SP1 builds the _engine and its trace_. `RunSpec` in and `TurnEvent` out are
the two contracts every later sub-project stands on. Get those two right and SP2–SP4 are
additive, never invasive.
