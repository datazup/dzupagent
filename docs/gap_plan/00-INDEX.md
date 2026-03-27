# DzipAgent Architecture Improvement Plan — Master Index

> **Date**: 2026-03-24
> **Scope**: Comprehensive plan to evolve DzipAgent from a code-generation library into a production-ready, general-purpose agent framework with best-in-class code generation capabilities.
> **Sources**: `GNANA_RESEARCH_GAP.md`, `RESEARCH_GAP_SUGGESTIONS.md`, `MASTRA_HERMES_AGENT_DZIP_NEXT.md`, `memory_plan/`, `agent_claude_research.md`

---

## Vision

DzipAgent becomes a **modular, extensible AI agent framework** that:
1. Powers code generation in the ai-saas-starter-kit (current primary use case)
2. Supports arbitrary agentic workflows (data analysis, DevOps, content creation, etc.)
3. Can be extracted and used independently in other projects
4. Competes with Mastra, Gnana, and LangGraph on core agent primitives
5. Differentiates on context engineering, code generation, and prompt management

---

## Document Map

| Doc | Title | Scope |
|-----|-------|-------|
| **00-INDEX.md** | This file | Master index and vision |
| **01-ARCHITECTURE.md** | Target Architecture | Package graph, dependency rules, layer boundaries |
| **02-CORE-IMPROVEMENTS.md** | Core Package Improvements | Event bus, provider fallback, error types, hooks, plugin system |
| **03-MCP-INTEGRATION.md** | MCP Integration | Client, server, tool bridge, deferred loading |
| **04-SERVER-RUNTIME.md** | Server & Runtime | HTTP API, WebSocket, run persistence, approval gates |
| **05-AGENT-ENHANCEMENTS.md** | Agent Layer Enhancements | Workflow engine, orchestration patterns, agents-as-tools |
| **06-CODEGEN-EXCELLENCE.md** | Code Generation Excellence | Git tools, multi-format edits, repo map, AST analysis, sandbox tiers |
| **07-MEMORY-CONTEXT.md** | Memory & Context Improvements | Working memory, observational memory, system reminders, frozen snapshots |
| **08-TESTING-EVALS.md** | Testing & Evaluation | LLM recorder, eval framework, boundary tests, quality improvements |
| **09-CONNECTORS-ECOSYSTEM.md** | Connectors & Ecosystem | GitHub, Slack, HTTP connectors, RAG integration, AGENTS.md support |
| **10-ROADMAP.md** | Implementation Roadmap | 6-phase plan with effort estimates, dependencies, milestones |
| **11-DATABASE-INTEGRATION-PLAN.md** | Database & Code Intelligence | LanceDB, Tree-sitter, DuckDB-WASM, Drizzle pgvector, CoW VFS, Turbopuffer |

---

## Current State Summary

### Existing Packages (v0.1.0) — Verified Inventory (2026-03-24)

| Package | Files | LOC | Purpose |
|---------|-------|-----|---------|
| `@dzipagent/core` | 45 | 5,186 | LLM, prompt, memory, context, middleware, router, streaming, skills, sub-agents, persistence, **MCP (partial)** |
| `@dzipagent/agent` | 8 | 1,109 | DzipAgent class, ReAct tool loop, guardrails, iteration budgets, auto-compress |
| `@dzipagent/codegen` | 30 | 3,926 | VFS, code generation, sandbox, quality scoring, framework adaptation, pipeline builder, **git tools** |
| **Total** | **83** | **10,221** | |

**Test coverage: 0 test files across all packages** (critical gap)

### Planned New Packages

| Package | Priority | Purpose |
|---------|----------|---------|
| `@dzipagent/server` | P0 | HTTP/WS server, REST API, run management |
| `@dzipagent/evals` | P1 | Evaluation scorers (LLM + deterministic) |
| `@dzipagent/test-utils` | P1 | LLM recorder, mock factories |
| `@dzipagent/connectors` | P2 | Pre-built integrations (GitHub, Slack, HTTP) |
| `@dzipagent/rag` | P2 | Vector store abstraction, retrieval, re-ranking |

> **Note**: MCP lives inside `core/src/mcp/` (not a separate package) — tightly coupled with tool system.

---

## Consolidated Gap Inventory

### From All Research Documents

| ID | Gap | Source | Severity | Current Status |
|----|-----|--------|----------|----------------|
| G-01 | MCP integration | All 3 docs | Critical | **Partial** — `core/src/mcp/`: client connect/discover done, tool bridge done, deferred loader done; **tool invocation incomplete**, MCP server missing |
| G-02 | Server / API layer | Gnana | Critical | Missing |
| G-03 | Provider-level fallback | Gnana + Research | Critical | Missing |
| G-04 | Run persistence / history | Gnana | Critical | Missing |
| G-05 | Human-in-the-loop approval | Gnana | Critical | Missing |
| G-06 | Git integration tools | Research | High | **Implemented** — `codegen/src/git/`: GitExecutor, git-tools.ts (status/diff/commit/branch), commit-message.ts; **worktree isolation missing** |
| G-07 | Multi-format edit system | Research | High | Partial (basic find-replace, no multi-edit, no lint validation) |
| G-08 | Connector ecosystem | Gnana | High | Missing |
| G-09 | Repository map (AST/tree-sitter) | Research | High | Missing (regex-only extraction) |
| G-10 | AGENTS.md hierarchical support | Research | High | Partial (SKILL.md only) |
| G-11 | General-purpose workflow engine | Mastra | High | Missing (codegen pipeline only) |
| G-12 | Parallel orchestration | Research + Mastra | High | Missing (sequential-only pipeline) |
| G-13 | Internal event bus | Gnana | High | Missing (SSE output-only) |
| G-14 | Lifecycle hooks | Gnana | High | Partial (middleware only) |
| G-15 | Plugin architecture | Gnana | Medium | Missing |
| G-16 | Structured error types | Gnana | Medium | Missing |
| G-17 | Circuit breaker | Gnana | Medium | Missing |
| G-18 | In-memory store | Gnana + Mastra | Medium | Missing (throws NotImplemented) |
| G-19 | Sub-agent full ReAct loop | Gnana | Medium | Missing (single-turn only) |
| G-20 | Agent definition persistence | Gnana | Medium | Missing (code-only) |
| G-21 | Working memory (structured) | Mastra + Hermes | Medium | Missing |
| G-22 | Observational memory | Mastra + Hermes | Medium | Missing |
| G-23 | System reminders pattern | Research | Medium | Missing |
| G-24 | Streaming action execution | Research | Medium | Missing |
| G-25 | Tiered sandbox permissions | Research | Medium | Partial (Docker-only) |
| G-26 | Agents-as-tools pattern | Mastra + Research | Medium | Partial (SubAgentSpawner, not tools) |
| G-27 | Stuck detection | Research + Hermes | Medium | Missing |
| G-28 | LLM recorder for testing | Mastra | Medium | Missing |
| G-29 | Eval framework (LLM-as-judge) | Mastra + Gnana | Medium | Partial (code quality only) |
| G-30 | Frozen snapshot for cache | Hermes | Low | Missing |
| G-31 | Security sidecar model | Research | Low | Missing |
| G-32 | Session search (FTS) | Hermes | Low | Missing |
| G-33 | Skill self-improvement | Hermes | Low | Missing |
| G-34 | Multi-file coherence validation | Gnana | Low | Missing |
| G-35 | Multi-language support | Gnana | Low | Missing |

### Already Well-Implemented (Preserve & Enhance)

| Feature | Location | Quality |
|---------|----------|---------|
| Prompt caching (Anthropic) | `core/llm/prompt-cache.ts` | Excellent |
| Context condensation (4-phase) | `core/context/message-manager.ts` (348 LOC) | Excellent |
| Cost-aware routing | `core/router/cost-aware-router.ts` (122 LOC) | Strong |
| Memory security (sanitizer) | `core/memory/memory-sanitizer.ts` (140 LOC) | Strong |
| Fix escalation (3-level) | `codegen/pipeline/fix-escalation.ts` (150 LOC) | Strong |
| Token budget management | `codegen/context/token-budget.ts` (200+ LOC) | Excellent |
| Composable prompt fragments | `core/prompt/prompt-fragments.ts` (111 LOC) | Strong |
| Template engine (Handlebars-like) | `core/prompt/template-engine.ts` (240+ LOC) | Excellent |
| Memory consolidation | `core/memory/memory-consolidation.ts` (140+ LOC) | Good |
| Quality scoring (6 dims) | `codegen/quality/` (287+ LOC) | Strong |
| Framework adaptation | `codegen/adaptation/` (250+ LOC) | Good |
| VFS with diff/merge/snapshot | `codegen/vfs/` (346+ LOC) | Strong |
| ReAct loop with guardrails | `agent/agent/tool-loop.ts` (100+ LOC) | Strong |
| Iteration budgets (parent/child) | `agent/guardrails/iteration-budget.ts` (137 LOC) | Good |
| Git tools (status/diff/commit/branch) | `codegen/git/` (533+ LOC) | **Complete** |
| MCP client (connect/discover) | `core/mcp/mcp-client.ts` (150+ LOC) | Partial (invocation incomplete) |
| MCP tool bridge (bidirectional) | `core/mcp/mcp-tool-bridge.ts` (100+ LOC) | Complete |
| Deferred tool loading | `core/mcp/deferred-loader.ts` (100+ LOC) | Complete |
| Skill manager (CRUD + security) | `core/skills/skill-manager.ts` (291 LOC) | Complete |
| Cost tracking (per-model pricing) | `core/middleware/cost-tracking.ts` (150+ LOC) | Complete |

### Critical Gaps Remaining

| Gap | Impact |
|-----|--------|
| **0 test files** | No automated quality assurance; regressions undetectable |
| **No server/API** | Cannot deploy as a service |
| **No provider fallback** | Single point of failure on LLM provider outage |
| **No run persistence** | Cannot audit or replay agent executions |
| **No event bus** | No decoupled communication between components |
| **MCP tool invocation** | Can connect but can't actually call MCP tools |
| **In-memory store** | Cannot develop/test without PostgreSQL |
