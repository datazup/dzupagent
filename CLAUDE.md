# CLAUDE.md — DzipAgent Framework

## Overview
DzipAgent is a modular AI agent framework (formerly ForgeAgent). It is a standalone
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
  domain-nl2sql/  — Domain tooling for NL2SQL pipelines and helpers
  express/        — Express adapter: SSE streaming, agent router
  server/         — HTTP: Hono API, Drizzle, WebSocket, queue
  otel/           — Observability: OpenTelemetry, tracing, metrics
  evals/          — Evaluation: scorers, LLM judge, benchmarks
  testing/        — Test infra: recorder, mock models
  test-utils/     — Shared test utilities
  playground/     — Vue 3 debug UI
  create-dzipagent/ — CLI scaffolder

## Quality Gates
```bash
yarn build && yarn typecheck && yarn lint && yarn test
```

## Constraints
- TypeScript strict, no `any`
- ESM throughout
- Node.js 20+
- Each package builds independently via tsup
- No app-specific logic — this is a general-purpose framework
