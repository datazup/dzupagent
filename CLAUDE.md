# CLAUDE.md — DzupAgent Framework

## Overview
DzupAgent is a modular AI agent framework (formerly ForgeAgent). It is a standalone
project consumed by multiple applications via Yarn workspaces.

## Structure
packages/
  core/           — Foundation: LLM, events, plugins, MCP, security, identity
  agent/          — Orchestration: workflows, guardrails, tool loops, supervisor
  agent-adapters/ — Optional adapter layer for integrating agent runtimes
  cache/          — LLM response caching: Redis, InMemory, ModelRegistry middleware
  codegen/        — Code generation: git tools, VFS, repo maps, AST, tree-sitter
  connectors/     — External integrations
  connectors-browser/ — Browser-oriented connector implementations
  connectors-documents/ — Document ingestion/connectors
  memory/         — Memory: decay, consolidation, retrieval, store factory
  memory-ipc/     — Arrow IPC: schema, adapters, DuckDB analytics
  context/        — Context: message manager, compression, prompt cache
  rag/            — RAG: chunking, retrieval, context assembly, citations
  scraper/        — Web scraping: HTTP, Puppeteer, content extraction
  express/        — Express adapter: SSE streaming, agent router
  server/         — Maintenance-only HTTP compatibility host; do not add new product features here
  otel/           — Observability: OpenTelemetry, tracing, metrics
  evals/          — Evaluation: scorers, LLM judge, benchmarks
  testing/        — Test infra: recorder, mock models
  test-utils/     — Shared test utilities
  playground/     — Maintenance-only Vue 3 debug UI; do not add new product features here
  create-dzupagent/ — CLI scaffolder

## Quality Gates
```bash
yarn build && yarn typecheck && yarn lint && yarn test
```

Or use the single Turbo-powered gate:
```bash
yarn verify
```

## Build and Dev Orchestration
- Root scripts are Turbo-powered for dependency-aware task execution and caching.
- Use `yarn build`, `yarn typecheck`, `yarn lint`, and `yarn test` from repo root.
- Use `yarn dev` for parallel package dev tasks, or run a package directly (for example: `yarn workspace @dzupagent/playground dev`).
- Keep package-local `build` scripts on `tsup` and package-local `typecheck` scripts on `tsc --noEmit`.

## Product Feature Boundary
New product capabilities should not be added to `packages/server` or `packages/playground`.

DzupAgent should provide reusable framework primitives. Application-specific capabilities belong in the consuming app, starting with `apps/codev-app` in the shared workspace. Route features such as multi-workspace/project/task orchestration, subtasks, personas, prompt templates, workflow DSLs, memory policy, multi-tenant filtering, adapter orchestration, and operator UX to Codev unless the user explicitly asks for framework maintenance.

Allowed `server` and `playground` work:
- compatibility fixes
- security fixes
- test repairs
- documentation corrections
- minimal maintenance required by existing framework package checks

Not allowed by default:
- new HTTP product APIs in `packages/server`
- new operator UX in `packages/playground`
- Codev-specific semantics in framework packages

## LLM/Automation Execution Flow
- Start with package-scoped checks using Turbo filters:
  - `yarn build --filter=@dzupagent/<package>`
  - `yarn typecheck --filter=@dzupagent/<package>`
  - `yarn lint --filter=@dzupagent/<package>`
  - `yarn test --filter=@dzupagent/<package>`
- If changes cross package boundaries or shared interfaces, run `yarn verify` before finalizing.
- Use `yarn build:connectors:verified` when touching `packages/connectors/**`.
- Use `yarn docs:generate` when API comments, exported surface, or docs config changes.

## Documentation
- Generate API docs with `yarn docs:generate`.
- TypeDoc is configured via `typedoc.json` and uses `tsconfig.docs.json` to avoid project-reference/composite build artifact conflicts.
- Keep docs-generation config isolated from production build outputs.

## Constraints
- TypeScript strict, no `any`
- ESM throughout
- Node.js 20+
- Each package builds independently via tsup
- No app-specific logic — this is a general-purpose framework
- Universal packages (`packages/*`) MUST NOT import domain packages (`@dzupagent/domain-nl2sql`,
  `@dzupagent/workflow-domain`, `@dzupagent/org-domain`, `@dzupagent/persona-registry`,
  `@dzupagent/scheduler`, `@dzupagent/execution-ledger`). The CI check `check:domain-boundaries`
  enforces this. Domain packages now live in their owning app workspaces.
