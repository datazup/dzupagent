# @dzipagent/domain-nl2sql Architecture

## Package Purpose

NL2SQL domain module for the DzipAgent framework. Converts natural language questions into SQL queries using a multi-agent pipeline.

## Package Map

```
src/
├── types/index.ts          — Domain types (NL2SQLToolkitConfig, NL2SQLResult, etc.)
├── tools/                  — 14 LangChain DynamicStructuredTools
│   ├── tool-classify-relevance.ts    — Is this a data question?
│   ├── tool-detect-ambiguity.ts      — Any ambiguous terms?
│   ├── tool-entity-tracker.ts        — Resolve pronouns in follow-ups
│   ├── tool-model-router.ts          — Pick model tier by complexity
│   ├── tool-schema-retrieval.ts      — Find relevant tables
│   ├── tool-column-prune.ts          — Remove irrelevant columns
│   ├── tool-sql-generate.ts          — Generate SQL with CoT reasoning
│   ├── tool-multi-agent-generate.ts  — 3 candidates, best-of-N selection
│   ├── tool-validate-safety.ts       — Block destructive SQL (regex)
│   ├── tool-validate-structure.ts    — Verify table references (regex)
│   ├── tool-execute-query.ts         — Run SQL with RLS injection
│   ├── tool-result-validator.ts      — Detect anomalies in results
│   ├── tool-confidence-scorer.ts     — Multi-dimensional scoring
│   ├── tool-response-synthesizer.ts  — NL explanation of results
│   └── index.ts                      — Toolkit factories (core/extended/full)
├── agents/index.ts         — 3 specialist agent definitions
│   ├── Schema Expert       — retrieve + prune (chat tier, 3 iterations)
│   ├── SQL Writer          — generate + validate (reasoning tier, 5 iterations)
│   └── Query Executor      — execute + validate + score + respond (chat tier, 3 iterations)
├── workflows/index.ts      — Pre-built workflow configs
│   ├── DETERMINISTIC_WORKFLOW  — Fixed topology: classify→retrieve→generate→validate→execute
│   └── SUPERVISOR_WORKFLOW     — Dynamic: manager delegates to 3 specialists
└── index.ts                — Public API barrel
```

## Dependencies

- `@dzipagent/core` — VectorStore, ModelRegistry, event bus
- `@dzipagent/agent` — DzipAgent, orchestration
- `@dzipagent/connectors` — SQLConnector (8 dialects), SQL tools
- `@langchain/core` — DynamicStructuredTool, BaseChatModel
- `zod` — Schema validation

## Migrated From

- `@nl2sql/pipeline` (21 LangGraph nodes → 14 tools)
- `@nl2sql/core` (types)
- `apps/api/src/services/dzipagent/toolkit-sql/` (10 tools)
- `apps/api/src/services/dzipagent/agents/` (3 agents)
- `apps/api/src/services/dzipagent/nl2sql-workflow.ts`
- `apps/api/src/services/dzipagent/nl2sql-supervisor.ts`
