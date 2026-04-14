# DzupAgent Migration Guide

This document covers breaking changes and migration steps across the DzupAgent rename history.

---

## Table of Contents

1. [DzipAgent 0.1.x → DzupAgent 0.2.x](#dzipagent-01x--dzupagent-02x)
   - [Package scope change](#1-package-scope-change)
   - [Core entrypoint tiers](#2-core-entrypoint-tiers)
   - [Preset removal from @dzupagent/agent](#3-preset-removal-from-dzupagentagent)
   - [Class name changes](#4-class-name-changes)
   - [Tool factory naming](#5-tool-factory-naming)
   - [ESM import path requirements](#6-esm-import-path-requirements)
   - [What stayed the same](#7-what-stayed-the-same)
   - [Deprecation timeline](#8-deprecation-timeline)
2. [ForgeAgent → DzipAgent (0.0.x era)](#forgeagent--dzipagent-00x-era)

---

## DzipAgent 0.1.x → DzupAgent 0.2.x

The rename from **DzipAgent** to **DzupAgent** (completed 2026-04-08) affected all 24 packages,
class names, and the private integration kit. The changes below describe every breaking difference
between 0.1.x and 0.2.x.

### 1. Package scope change

All packages moved from the `@dzipagent/*` scope to `@dzupagent/*`. The package names themselves
are unchanged; only the scope prefix changed.

**Update your `package.json` dependencies:**

```json
// Before (0.1.x)
{
  "dependencies": {
    "@dzipagent/core": "0.1.0",
    "@dzipagent/agent": "0.1.0",
    "@dzipagent/agent-adapters": "0.1.0",
    "@dzipagent/memory": "0.1.0",
    "@dzipagent/rag": "0.1.0"
  }
}

// After (0.2.x)
{
  "dependencies": {
    "@dzupagent/core": "^0.2.0",
    "@dzupagent/agent": "^0.2.0",
    "@dzupagent/agent-adapters": "^0.2.0",
    "@dzupagent/memory": "^0.2.0",
    "@dzupagent/rag": "^0.2.0"
  }
}
```

**Full list of renamed packages** (all follow the same `@dzipagent/*` → `@dzupagent/*` pattern):

| Old (`@dzipagent/`) | New (`@dzupagent/`) |
|---|---|
| `@dzipagent/core` | `@dzupagent/core` |
| `@dzipagent/agent` | `@dzupagent/agent` |
| `@dzipagent/agent-adapters` | `@dzupagent/agent-adapters` |
| `@dzipagent/agent-types` | `@dzupagent/agent-types` |
| `@dzipagent/adapter-types` | `@dzupagent/adapter-types` |
| `@dzipagent/cache` | `@dzupagent/cache` |
| `@dzipagent/codegen` | `@dzupagent/codegen` |
| `@dzipagent/connectors` | `@dzupagent/connectors` |
| `@dzipagent/connectors-browser` | `@dzupagent/connectors-browser` |
| `@dzipagent/connectors-documents` | `@dzupagent/connectors-documents` |
| `@dzipagent/context` | `@dzupagent/context` |
| `@dzipagent/create-dzipagent` | `@dzupagent/create-dzupagent` |
| `@dzipagent/evals` | `@dzupagent/evals` |
| `@dzipagent/express` | `@dzupagent/express` |
| `@dzipagent/memory` | `@dzupagent/memory` |
| `@dzipagent/memory-ipc` | `@dzupagent/memory-ipc` |
| `@dzipagent/otel` | `@dzupagent/otel` |
| `@dzipagent/playground` | `@dzupagent/playground` |
| `@dzipagent/rag` | `@dzupagent/rag` |
| `@dzipagent/runtime-contracts` | `@dzupagent/runtime-contracts` |
| `@dzipagent/scraper` | `@dzupagent/scraper` |
| `@dzipagent/server` | `@dzupagent/server` |
| `@dzipagent/testing` | `@dzupagent/testing` |
| `@dzipagent/test-utils` | `@dzupagent/test-utils` |

The private integration kit packages also moved from `@datazup/dzipagent-*` to `@datazup/dzupagent-*`:

| Old | New |
|---|---|
| `@datazup/dzipagent-presets` | `@datazup/dzupagent-presets` |
| `@datazup/dzipagent-registry` | `@datazup/dzupagent-registry` |
| `@datazup/dzipagent-otel-setup` | `@datazup/dzupagent-otel-setup` |
| `@datazup/dzipagent-event-bridge` | `@datazup/dzupagent-event-bridge` |
| `@datazup/dzipagent-memory-kit` | `@datazup/dzupagent-memory-kit` |

---

### 2. Core entrypoint tiers

`@dzupagent/core` now exposes three entrypoints. Use the narrowest one that fits your use case:

| Entrypoint | Use when |
|---|---|
| `@dzupagent/core/stable` | New code — curated facade-first surface |
| `@dzupagent/core/advanced` | You need the broader API set |
| `@dzupagent/core` | Legacy imports and back-compat while migrating |

```ts
// Before (0.1.x) — bare core import
import { createQuickAgent } from '@dzipagent/core'

// After (0.2.x) — use the stable tier for new code
import { createQuickAgent } from '@dzupagent/core/stable'
```

The legacy `@dzupagent/core` entrypoint continues to re-export everything for back-compat.
Prefer `/stable` for all new code.

---

### 3. Preset removal from @dzupagent/agent

**This is the most impactful breaking change in 0.2.x.**

The built-in presets (`RAGChatPreset`, `ResearchPreset`, `SummarizerPreset`, `QAPreset`) have been
**removed** from `@dzupagent/agent` (P0-5 in the refactoring plan). The `presets/built-in.ts`
file was deleted and its exports were removed from the main `index.ts`.

The canonical source for these presets is now `@datazup/dzupagent-presets` (private integration
kit). Applications that do not use the kit can define their own presets locally — see the custom
preset example below.

#### Option A: Use the kit package (recommended for DataZup apps)

```ts
// Before (0.1.x) — imported from @dzipagent/agent
import { RAGChatPreset, ResearchPreset } from '@dzipagent/agent'

// After (0.2.x) — import from the private kit package
import { RAGChatPreset, ResearchPreset } from '@datazup/dzupagent-presets'
```

The kit package also exports a registry factory:

```ts
import { createDefaultPresetRegistry } from '@datazup/dzupagent-presets'

const registry = createDefaultPresetRegistry()
// registry is pre-loaded with RAGChatPreset, ResearchPreset, SummarizerPreset, QAPreset
// extend it with your own:
registry.register(myCustomPreset)
```

#### Option B: Define a custom preset inline

The `AgentPreset` type and `PresetRegistry` class are still exported from `@dzupagent/agent`.
You can define presets directly in your application without depending on the kit package:

```ts
import type { AgentPreset } from '@dzupagent/agent'
import { PresetRegistry, buildConfigFromPreset } from '@dzupagent/agent'

const MyRAGPreset: AgentPreset = {
  name: 'rag-chat',
  description: 'Conversational agent with RAG retrieval',
  instructions: 'You are a helpful assistant. Use rag_query before answering.',
  toolNames: ['rag_query'],
  guardrails: {
    maxIterations: 5,
    maxCostCents: 20,
  },
  memoryProfile: 'balanced',
}

const registry = new PresetRegistry()
registry.register(MyRAGPreset)

const agentConfig = buildConfigFromPreset(MyRAGPreset, runtimeDeps)
```

#### What was removed

The following symbols are no longer exported from `@dzupagent/agent` (previously `@dzipagent/agent`):

- `RAGChatPreset`
- `ResearchPreset`
- `SummarizerPreset`
- `QAPreset`
- `BUILT_IN_PRESETS`

The infrastructure for presets (`AgentPreset`, `PresetRegistry`, `buildConfigFromPreset`,
`createDefaultPresetRegistry`, `PresetRuntimeDeps`) **remains in `@dzupagent/agent`**.

---

### 4. Class name changes

The main agent class was renamed from `DzipAgent` to `DzupAgent`.

```ts
// Before (0.1.x)
import { DzipAgent } from '@dzipagent/agent'

const agent = new DzipAgent(config)

// After (0.2.x)
import { DzupAgent } from '@dzupagent/agent'

const agent = new DzupAgent(config)
```

The config type was also renamed:

```ts
// Before
import type { DzipAgentConfig } from '@dzipagent/agent'

// After
import type { DzupAgentConfig } from '@dzupagent/agent'
```

The MCP server class was renamed:

```ts
// Before
import { DzipAgentMCPServer } from '@dzipagent/core'

// After
import { DzupAgentMCPServer } from '@dzupagent/core'
```

---

### 5. Tool factory naming

The tool factory function retains the `Forge` prefix. This is intentional — the internal factory
name was not changed as part of the rename:

```ts
// The function name is unchanged; only the import path scope changed
import { createForgeTool } from '@dzupagent/agent'
import type { ForgeToolConfig } from '@dzupagent/agent'
```

---

### 6. ESM import path requirements

All packages are pure ESM (`"type": "module"` in `package.json`). Relative imports within
your project must include the `.js` extension even when the source files are `.ts`. This was
already required in 0.1.x but is worth confirming if you are migrating a CommonJS project:

```ts
// Correct — .js extension on relative imports
import { myHelper } from './utils/helper.js'

// Incorrect — will fail at runtime in ESM
import { myHelper } from './utils/helper'
```

Published package imports do not need an extension (Node.js resolves via `exports` in
`package.json`):

```ts
import { DzupAgent } from '@dzupagent/agent'          // correct
import { ForgeError } from '@dzupagent/core'           // correct
import { createQuickAgent } from '@dzupagent/core/stable' // correct
```

---

### 7. What stayed the same

The following were intentionally preserved across the rename to reduce migration friction:

- **`ForgeError` class** — still exported from `@dzupagent/core` under the same name. The `Forge`
  prefix was kept on this class:

  ```ts
  import { ForgeError } from '@dzupagent/core'
  import type { ForgeErrorCode, ForgeErrorOptions } from '@dzupagent/core'
  ```

- **Database table names** — the Drizzle schema in `@dzupagent/server` defines tables as
  `forge_runs` and `forge_run_logs`. Existing database migrations do not need to be rewritten.

- **`ForgeContainer` / `createContainer`** — the DI container in `@dzupagent/core` retains the
  `Forge` prefix:

  ```ts
  import { ForgeContainer, createContainer } from '@dzupagent/core'
  ```

- **`createForgeTool` / `ForgeToolConfig`** — tool factory function and type keep the `Forge`
  prefix (see section 5 above).

- **All runtime semantics** — the `generate()`, `stream()`, and `asTool()` methods on `DzupAgent`
  have the same signatures as the equivalent methods on `DzipAgent` in 0.1.x.

- **Peer dependencies** — `@langchain/core >=1.0.0`, `@langchain/langgraph >=1.0.0`, and
  `zod >=4.0.0` are unchanged.

- **Node.js requirement** — Node.js `>=20` is still required.

---

### 8. Deprecation timeline

| Version | Status |
|---|---|
| `@dzipagent/*` 0.1.x | End-of-life — no further patches or security fixes. |
| `@dzupagent/*` 0.2.x | Current stable release. |
| `@dzupagent/*` 0.3.x / 1.0.0 | Planned. Will remove legacy re-exports from `@dzupagent/core` (bare entrypoint) that exist solely for back-compat. |

**Action required before 0.3.0:**

1. Migrate all imports from `@dzupagent/core` → `@dzupagent/core/stable` or
   `@dzupagent/core/advanced`.
2. Remove any remaining references to `RAGChatPreset`, `ResearchPreset`, `SummarizerPreset`,
   `QAPreset`, or `BUILT_IN_PRESETS` from `@dzupagent/agent` — these were already removed in
   0.2.0 (see section 3).

---

## ForgeAgent → DzipAgent (0.0.x era)

The original rename from **ForgeAgent** to **DzipAgent** happened on 2026-03-27. If you are
migrating from a pre-0.1.x `@forgeagent/*` snapshot, the mapping was:

| Old | New (0.1.x) | Current (0.2.x) |
|---|---|---|
| `@forgeagent/core` | `@dzipagent/core` | `@dzupagent/core` |
| `@forgeagent/agent` | `@dzipagent/agent` | `@dzupagent/agent` |
| `ForgeAgent` class | `DzipAgent` class | `DzupAgent` class |

No public npm packages were published under `@forgeagent/*`. This rename only affected internal
workspace consumers. If you are arriving from the ForgeAgent era, apply both rename steps and
go directly to 0.2.x.

---

## Quick reference: import path mapping

| Symbol | 0.1.x import | 0.2.x import |
|---|---|---|
| Main agent class | `@dzipagent/agent` → `DzipAgent` | `@dzupagent/agent` → `DzupAgent` |
| Agent config type | `@dzipagent/agent` → `DzipAgentConfig` | `@dzupagent/agent` → `DzupAgentConfig` |
| Tool factory | `@dzipagent/agent` → `createForgeTool` | `@dzupagent/agent` → `createForgeTool` |
| Error class | `@dzipagent/core` → `ForgeError` | `@dzupagent/core` → `ForgeError` |
| DI container | `@dzipagent/core` → `ForgeContainer` | `@dzupagent/core` → `ForgeContainer` |
| MCP server | `@dzipagent/core` → `DzipAgentMCPServer` | `@dzupagent/core` → `DzupAgentMCPServer` |
| Core stable tier | `@dzipagent/core` | `@dzupagent/core/stable` |
| RAGChatPreset | `@dzipagent/agent` | `@datazup/dzupagent-presets` |
| ResearchPreset | `@dzipagent/agent` | `@datazup/dzupagent-presets` |
| SummarizerPreset | `@dzipagent/agent` | `@datazup/dzupagent-presets` |
| QAPreset | `@dzipagent/agent` | `@datazup/dzupagent-presets` |
| PresetRegistry | `@dzipagent/agent` | `@dzupagent/agent` (unchanged) |
| buildConfigFromPreset | `@dzipagent/agent` | `@dzupagent/agent` (unchanged) |
| Claude adapter | `@dzipagent/agent-adapters` → `ClaudeAgentAdapter` | `@dzupagent/agent-adapters` → `ClaudeAgentAdapter` |
| Codex adapter | `@dzipagent/agent-adapters` → `CodexAdapter` | `@dzupagent/agent-adapters` → `CodexAdapter` |
| Gemini adapter | `@dzipagent/agent-adapters` → `GeminiCLIAdapter` | `@dzupagent/agent-adapters` → `GeminiCLIAdapter` |
| Qwen adapter | `@dzipagent/agent-adapters` → `QwenAdapter` | `@dzupagent/agent-adapters` → `QwenAdapter` |
| Crush adapter | `@dzipagent/agent-adapters` → `CrushAdapter` | `@dzupagent/agent-adapters` → `CrushAdapter` |
