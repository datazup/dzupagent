# 10 — Implementation Roadmap

> **Total estimated scope**: ~5,530 LOC across 6 phases, ~77 new/modified files

---

## Phase Overview

| Phase | Focus | Duration | LOC | Key Deliverables |
|-------|-------|----------|-----|------------------|
| **P1** | Foundation & Stability | 2 weeks | ~740 | Event bus, errors, circuit breaker, fallback, in-memory store |
| **P2** | MCP + Code Generation | 2 weeks | ~1,080 | MCP client/bridge, git tools, multi-format edits |
| **P3** | Server & Approval | 2-3 weeks | ~1,040 | HTTP API, run persistence, approval gates, WebSocket |
| **P4** | Agent Intelligence | 2 weeks | ~1,410 | Workflow engine, orchestration, AGENTS.md, working memory |
| **P5** | Testing & Evals | 1-2 weeks | ~640 | LLM recorder, eval framework, boundary tests |
| **P6** | Ecosystem | 2-3 weeks | ~1,090 | Connectors, RAG, observational memory, security sidecar |

---

## Phase 1: Foundation & Stability (Weeks 1-2)

**Goal**: Harden core primitives. Every subsequent phase depends on these.

| Task | Gap ID | Package | ~LOC | Priority | Depends On |
|------|--------|---------|------|----------|------------|
| Structured error types (ForgeError + codes) | G-16 | core | 80 | P0 | — |
| Event bus (typed pub/sub) | G-13 | core | 140 | P0 | — |
| Circuit breaker | G-17 | core | 80 | P0 | — |
| Provider-level fallback in ModelRegistry | G-03 | core | 90 | P0 | Circuit breaker |
| In-memory store | G-18 | core | 60 | P0 | — |
| Store interfaces (AgentStore, RunStore) | G-20 | core | 80 | P1 | — |
| Lifecycle hooks | G-14 | core | 100 | P1 | Event bus |
| Plugin architecture | G-15 | core | 110 | P1 | Event bus, hooks |

**Acceptance criteria**:
- `ForgeError` used throughout all packages (replace generic `Error` throws)
- Event bus emits typed events; at least 3 internal consumers
- ModelRegistry falls back to secondary provider on 503/rate-limit
- All tests run without PostgreSQL (using InMemoryStore)
- Boundary test passes: core imports nothing from agent/codegen

**Test coverage target**: 80%+ for new code

---

## Phase 2: MCP + Code Generation Excellence (Weeks 3-4)

**Goal**: Address the two most critical gaps: MCP integration and code generation tooling.

| Task | Gap ID | Package | ~LOC | Priority | Depends On | Status |
|------|--------|---------|------|----------|------------|--------|
| **Complete MCP tool invocation** (`invokeAsync`) | G-01 | core | 50 | P0 | Event bus | ~80% done |
| MCP server (expose agents as MCP tools) | G-01 | core | 120 | P2 | MCP client | Not started |
| Enhanced edit tool (multi-edit, search/replace) | G-07 | codegen | 160 | P0 | — | Not started |
| Multi-edit tool (multiple files atomically) | G-07 | codegen | 80 | P0 | — | Not started |
| Lint validator for edits | G-07 | codegen | 60 | P1 | — | Not started |
| Git middleware (inject git context into prompts) | G-06 | codegen | 80 | P1 | — | Not started |
| Git worktree manager (parallel agent isolation) | G-06 | codegen | 100 | P2 | — | Not started |
| Fix memory store `{ index: ["text"] }` bug | — | core | 20 | P0 | — | Not started |

> **Already complete (no work needed)**:
> - MCP client connect/discover (`core/src/mcp/mcp-client.ts` — 150+ LOC)
> - MCP tool bridge bidirectional (`core/src/mcp/mcp-tool-bridge.ts` — 100+ LOC)
> - Deferred tool loading (`core/src/mcp/deferred-loader.ts` — 100+ LOC)
> - Git tools status/diff/commit/branch (`codegen/src/git/git-tools.ts` — 150+ LOC)
> - Git executor (`codegen/src/git/git-executor.ts` — 200+ LOC)
> - Commit message generator (`codegen/src/git/commit-message.ts` — 100+ LOC)

**Acceptance criteria**:
- MCP tool invocation works end-to-end (connect → discover → call → return result)
- Edit tool supports multiple edits per call with lint validation
- Memory semantic search works correctly (index bug fixed)

---

## Phase 3: Server & Approval Gates (Weeks 5-7)

**Goal**: Make DzipAgent deployable as a service.

| Task | Gap ID | Package | ~LOC | Priority | Depends On |
|------|--------|---------|------|----------|------------|
| Hono app factory | G-02 | server | 60 | P0 | — |
| Run routes (trigger, status, cancel, stream) | G-02 | server | 120 | P0 | Run store |
| Postgres run store | G-04 | server | 120 | P0 | Store interfaces |
| Drizzle schema (agents, runs, logs) | G-04 | server | 80 | P0 | — |
| Approval gate | G-05 | agent | 100 | P0 | Event bus |
| Approval routes | G-05 | server | 60 | P0 | Approval gate |
| WebSocket event bridge | G-02 | server | 140 | P1 | Event bus |
| Agent routes (CRUD) | G-20 | server | 100 | P1 | Agent store |
| Postgres agent store | G-20 | server | 100 | P1 | Store interfaces |
| Auth middleware (API keys) | G-02 | server | 50 | P1 | — |
| Health routes | G-02 | server | 30 | P1 | — |
| Tool routes | G-02 | server | 40 | P2 | — |
| Rate limiter | G-02 | server | 40 | P2 | — |

**Acceptance criteria**:
- `@dzipagent/server` starts with `createForgeApp()` and serves REST API
- Runs are persisted in Postgres; queryable by agent/status/date
- Approval gate pauses execution; API endpoint resumes or rejects
- WebSocket streams real-time events to connected clients
- Health endpoint returns provider status and DB connectivity

---

## Phase 4: Agent Intelligence (Weeks 8-9)

**Goal**: Make the agent layer general-purpose and intelligent.

| Task | Gap ID | Package | ~LOC | Priority | Depends On |
|------|--------|---------|------|----------|------------|
| Workflow builder (then/branch/parallel/suspend) | G-11 | agent | 260 | P1 | — |
| Workflow runner (LangGraph compiler) | G-11 | agent | 250 | P1 | Workflow builder |
| Orchestrator patterns (sequential, parallel, supervisor) | G-12 | agent | 150 | P1 | — |
| Agents-as-tools (`asTool()`) | G-26 | agent | 40 | P0 | — |
| Sub-agent full ReAct loop | G-19 | agent | 60 | P1 | — |
| Stuck detector | G-27 | agent | 80 | P1 | — |
| AGENTS.md parser | G-10 | core | 80 | P1 | — |
| Hierarchical walker | G-10 | core | 100 | P1 | — |
| Working memory | G-21 | core | 100 | P1 | — |
| System reminder injector | G-23 | core | 80 | P1 | — |
| Repo map (symbol extractor + import graph) | G-09 | codegen | 200 | P1 | ts-morph |

**Acceptance criteria**:
- Workflow builder compiles to LangGraph and supports parallel + suspend/resume
- Agent A can invoke Agent B via `asTool()` in LLM function calling
- AGENTS.md files discovered and merged from global → project → directory
- Working memory persists typed state across sessions
- Repo map generates condensed representation within token budget

---

## Phase 5: Testing & Evaluation (Weeks 10-11)

**Goal**: Enable deterministic testing and production quality monitoring.

| Task | Gap ID | Package | ~LOC | Priority | Depends On |
|------|--------|---------|------|----------|------------|
| LLM recorder | G-28 | test-utils | 120 | P1 | — |
| Mock chat model | G-28 | test-utils | 40 | P1 | — |
| Test helpers | G-28 | test-utils | 60 | P1 | — |
| LLM judge scorer | G-29 | evals | 80 | P2 | — |
| Deterministic scorers | G-29 | evals | 60 | P2 | — |
| Composite scorer | G-29 | evals | 50 | P2 | — |
| Eval runner + regression | G-29 | evals | 140 | P2 | Scorers |
| Eval types | G-29 | evals | 40 | P2 | — |
| Boundary enforcement test | — | root | 50 | P0 | — |

**Acceptance criteria**:
- LLM recorder can record and replay interactions deterministically
- CI pipeline runs tests without live LLM calls (replay mode)
- Eval framework can score agent outputs with LLM + deterministic judges
- Boundary test prevents architectural drift

---

## Phase 6: Ecosystem Expansion (Weeks 12-14)

**Goal**: Build out the connector ecosystem and advanced memory features.

| Task | Gap ID | Package | ~LOC | Priority | Depends On |
|------|--------|---------|------|----------|------------|
| Connector types | G-08 | connectors | 30 | P2 | — |
| GitHub connector | G-08 | connectors | 200 | P2 | — |
| HTTP connector | G-08 | connectors | 80 | P2 | — |
| Slack connector | G-08 | connectors | 120 | P2 | — |
| Database connector | G-08 | connectors | 100 | P2 | — |
| Observation extractor | G-22 | core | 120 | P2 | — |
| Frozen snapshot pattern | G-30 | core | 50 | P2 | — |
| Confidence scoring | — | core | 40 | P2 | — |
| Git worktree manager | G-06 | codegen | 100 | P2 | Git tools |
| Permission tiers | G-25 | codegen | 50 | P2 | — |
| Import validator | G-34 | codegen | 60 | P2 | — |
| Security sidecar | G-31 | core | 80 | P3 | — |
| Session search (FTS) | G-32 | core | 60 | P3 | — |

**Acceptance criteria**:
- GitHub connector creates tools for repos, issues, PRs
- HTTP connector makes arbitrary REST calls
- Observation extractor auto-extracts facts from conversations
- Frozen snapshot preserves prompt cache across session

---

## Dependency Graph

```
P1: Foundation
  ├── Errors (independent)
  ├── Event Bus (independent)
  ├── Circuit Breaker (independent)
  ├── In-Memory Store (independent)
  ├── Provider Fallback → Circuit Breaker
  ├── Hooks → Event Bus
  └── Plugins → Event Bus + Hooks

P2: MCP + Codegen (depends on P1)
  ├── MCP Client → Event Bus
  ├── MCP Bridge → MCP Client
  ├── Git Tools (independent)
  ├── Edit Tools (independent)
  └── MCP Server → MCP Client

P3: Server (depends on P1)
  ├── Drizzle Schema (independent)
  ├── Run Store → Store Interfaces
  ├── Hono App → Run Store
  ├── Approval Gate → Event Bus
  └── WebSocket → Event Bus

P4: Agent Intelligence (depends on P1, partially P2)
  ├── Workflow Builder (independent)
  ├── Workflow Runner → Workflow Builder
  ├── Orchestrator (independent)
  ├── asTool() (independent)
  ├── AGENTS.md (independent)
  └── Repo Map (independent, needs ts-morph)

P5: Testing (can start any time)
  ├── LLM Recorder (independent)
  ├── Eval Framework (independent)
  └── Boundary Test (independent)

P6: Ecosystem (depends on P1)
  ├── Connectors (independent of each other)
  ├── Observation Extractor (independent)
  └── Frozen Snapshot (independent)
```

---

## Package Summary After Completion

| Package | Current LOC | New LOC | Total LOC | Files |
|---------|------------|---------|-----------|-------|
| `@dzipagent/core` | 5,186 | ~1,200 | ~6,386 | 55+ |
| `@dzipagent/agent` | 1,109 | ~1,000 | ~2,109 | 16+ |
| `@dzipagent/codegen` | 3,926 | ~700 | ~4,626 | 38+ |
| `@dzipagent/server` | 0 | ~1,040 | ~1,040 | 14 |
| `@dzipagent/evals` | 0 | ~420 | ~420 | 8 |
| `@dzipagent/test-utils` | 0 | ~220 | ~220 | 3 |
| `@dzipagent/connectors` | 0 | ~530 | ~530 | 5 |
| **Total** | **10,221** | **~5,110** | **~15,331** | **~139** |

> **Note**: New LOC is ~820 less than originally estimated because MCP client/bridge/deferred-loader
> and git tools/executor/commit-message were already implemented (discovered via codebase inventory).

---

## Milestones

| Milestone | When | Criteria |
|-----------|------|----------|
| **M1: Stable Core** | End of Week 2 | Events, errors, fallback, in-memory store, boundary test passing |
| **M2: MCP + Git** | End of Week 4 | MCP client working, git tools functional, edit tools enhanced |
| **M3: Deployable** | End of Week 7 | Server serves REST API, runs persisted, approval gate works |
| **M4: General-Purpose** | End of Week 9 | Workflow engine, orchestration, agents-as-tools, AGENTS.md |
| **M5: Testable** | End of Week 11 | LLM recorder in CI, eval framework, all tests deterministic |
| **M6: Ecosystem** | End of Week 14 | Connectors, RAG, advanced memory, security sidecar |

---

## Risk Factors

| Risk | Mitigation |
|------|-----------|
| MCP SDK instability | Pin version, wrap in adapter layer |
| ts-morph binary size | Make optional peer dependency; fallback to regex extraction |
| LangGraph breaking changes | Pin @langchain/* versions, extensive integration tests |
| Scope creep in server package | Keep minimal — auth/billing/workspace stay in SaaS app layer |
| Plugin system complexity | Start with simple interface; extend as real plugins emerge |

---

## What NOT to Build (Out of Scope)

| Feature | Reason |
|---------|--------|
| Multi-platform messaging (Telegram, Discord) | Not relevant for developer tools library |
| RL training pipeline | Research-focused, not library concern |
| Voice/TTS | Unrelated to code generation |
| Full deployment platform | Leave to Vercel/AWS/Docker |
| CLI scaffolding (`create-dzipagent`) | Premature — stabilize core first |
| Dashboard UI | Can be built on top of server API later |
| Billing/subscription management | Stays in SaaS app layer |
| Workspace/RBAC management | Stays in SaaS app layer |
