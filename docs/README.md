# dzipagent Documentation Hub

Welcome to the `dzipagent` documentation! This monorepo contains a modular framework for building, running, and monitoring autonomous LLM agents.

## Feature Documentation

Explore the core features of `dzipagent`:

- [**Agent Guardrails**](features/guardrails.md) - Learn how to control costs, iterations, and prevent agent loops.
- [**Agent Memory System**](features/memory.md) - Understand how agents store, search, and semantically consolidate knowledge.
- [**DzipEventBus**](features/event-bus.md) - A typed, asynchronous system for real-time monitoring and telemetry.

## Package Documentation

Detailed documentation for each package in the ecosystem:

- [`@dzipagent/rag`](packages/rag.md) - Composable RAG pipeline.
- [`@dzipagent/scraper`](packages/scraper.md) - Smart web scraping for agents.
- [`@dzipagent/express`](packages/express.md) - Middleware for Express.js.
- [`@dzipagent/cache`](packages/cache.md) - Robust caching for LLM requests.

## Guides

- [**Migration Guide**](guides/migration-from-custom.md) - Moving from custom agent implementations to `dzipagent`.

## Architecture Decisions

Our architectural evolution is documented in the [`plans/`](../plans/) directory.

---

## API Reference (Auto-generated)

To generate the full API reference from source code comments, run:

```bash
cd dzipagent
npm run docs:generate
```
This will create a `docs/api` directory containing TypeDoc-generated HTML.
