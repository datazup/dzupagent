# 11 — Developer Experience

> **Status:** Planning
> **Priority:** P1-P3 (features vary)
> **Total Estimated Effort:** 88h
> **Dependencies:** 09-Formats (Agent Card v2), 08-Evaluation (test harness), 04-Orchestration (workflow engine)
> **New Packages:** `create-dzipagent` (CLI scaffolding), `@dzipagent/playground` (web UI)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - [F1: create-dzipagent CLI](#f1-create-dzipagent-cli-p1-12h)
   - [F2: Agent Playground](#f2-agent-playground-p2-24h)
   - [F3: Plugin Marketplace](#f3-plugin-marketplace-p3-20h)
   - [F4: Agent Templates Library](#f4-agent-templates-library-p1-8h)
   - [F5: Documentation Generation](#f5-documentation-generation-p2-8h)
   - [F6: Integration Test Scaffolding](#f6-integration-test-scaffolding-p1-4h)
   - [F7: Development Mode](#f7-development-mode-p1-4h)
   - [F8: Deployment Helpers](#f8-deployment-helpers-p2-8h)
3. [CLI Command Reference](#3-cli-command-reference)
4. [Playground Architecture](#4-playground-architecture)
5. [File Structure](#5-file-structure)
6. [Testing Strategy](#6-testing-strategy)

---

## 1. Architecture Overview

### 1.1 Developer Workflow

The DzipAgent developer workflow follows four phases: **create**, **develop**, **test**, and **deploy**. Each phase has dedicated tooling that shares a common configuration surface (`forgeagent.config.json` and `ForgeConfig` from `@dzipagent/core`).

```
                          DEVELOPER WORKFLOW
  ============================================================

  CREATE                DEVELOP              TEST               DEPLOY
  ------                -------              ----               ------
  npx create-           forgeagent dev       forgeagent test    forgeagent deploy
  forgeagent            (hot reload +        (unit + eval)      (docker/k8s/
                         trace viewer)                           vercel/lambda/
  Interactive                                                    cloudflare)
  prompts:              Playground UI        forgeagent
  - template            at /playground       test:scaffold      Health check
  - features            (chat, tools,        (generate tests    validation
  - database             memory, traces)     from config)
  - plugins                                                     Rollback
                        forgeagent add       forgeagent eval    support
  Generates:            <plugin>             (LLM-as-judge
  - tsconfig            (install plugins)    scoring)
  - package.json
  - .env.example        Config editor
  - docker-compose      in playground
  - agent scaffolds
  - forgeagent.config.json

  ============================================================
       All phases read forgeagent.config.json (ForgeConfig)
       All phases emit events to DzipEventBus for tracing
  ============================================================
```

### 1.2 CLI Architecture

The CLI is a standalone package (`create-dzipagent`) that generates project scaffolds, and a binary entrypoint (`forgeagent`) embedded in `@dzipagent/server` for runtime commands (`dev`, `add`, `test:scaffold`, `deploy`).

```
  create-dzipagent (npx)           @dzipagent/server (forgeagent bin)
  ========================          ==================================
  - Project scaffolding             - forgeagent dev
  - Template selection              - forgeagent add <plugin>
  - Dependency installation         - forgeagent test:scaffold
  - First-run wizard                - forgeagent deploy <target>
                                    - forgeagent eval
                                    - forgeagent docs:generate

  Both read:
  - @dzipagent/core (ForgeConfig, resolveConfig, validateConfig)
  - @dzipagent/agent (AgentTemplate, AGENT_TEMPLATES)
  - Plugin manifests (forgeagent-plugin.json)
```

**Rationale for the split:** `create-dzipagent` is a one-time scaffolding tool that should not require installing the full server runtime. Runtime commands live in `@dzipagent/server` because they need access to the Hono app, event bus, persistence, and WebSocket infrastructure.

### 1.3 Playground Architecture (High Level)

The playground is a Vue 3 + Vite SPA served from a `/playground` route on the `@dzipagent/server` Hono app. It communicates with the server via the existing REST API (`/api/runs`, `/api/agents`) and the WebSocket `EventBridge` for real-time streaming.

```
  Browser (Vue 3 SPA)              @dzipagent/server (Hono)
  ====================              ===========================
  Chat Interface  ----REST POST---> /api/runs (create run)
  Tool Visualizer <---WebSocket---- EventBridge (stream events)
  Memory Browser  ----REST GET----> /api/memory/:namespace
  Trace Viewer    ----REST GET----> /api/runs/:id/trace
  Config Editor   ----REST PUT----> /api/agents/:id
```

### 1.4 Plugin Ecosystem

The existing plugin infrastructure provides the foundation:

- **`DzipPlugin` interface** (`@dzipagent/core/plugin/plugin-types.ts`) — plugin contract with `onRegister`, middleware, hooks, event handlers
- **`PluginRegistry`** (`@dzipagent/core/plugin/plugin-registry.ts`) — registration, conflict detection, aggregated middleware/hooks
- **`PluginManifest` + `discoverPlugins`** (`@dzipagent/core/plugin/plugin-discovery.ts`) — filesystem scanning, manifest validation, topological sort
- **`createManifest` + `serializeManifest`** (`@dzipagent/core/plugin/plugin-manifest.ts`) — manifest creation helpers

The marketplace builds on top of this with an npm-based registry, signed manifests, and a browsable web UI.

---

## 2. Feature Specifications

### F1: create-dzipagent CLI (P1, 12h)

#### 2.1.1 Overview

A scaffolding CLI invoked via `npx create-dzipagent` that generates a ready-to-run DzipAgent project. Inspired by `create-mastra` but tailored to DzipAgent's package architecture and configuration system.

#### 2.1.2 Interactive Prompts

The CLI uses `@clack/prompts` for a polished terminal UI. The prompt sequence:

```
Step 1: Project name
  > Input: "my-agent" (validated: kebab-case, no special chars)

Step 2: Template
  > Select one:
    - minimal      — Single agent, no server, no persistence
    - full-stack   — Agent + server + Postgres + playground
    - codegen      — Code generation pipeline with VFS + sandbox
    - multi-agent  — Orchestrator + sub-agents with workflow
    - server       — HTTP API only (no agent logic scaffolded)

Step 3: Features (multi-select, varies by template)
  > [ ] Memory (persistent memory with consolidation)
  > [ ] MCP (Model Context Protocol tools)
  > [ ] Streaming (SSE streaming responses)
  > [ ] Playground (web UI for testing)
  > [ ] Observability (Langfuse/OpenTelemetry)
  > [ ] Security (PII detection, secrets scanning)
  > [ ] Approval gates (human-in-the-loop)

Step 4: Database (only if Memory or full-stack selected)
  > Select: in-memory | postgres

Step 5: Deployment target (optional)
  > Select: none | docker | vercel | aws-lambda | cloudflare

Step 6: LLM Provider
  > Select: anthropic | openai | custom
  > If anthropic/openai: prompt for API key (stored in .env)

Step 7: Confirmation
  > Review selections, confirm or edit
```

#### 2.1.3 Generated Project Structure

For a `full-stack` template with Memory + Playground + Postgres:

```
my-agent/
  package.json              # ESM, strict TS, workspace deps
  tsconfig.json             # strict: true, ESM paths
  forgeagent.config.json    # ForgeConfig with chosen options
  .env.example              # DZIP_* env vars, API keys
  .gitignore
  docker-compose.yml        # Postgres + app (if docker target)
  Dockerfile                # Multi-stage Node 20 build
  README.md                 # Getting started guide

  src/
    index.ts                # Entry: resolveConfig + createForgeApp + listen
    agents/
      main-agent.ts         # DzipAgent with template-based config
    tools/
      example-tool.ts       # createForgeTool example
    plugins/
      index.ts              # Plugin registration

  tests/
    agents/
      main-agent.test.ts    # Basic agent test with mock model
```

For a `minimal` template:

```
my-agent/
  package.json
  tsconfig.json
  forgeagent.config.json
  .env.example
  src/
    index.ts                # DzipAgent + generate() call
  tests/
    index.test.ts
```

#### 2.1.4 Template Engine

Templates are stored as EJS files within the `create-dzipagent` package. Each template variant has a manifest declaring which files to generate and which variables to interpolate.

```typescript
// packages/create-dzipagent/src/templates/template-manifest.ts

interface TemplateManifest {
  /** Template identifier matching the CLI select option */
  id: 'minimal' | 'full-stack' | 'codegen' | 'multi-agent' | 'server'
  /** Human-readable name */
  name: string
  /** Files to generate — paths relative to project root */
  files: TemplateFile[]
  /** npm dependencies to install */
  dependencies: Record<string, string>
  /** npm devDependencies to install */
  devDependencies: Record<string, string>
  /** Features enabled by default for this template */
  defaultFeatures: string[]
}

interface TemplateFile {
  /** Source template path (relative to templates/ dir) */
  source: string
  /** Output path (relative to generated project root) */
  target: string
  /** Only include if these features are selected */
  requiredFeatures?: string[]
}
```

#### 2.1.5 First-Run Experience

After scaffolding completes, the CLI:

1. Runs `npm install` (or `pnpm install` / `yarn` based on detected lockfile)
2. Creates `.env` from `.env.example` with user-provided API key
3. If Postgres selected and Docker available: `docker compose up -d postgres`
4. Prints a "Getting Started" banner:

```
  Your DzipAgent project is ready!

  cd my-agent
  npm run dev          # Start dev server with hot reload
  npm run test         # Run tests
  npm run build        # Build for production

  Open http://localhost:3000/playground for the agent playground.
```

#### 2.1.6 Plugin Installation Command

The runtime CLI (from `@dzipagent/server`) provides `forgeagent add`:

```bash
# Install a plugin from npm
forgeagent add @dzipagent/plugin-langfuse

# Install from local path
forgeagent add ./my-plugin

# Install multiple
forgeagent add @dzipagent/plugin-langfuse @dzipagent/plugin-sentry
```

The `add` command:

1. Runs `npm install <package>`
2. Reads the package's `forgeagent-plugin.json` manifest
3. Validates the manifest via `validateManifest()`
4. Appends the plugin to `forgeagent.config.json` `plugins` array
5. Prints the plugin's capabilities and any required environment variables

#### 2.1.7 Interface Contracts

```typescript
// packages/create-dzipagent/src/types.ts

/** User selections from the interactive prompts */
export interface ScaffoldOptions {
  projectName: string
  template: 'minimal' | 'full-stack' | 'codegen' | 'multi-agent' | 'server'
  features: Set<string>
  database: 'in-memory' | 'postgres'
  deployTarget: 'none' | 'docker' | 'vercel' | 'aws-lambda' | 'cloudflare'
  llmProvider: 'anthropic' | 'openai' | 'custom'
  apiKey?: string
}

/** Result of project generation */
export interface ScaffoldResult {
  projectDir: string
  filesCreated: string[]
  dependenciesInstalled: boolean
  envCreated: boolean
  errors: string[]
}

/** Main entry point for the scaffolding engine */
export interface ScaffoldEngine {
  /** Run interactive prompts and collect user options */
  prompt(): Promise<ScaffoldOptions>
  /** Generate the project from options */
  generate(options: ScaffoldOptions): Promise<ScaffoldResult>
  /** Install dependencies */
  install(projectDir: string): Promise<void>
  /** Create .env from .env.example */
  createEnv(projectDir: string, options: ScaffoldOptions): Promise<void>
}
```

#### 2.1.8 Dependency Notes

| Dependency | Version | Purpose | Type |
|-----------|---------|---------|------|
| `@clack/prompts` | ^0.8 | Interactive terminal UI | direct |
| `ejs` | ^3.1 | Template rendering | direct |
| `execa` | ^9.0 | Subprocess execution (npm install) | direct |
| `picocolors` | ^1.1 | Terminal colors | direct |
| `fs-extra` | ^11.2 | Filesystem utilities | direct |

---

### F2: Agent Playground (P2, 24h)

#### 2.2.1 Overview

A web-based UI for interactively testing DzipAgent agents. Served at `/playground` from the `@dzipagent/server` Hono app. Built with Vue 3 + Vite to match the project's frontend stack.

#### 2.2.2 Feature Set

| Feature | Description |
|---------|-------------|
| **Chat Interface** | Send messages to agents, view responses with markdown rendering |
| **Agent Selector** | Pick from registered agents via `/api/agents` |
| **Tool Call Visualization** | Collapsible panels showing tool name, arguments, result, duration |
| **Memory Browser** | Search and browse memory namespaces, view/edit memory entries |
| **Trace Viewer** | Timeline visualization of agent execution (LLM calls, tool calls, events) |
| **Config Editor** | Edit agent configuration (instructions, guardrails, tools) with live validation |
| **Cost Dashboard** | Real-time token usage and cost tracking per run |
| **Run History** | Browse past runs with filtering and replay |

#### 2.2.3 Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Framework | Vue 3.4+ Composition API | Matches project stack |
| Build | Vite 6 | Fast HMR, native ESM |
| State | Pinia | Vue 3 standard store |
| Styling | Tailwind CSS 4 | Matches project stack |
| Markdown | `markdown-it` + `shiki` | Code highlighting in chat |
| WebSocket | Native WebSocket API | Connects to `EventBridge` |
| HTTP | `ofetch` | Lightweight fetch wrapper |

#### 2.2.4 Serving Strategy

The playground is pre-built as static assets and served from a catch-all route in `@dzipagent/server`. This avoids bundling Vite as a server dependency.

```typescript
// packages/forgeagent-server/src/routes/playground.ts

import { Hono } from 'hono'
import { serveStatic } from 'hono/serve-static'

export function createPlaygroundRoutes(): Hono {
  const app = new Hono()

  // Serve pre-built playground assets
  app.use(
    '/playground/*',
    serveStatic({
      root: './node_modules/@dzipagent/playground/dist',
      rewriteRequestPath: (path) => path.replace('/playground', ''),
    }),
  )

  // SPA fallback for client-side routing
  app.get('/playground/*', serveStatic({
    root: './node_modules/@dzipagent/playground/dist',
    rewriteRequestPath: () => '/index.html',
  }))

  return app
}
```

In development mode, `forgeagent dev` optionally proxies to a Vite dev server for HMR on the playground itself.

#### 2.2.5 WebSocket Protocol

The playground connects to the server's WebSocket endpoint and subscribes to events for the active run. Messages follow the existing `DzipEvent` type system from `@dzipagent/core/events/event-types.ts`.

```typescript
// Client -> Server messages
interface PlaygroundClientMessage {
  type: 'subscribe' | 'unsubscribe'
  runId: string
}

// Server -> Client messages (DzipEvent, forwarded by EventBridge)
// Already defined in @dzipagent/core:
// - agent:started, agent:completed, agent:failed
// - tool:called, tool:completed, tool:failed
// - llm:request, llm:response
// - budget:warning, budget:exceeded
// - memory:stored, memory:retrieved
```

The `EventBridge` in `@dzipagent/server/ws/event-bridge.ts` already handles this pattern. The playground connects as a `WSClient` with a `ClientFilter` for the active `runId`.

#### 2.2.6 New Server Routes for Playground

The playground requires two additional API routes not currently present:

```typescript
// GET /api/memory/:namespace — Browse memory entries
// Query params: ?scope=key:value&limit=50&search=term
interface MemoryBrowseResponse {
  entries: Array<{
    key: string
    value: Record<string, unknown>
    createdAt: string
    updatedAt: string
    score?: number
  }>
  total: number
}

// GET /api/runs/:id/trace — Get execution trace for a run
interface RunTraceResponse {
  runId: string
  agentId: string
  startedAt: string
  completedAt?: string
  events: Array<{
    type: string
    timestamp: string
    data: Record<string, unknown>
    duration?: number
  }>
  usage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCostCents: number
    llmCalls: number
  }
}
```

#### 2.2.7 Component Hierarchy

```
PlaygroundApp
  +-- PlaygroundHeader
  |     +-- AgentSelector (dropdown, calls GET /api/agents)
  |     +-- ConnectionStatus (WebSocket state indicator)
  |     +-- CostBadge (running cost from budget events)
  |
  +-- PlaygroundLayout (resizable panels)
        +-- ChatPanel (left, primary)
        |     +-- MessageList
        |     |     +-- UserMessage
        |     |     +-- AssistantMessage (markdown-rendered)
        |     |     +-- ToolCallMessage (collapsible)
        |     |     +-- SystemMessage
        |     +-- ChatInput
        |           +-- MessageTextarea (shift+enter for newline)
        |           +-- SendButton
        |           +-- StopButton (sends abort signal)
        |
        +-- InspectorPanel (right, tabbed)
              +-- TraceTab
              |     +-- TraceTimeline (vertical timeline of events)
              |     +-- TraceEventDetail (selected event JSON)
              +-- MemoryTab
              |     +-- MemoryNamespaceList
              |     +-- MemorySearch
              |     +-- MemoryEntryList
              |     +-- MemoryEntryEditor (JSON editor)
              +-- ConfigTab
              |     +-- AgentConfigForm (instructions, guardrails)
              |     +-- ToolList (registered tools with descriptions)
              +-- HistoryTab
                    +-- RunList (paginated, filterable)
                    +-- RunDetail (selected run summary)
```

#### 2.2.8 State Management (Pinia)

```typescript
// packages/forgeagent-playground/src/stores/agent-store.ts
interface AgentState {
  agents: AgentSummary[]
  activeAgentId: string | null
  loading: boolean
}

// packages/forgeagent-playground/src/stores/chat-store.ts
interface ChatState {
  messages: ChatMessage[]
  activeRunId: string | null
  isStreaming: boolean
  abortController: AbortController | null
}

// packages/forgeagent-playground/src/stores/trace-store.ts
interface TraceState {
  events: TraceEvent[]
  selectedEventIndex: number | null
  usage: UsageSummary
}

// packages/forgeagent-playground/src/stores/memory-store.ts
interface MemoryState {
  namespaces: string[]
  activeNamespace: string | null
  entries: MemoryEntry[]
  searchQuery: string
}

// packages/forgeagent-playground/src/stores/ws-store.ts
interface WebSocketState {
  connected: boolean
  reconnectAttempts: number
}
```

---

### F3: Plugin Marketplace (P3, 20h)

#### 2.3.1 Overview

A registry and browsable UI for discovering, installing, and managing DzipAgent plugins. Plugins are distributed via npm with a `forgeagent-plugin.json` manifest (already implemented in `@dzipagent/core/plugin/plugin-discovery.ts`).

#### 2.3.2 Registry Design

The marketplace operates at two levels:

1. **npm-based distribution** — Plugins are standard npm packages with a `forgeagent-plugin.json` manifest. No custom registry server required for basic discovery.
2. **DzipAgent Registry API** (optional) — A centralized API for curated listing, ratings, download counts, and verification status. This is a future SaaS feature.

For the initial implementation, the registry is a static JSON index published to a well-known URL and cached locally.

```typescript
// Registry index format (hosted at registry.forgeagent.dev/v1/plugins.json)
interface PluginRegistryIndex {
  version: 1
  updatedAt: string
  plugins: PluginRegistryEntry[]
}

interface PluginRegistryEntry {
  /** npm package name */
  packageName: string
  /** Display name */
  displayName: string
  /** Short description */
  description: string
  /** Latest version on npm */
  latestVersion: string
  /** Plugin capabilities from manifest */
  capabilities: string[]
  /** npm weekly downloads */
  downloads: number
  /** Author/org */
  author: string
  /** Verification status */
  verified: boolean
  /** Minimum DzipAgent version */
  minForgeVersion: string
  /** Category for browsing */
  category: 'observability' | 'security' | 'memory' | 'tools' | 'connectors' | 'other'
  /** Repository URL */
  repository?: string
}
```

#### 2.3.3 Plugin Verification

Verified plugins receive a checkmark in the marketplace UI. Verification criteria:

1. Valid `forgeagent-plugin.json` manifest (passes `validateManifest()`)
2. TypeScript strict mode (no `any` types)
3. Exports a valid `DzipPlugin` object
4. Has at least one published test
5. Signed by a known author (npm provenance attestation)

Verification is performed by a CI pipeline (not runtime). Verified status is recorded in the registry index.

#### 2.3.4 Install/Update/Remove Workflow

```bash
# Install from marketplace
forgeagent add @dzipagent/plugin-langfuse
# Equivalent to:
#   npm install @dzipagent/plugin-langfuse
#   + validate manifest
#   + append to forgeagent.config.json plugins[]

# Update a plugin
forgeagent update @dzipagent/plugin-langfuse
# Equivalent to:
#   npm update @dzipagent/plugin-langfuse
#   + re-validate manifest

# Remove a plugin
forgeagent remove @dzipagent/plugin-langfuse
# Equivalent to:
#   npm uninstall @dzipagent/plugin-langfuse
#   + remove from forgeagent.config.json plugins[]

# List installed plugins with status
forgeagent plugins
# Output:
#   @dzipagent/plugin-langfuse  1.2.0  [verified]  observability
#   ./my-local-plugin            0.1.0  [local]     tools

# Browse marketplace
forgeagent marketplace
# Opens browser to registry.forgeagent.dev or prints table in terminal
```

#### 2.3.5 Marketplace UI

The marketplace is a tab within the Playground (`PluginMarketplaceTab`) and also a standalone page at `/playground/marketplace`.

```
MarketplacePage
  +-- SearchBar (full-text search across name, description, capabilities)
  +-- CategoryFilter (sidebar with category counts)
  +-- PluginGrid
        +-- PluginCard
              +-- PluginIcon (auto-generated from name)
              +-- PluginName + VerifiedBadge
              +-- Description (truncated)
              +-- CapabilityTags
              +-- DownloadCount + Version
              +-- InstallButton (calls forgeagent add)
```

---

### F4: Agent Templates Library (P1, 8h)

#### 2.4.1 Overview

Expand the current 6 templates (`code-reviewer`, `data-analyst`, `devops-agent`, `security-auditor`, `documentation-agent`, `migration-agent`) to 20+ covering common agent patterns. Templates remain in `@dzipagent/agent/templates/agent-templates.ts` as data objects.

#### 2.4.2 New Templates

**Code Category:**

| ID | Name | Model Tier | Description |
|----|------|-----------|-------------|
| `code-reviewer` | Code Reviewer | reasoning | (existing) |
| `migration-agent` | Migration Agent | codegen | (existing) |
| `refactoring-agent` | Refactoring Agent | codegen | Identifies and applies refactoring patterns (extract method, rename, inline) |
| `test-writer` | Test Writer | codegen | Generates unit/integration tests from source code |
| `bug-fixer` | Bug Fixer | reasoning | Diagnoses bugs from error reports and stack traces, proposes fixes |
| `code-explainer` | Code Explainer | chat | Explains code in plain language, generates inline comments |

**Data Category:**

| ID | Name | Model Tier | Description |
|----|------|-----------|-------------|
| `data-analyst` | Data Analyst | reasoning | (existing) |
| `data-pipeline` | Data Pipeline Builder | codegen | Generates ETL pipelines, data transformations, schema migrations |
| `csv-processor` | CSV/JSON Processor | chat | Parses, transforms, and analyzes tabular data files |

**Infrastructure Category:**

| ID | Name | Model Tier | Description |
|----|------|-----------|-------------|
| `devops-agent` | DevOps Agent | codegen | (existing) |
| `k8s-operator` | Kubernetes Operator | codegen | Generates and troubleshoots K8s manifests, Helm charts |
| `terraform-agent` | Terraform Agent | codegen | Writes and plans Terraform/OpenTofu infrastructure |
| `monitoring-agent` | Monitoring Agent | reasoning | Configures alerts, analyzes metrics, diagnoses incidents |

**Content Category:**

| ID | Name | Model Tier | Description |
|----|------|-----------|-------------|
| `documentation-agent` | Documentation Agent | chat | (existing) |
| `api-spec-writer` | API Spec Writer | codegen | Generates OpenAPI specs from code or natural language |
| `changelog-agent` | Changelog Agent | chat | Generates changelogs from git history and PR descriptions |
| `copywriter` | Copywriter | chat | Writes marketing copy, blog posts, landing page content |

**Research Category:**

| ID | Name | Model Tier | Description |
|----|------|-----------|-------------|
| `research-agent` | Research Agent | reasoning | Multi-step web research with source citation |
| `summarizer` | Summarizer | chat | Summarizes documents, articles, codebases |

**Automation Category:**

| ID | Name | Model Tier | Description |
|----|------|-----------|-------------|
| `security-auditor` | Security Auditor | reasoning | (existing) |
| `workflow-agent` | Workflow Automator | reasoning | Builds multi-step automation workflows from natural language |
| `email-agent` | Email Processor | chat | Classifies, summarizes, and drafts email responses |
| `scheduler` | Scheduler Agent | chat | Plans and schedules tasks with dependency awareness |

#### 2.4.3 Template Composition

Allow combining multiple templates to create composite agents. This is implemented as a merge function, not inheritance.

```typescript
// packages/forgeagent-agent/src/templates/template-composer.ts

/**
 * Compose multiple templates into a single agent configuration.
 *
 * Instructions are concatenated with section headers.
 * Guardrails use the maximum of each budget.
 * Tools and tags are unioned.
 *
 * @example
 * ```ts
 * const composed = composeTemplates(
 *   getAgentTemplate('code-reviewer')!,
 *   getAgentTemplate('security-auditor')!,
 * )
 * // Result: an agent that reviews code AND audits for security
 * ```
 */
export function composeTemplates(...templates: AgentTemplate[]): AgentTemplate {
  if (templates.length === 0) {
    throw new Error('At least one template is required for composition')
  }

  const ids = templates.map(t => t.id)
  const composedId = ids.join('+')

  const instructionParts = templates.map(t =>
    `## ${t.name} Role\n${t.instructions}`
  )

  const allTools = new Set<string>()
  const allTags = new Set<string>()
  for (const t of templates) {
    for (const tool of t.suggestedTools) allTools.add(tool)
    for (const tag of t.tags) allTags.add(tag)
  }

  return {
    id: composedId,
    name: templates.map(t => t.name).join(' + '),
    description: `Composite agent: ${templates.map(t => t.description).join('; ')}`,
    instructions: instructionParts.join('\n\n'),
    modelTier: resolveHighestTier(templates.map(t => t.modelTier)),
    suggestedTools: [...allTools],
    guardrails: {
      maxTokens: Math.max(...templates.map(t => t.guardrails.maxTokens)),
      maxCostCents: Math.max(...templates.map(t => t.guardrails.maxCostCents)),
      maxIterations: Math.max(...templates.map(t => t.guardrails.maxIterations)),
    },
    tags: [...allTags],
  }
}

function resolveHighestTier(tiers: Array<'chat' | 'reasoning' | 'codegen'>): 'chat' | 'reasoning' | 'codegen' {
  const priority: Record<string, number> = { chat: 0, reasoning: 1, codegen: 2 }
  let highest = 'chat' as 'chat' | 'reasoning' | 'codegen'
  for (const tier of tiers) {
    if (priority[tier]! > priority[highest]!) highest = tier
  }
  return highest
}
```

#### 2.4.4 Custom Template Creation

Users can define custom templates in their project and register them with the template registry.

```typescript
// packages/forgeagent-agent/src/templates/template-registry.ts

/**
 * A mutable template registry that starts with built-in templates
 * and allows user-defined additions.
 */
export class TemplateRegistry {
  private templates = new Map<string, AgentTemplate>()

  constructor() {
    // Load built-in templates
    for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
      this.templates.set(id, template)
    }
  }

  /** Register a custom template. Throws on duplicate ID unless override is true. */
  register(template: AgentTemplate, options?: { override?: boolean }): void {
    if (this.templates.has(template.id) && !options?.override) {
      throw new Error(`Template "${template.id}" already exists. Pass { override: true } to replace.`)
    }
    this.templates.set(template.id, template)
  }

  /** Get a template by ID */
  get(id: string): AgentTemplate | undefined {
    return this.templates.get(id)
  }

  /** List all template IDs */
  list(): string[] {
    return [...this.templates.keys()]
  }

  /** List templates filtered by tag */
  listByTag(tag: string): AgentTemplate[] {
    return [...this.templates.values()].filter(t => t.tags.includes(tag))
  }

  /** List templates filtered by category (derived from first tag) */
  listByCategory(category: string): AgentTemplate[] {
    const categoryTags: Record<string, string[]> = {
      code: ['code-quality', 'review', 'refactor', 'testing', 'migration'],
      data: ['data', 'analytics', 'etl', 'sql'],
      infrastructure: ['devops', 'kubernetes', 'terraform', 'monitoring'],
      content: ['documentation', 'api-docs', 'changelog', 'copywriting'],
      research: ['research', 'summarization'],
      automation: ['security', 'workflow', 'email', 'scheduling'],
    }

    const tags = categoryTags[category] ?? []
    return [...this.templates.values()].filter(t =>
      t.tags.some(tag => tags.includes(tag))
    )
  }
}
```

#### 2.4.5 Template Testing Framework

Every template must have a validation test that verifies:

1. The template has all required fields
2. `suggestedTools` are non-empty
3. Guardrails have reasonable bounds (maxTokens > 0, maxCostCents > 0)
4. Instructions are at least 50 characters
5. Tags are non-empty

```typescript
// packages/forgeagent-agent/src/templates/__tests__/template-validation.test.ts

import { describe, it, expect } from 'vitest'
import { AGENT_TEMPLATES } from '../agent-templates.js'
import type { AgentTemplate } from '../agent-templates.js'

function validateTemplate(template: AgentTemplate): string[] {
  const errors: string[] = []
  if (!template.id || template.id.length === 0) errors.push('id is required')
  if (!template.name || template.name.length === 0) errors.push('name is required')
  if (!template.description || template.description.length === 0) errors.push('description is required')
  if (!template.instructions || template.instructions.length < 50) {
    errors.push('instructions must be at least 50 characters')
  }
  if (!['chat', 'reasoning', 'codegen'].includes(template.modelTier)) {
    errors.push(`invalid modelTier: ${template.modelTier}`)
  }
  if (template.suggestedTools.length === 0) errors.push('suggestedTools must be non-empty')
  if (template.guardrails.maxTokens <= 0) errors.push('maxTokens must be positive')
  if (template.guardrails.maxCostCents <= 0) errors.push('maxCostCents must be positive')
  if (template.guardrails.maxIterations <= 0) errors.push('maxIterations must be positive')
  if (template.tags.length === 0) errors.push('tags must be non-empty')
  return errors
}

describe('Agent Templates', () => {
  for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
    it(`template "${id}" passes validation`, () => {
      const errors = validateTemplate(template)
      expect(errors).toEqual([])
    })
  }
})
```

---

### F5: Documentation Generation (P2, 8h)

#### 2.5.1 Overview

Auto-generate documentation from DzipAgent configurations, tool definitions, memory schemas, and pipeline definitions. Output as Markdown files suitable for static site generators (VitePress, Docusaurus).

#### 2.5.2 Command

```bash
forgeagent docs:generate [--output ./docs/api] [--format markdown|html]
```

#### 2.5.3 Documentation Sources

| Source | Generated Doc |
|--------|--------------|
| `DzipAgentConfig` objects | Agent reference (instructions, guardrails, model tier) |
| `StructuredToolInterface` definitions | Tool reference (name, description, schema, examples) |
| `MemoryService` namespaces | Memory schema reference (namespace, scope shape, retention) |
| Pipeline definitions (`WorkflowBuilder`) | Pipeline flow diagrams (Mermaid) |
| `forgeagent.config.json` | Configuration reference |
| `DzipPlugin` objects | Plugin reference (capabilities, hooks, events) |

#### 2.5.4 Doc Generator Interface

```typescript
// packages/forgeagent-server/src/docs/doc-generator.ts

interface DocGeneratorConfig {
  /** Directory to write generated docs */
  outputDir: string
  /** Output format */
  format: 'markdown' | 'html'
  /** Agent configs to document */
  agents: DzipAgentConfig[]
  /** Registered tools */
  tools: StructuredToolInterface[]
  /** Registered plugins */
  plugins: DzipPlugin[]
  /** Workflow definitions */
  workflows?: Array<{ name: string; steps: WorkflowStep[] }>
  /** Include interactive examples (runnable code blocks) */
  interactive?: boolean
}

interface GeneratedDoc {
  /** File path relative to outputDir */
  path: string
  /** File content */
  content: string
  /** Document title for index */
  title: string
}

interface DocGenerator {
  generate(config: DocGeneratorConfig): Promise<GeneratedDoc[]>
}
```

#### 2.5.5 Generated Structure

```
docs/api/
  index.md                    # Overview + table of contents
  agents/
    code-reviewer.md          # Agent reference page
    data-analyst.md
  tools/
    read_file.md              # Tool reference with schema + examples
    write_file.md
  memory/
    conversations.md          # Memory namespace documentation
    lessons.md
  pipelines/
    code-review-pipeline.md   # Pipeline flow diagram (Mermaid)
  plugins/
    langfuse.md               # Plugin reference
  config.md                   # Configuration reference
```

#### 2.5.6 Tool Documentation Example

For each tool, the generator produces:

```markdown
# read_file

Read the contents of a file from the filesystem.

## Schema

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the file |
| `encoding` | string | no | File encoding (default: utf-8) |

## Example

\`\`\`typescript
const result = await readFileTool.invoke({
  path: '/src/index.ts',
  encoding: 'utf-8',
})
\`\`\`

## Used By

- code-reviewer
- documentation-agent
- migration-agent
```

---

### F6: Integration Test Scaffolding (P1, 4h)

#### 2.6.1 Overview

Generate test files from agent configuration, reducing boilerplate for testing agents, tools, and pipelines.

#### 2.6.2 Command

```bash
# Scaffold tests for all agents in the project
forgeagent test:scaffold

# Scaffold tests for a specific agent
forgeagent test:scaffold --agent code-reviewer

# Scaffold with specific patterns
forgeagent test:scaffold --pattern unit,integration,eval
```

#### 2.6.3 Generated Test Patterns

For an agent named `code-reviewer`, the scaffolder generates:

```
tests/
  agents/
    code-reviewer.test.ts         # Unit test: mock model, verify tool calls
    code-reviewer.integration.ts  # Integration: real model (guarded by env flag)
    code-reviewer.eval.ts         # Eval: LLM-as-judge scoring
```

#### 2.6.4 Unit Test Template

```typescript
// Generated: tests/agents/code-reviewer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DzipAgent } from '@dzipagent/agent'
import { HumanMessage } from '@langchain/core/messages'

// Mock model that returns a predetermined response
const mockModel = {
  invoke: vi.fn().mockResolvedValue({
    content: 'Code review: No critical issues found.',
    tool_calls: [],
    _getType: () => 'ai',
  }),
  bindTools: vi.fn().mockReturnThis(),
} as unknown as import('@langchain/core/language_models/chat_models').BaseChatModel

describe('code-reviewer agent', () => {
  it('generates a response without errors', async () => {
    const agent = new DzipAgent({
      id: 'code-reviewer',
      instructions: 'You are a code reviewer.',
      model: mockModel,
      guardrails: { maxTokens: 50_000, maxCostCents: 25, maxIterations: 5 },
    })

    const result = await agent.generate([
      new HumanMessage('Review this function: function add(a, b) { return a + b }'),
    ])

    expect(result.content).toBeDefined()
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.hitIterationLimit).toBe(false)
  })

  // TODO: Add tool call verification tests
  // TODO: Add guardrail limit tests
  // TODO: Add memory integration tests
})
```

#### 2.6.5 Mock Setup Helpers

The scaffolder also generates a shared mock setup file:

```typescript
// Generated: tests/helpers/forge-mocks.ts
import { vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage } from '@langchain/core/messages'

/**
 * Create a mock chat model that returns predetermined responses.
 * Supports tool call simulation.
 */
export function createMockModel(options?: {
  responses?: string[]
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
}): BaseChatModel {
  let callIndex = 0
  const responses = options?.responses ?? ['Mock response']

  return {
    invoke: vi.fn().mockImplementation(() => {
      const content = responses[callIndex % responses.length] ?? ''
      callIndex++
      return Promise.resolve(new AIMessage({
        content,
        tool_calls: callIndex === 1 ? (options?.toolCalls ?? []) : [],
      }))
    }),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(),
  } as unknown as BaseChatModel
}

/**
 * Create a mock memory service that records get/put calls.
 */
export function createMockMemory(): import('@dzipagent/core').MemoryService {
  const store = new Map<string, unknown[]>()
  return {
    get: vi.fn().mockImplementation((ns: string) =>
      Promise.resolve(store.get(ns) ?? [])
    ),
    put: vi.fn().mockImplementation((ns: string, _scope: unknown, value: unknown) => {
      const existing = store.get(ns) ?? []
      existing.push(value)
      store.set(ns, existing)
      return Promise.resolve()
    }),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as import('@dzipagent/core').MemoryService
}
```

---

### F7: Development Mode (P1, 4h)

#### 2.7.1 Overview

A `forgeagent dev` command that starts the server with hot reload, live trace output, and cost tracking in the terminal.

#### 2.7.2 Command

```bash
forgeagent dev [--port 3000] [--no-playground] [--verbose]
```

#### 2.7.3 Features

| Feature | Description |
|---------|-------------|
| **Hot Reload** | Watches `src/` for `.ts` file changes, restarts server via `tsx --watch` |
| **Live Trace Viewer** | Prints agent events to terminal in a structured format |
| **Cost Tracker** | Displays cumulative token usage and cost in the terminal header |
| **Memory Browser** | `forgeagent memory:browse <namespace>` in a separate terminal |
| **Config Watch** | Reloads `forgeagent.config.json` on change without restart |

#### 2.7.4 Terminal Output Format

```
  DzipAgent Dev Server
  http://localhost:3000
  Playground: http://localhost:3000/playground

  Agents: code-reviewer, data-analyst
  Plugins: langfuse (observability)
  Memory: in-memory
  Cost: $0.00 (0 tokens)

  ─── Events ─────────────────────────────────────────
  12:34:56 [run:abc] agent:started    code-reviewer
  12:34:57 [run:abc] llm:request      claude-sonnet (1,234 tokens)
  12:34:59 [run:abc] tool:called      read_file {path: "/src/index.ts"}
  12:35:00 [run:abc] tool:completed   read_file (142ms)
  12:35:01 [run:abc] llm:request      claude-sonnet (2,456 tokens)
  12:35:03 [run:abc] agent:completed  code-reviewer ($0.02, 3.7K tokens)
  ────────────────────────────────────────────────────
```

#### 2.7.5 Implementation

The `dev` command is implemented in `@dzipagent/server` as a CLI subcommand.

```typescript
// packages/forgeagent-server/src/cli/dev-command.ts

interface DevCommandOptions {
  port?: number
  playground?: boolean
  verbose?: boolean
  configFile?: string
}

/**
 * Start the DzipAgent dev server with hot reload and live tracing.
 *
 * 1. Resolves config from forgeagent.config.json + env
 * 2. Creates DzipEventBus and subscribes trace printer
 * 3. Creates ForgeApp with playground route (if enabled)
 * 4. Starts Hono server on configured port
 * 5. Watches src/ for changes and restarts on modification
 */
async function devCommand(options: DevCommandOptions): Promise<void> {
  // Implementation delegates to tsx --watch for file watching
  // and the existing createForgeApp for server setup
}
```

The file watching delegates to `tsx --watch` (already a common devDependency) rather than implementing a custom watcher. The trace printer subscribes to `DzipEventBus.onAny()` and formats events for terminal display.

---

### F8: Deployment Helpers (P2, 8h)

#### 2.8.1 Overview

Generate deployment configurations for various platforms. Builds on the existing platform adapters in `@dzipagent/server/platforms/` (`lambda.ts`, `vercel.ts`, `cloudflare.ts`).

#### 2.8.2 Command

```bash
forgeagent deploy <target> [--dry-run]
```

**Targets:**

| Target | Generated Files | Action |
|--------|----------------|--------|
| `docker` | `Dockerfile`, `docker-compose.yml`, `.dockerignore` | Build + push |
| `k8s` | `k8s/deployment.yml`, `k8s/service.yml`, `k8s/configmap.yml` | Apply with kubectl |
| `vercel` | `vercel.json`, `api/index.ts` (entry point using `toVercelHandler`) | `vercel deploy` |
| `aws-lambda` | `serverless.yml` or `cdk.ts`, handler using `toLambdaHandler` | `cdk deploy` or `sls deploy` |
| `cloudflare` | `wrangler.toml`, handler using `toCloudflareHandler` | `wrangler deploy` |

#### 2.8.3 Docker Target

```bash
forgeagent deploy docker [--tag my-agent:latest] [--push registry.example.com]
```

Generates:

```dockerfile
# Generated: Dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
```

```yaml
# Generated: docker-compose.yml
services:
  agent:
    build: .
    ports:
      - "${DZIP_PORT:-3000}:3000"
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: forge
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: forgeagent
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U forge"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

#### 2.8.4 Kubernetes Target

```bash
forgeagent deploy k8s [--namespace forgeagent] [--replicas 2]
```

Generates K8s manifests with:

- Deployment with resource limits (CPU: 500m, Memory: 512Mi)
- Service (ClusterIP)
- ConfigMap from `forgeagent.config.json`
- Secret template for API keys
- HorizontalPodAutoscaler (optional, `--hpa`)
- Readiness/liveness probes pointing to `/api/health`

#### 2.8.5 Health Check Validation

After deployment, the `deploy` command runs a health check:

```typescript
interface DeployResult {
  target: string
  success: boolean
  url?: string
  healthCheck?: {
    status: 'healthy' | 'unhealthy' | 'unreachable'
    latencyMs: number
    details: Record<string, unknown>
  }
  errors: string[]
}
```

#### 2.8.6 Rollback Support

For Docker and K8s targets, the deploy command tags the previous deployment and supports rollback:

```bash
# Roll back to previous deployment
forgeagent deploy rollback [--target docker|k8s]
```

For Docker: restores the previous image tag. For K8s: runs `kubectl rollout undo`.

---

## 3. CLI Command Reference

### 3.1 Scaffolding CLI (`create-dzipagent`)

```
npx create-dzipagent [project-name] [options]

Arguments:
  project-name              Project directory name (prompted if omitted)

Options:
  -t, --template <name>     Template: minimal|full-stack|codegen|multi-agent|server
  -f, --features <list>     Comma-separated features to enable
  -d, --database <type>     Database: in-memory|postgres
  --deploy <target>         Deployment target: docker|vercel|aws-lambda|cloudflare
  --provider <name>         LLM provider: anthropic|openai|custom
  --skip-install            Skip dependency installation
  --skip-git                Skip git init
  -y, --yes                 Accept all defaults (non-interactive)
  -h, --help                Show help
  -V, --version             Show version

Examples:
  npx create-dzipagent my-agent
  npx create-dzipagent my-agent -t full-stack -d postgres
  npx create-dzipagent my-agent -t minimal --provider anthropic -y
```

### 3.2 Runtime CLI (`forgeagent`)

```
forgeagent <command> [options]

Commands:
  dev                         Start development server with hot reload
  add <plugin...>             Install one or more plugins
  remove <plugin...>          Uninstall plugins
  update <plugin...>          Update plugins to latest version
  plugins                     List installed plugins
  marketplace                 Browse plugin marketplace

  test:scaffold [options]     Generate test files from agent config
  eval [options]              Run evaluation suite

  docs:generate [options]     Generate API documentation

  deploy <target> [options]   Deploy to target platform
  deploy rollback [options]   Rollback to previous deployment

  memory:browse <namespace>   Browse memory entries (interactive)
  memory:search <query>       Search across memory namespaces

  config:validate             Validate forgeagent.config.json
  config:show                 Print resolved configuration

Global Options:
  --config <path>             Path to config file (default: ./forgeagent.config.json)
  -v, --verbose               Verbose output
  -h, --help                  Show help
  -V, --version               Show version
```

### 3.3 Command Details

#### `forgeagent dev`

```
forgeagent dev [options]

Start development server with hot reload, live tracing, and playground.

Options:
  -p, --port <number>         Server port (default: from config or 3000)
  --no-playground             Disable playground UI
  --no-trace                  Disable terminal trace output
  --watch <dirs>              Additional directories to watch (default: src)
  -v, --verbose               Show all event types (default: summary only)

Examples:
  forgeagent dev
  forgeagent dev --port 4000 --verbose
  forgeagent dev --no-playground
```

#### `forgeagent add`

```
forgeagent add <plugin...> [options]

Install DzipAgent plugins from npm or local paths.

Arguments:
  plugin                      Plugin package names or local paths

Options:
  --no-config                 Skip updating forgeagent.config.json
  --save-dev                  Install as devDependency

Examples:
  forgeagent add @dzipagent/plugin-langfuse
  forgeagent add @dzipagent/plugin-langfuse @dzipagent/plugin-sentry
  forgeagent add ./my-local-plugin
```

#### `forgeagent test:scaffold`

```
forgeagent test:scaffold [options]

Generate test files from agent configuration.

Options:
  --agent <id>                Scaffold tests for a specific agent only
  --pattern <types>           Test patterns: unit,integration,eval (default: unit)
  --output <dir>              Output directory (default: ./tests)
  --overwrite                 Overwrite existing test files
  --mock-helpers              Also generate shared mock helpers

Examples:
  forgeagent test:scaffold
  forgeagent test:scaffold --agent code-reviewer --pattern unit,eval
  forgeagent test:scaffold --mock-helpers
```

#### `forgeagent deploy`

```
forgeagent deploy <target> [options]

Generate deployment configuration and optionally deploy.

Arguments:
  target                      Platform: docker|k8s|vercel|aws-lambda|cloudflare

Options:
  --dry-run                   Generate files without deploying
  --tag <tag>                 Docker image tag (docker target)
  --push <registry>           Push to container registry (docker target)
  --namespace <ns>            K8s namespace (k8s target)
  --replicas <n>              Number of replicas (k8s target, default: 1)
  --hpa                       Enable HorizontalPodAutoscaler (k8s target)
  --region <region>           Cloud region (lambda/cloudflare)

Examples:
  forgeagent deploy docker --dry-run
  forgeagent deploy docker --tag my-agent:v1 --push ghcr.io/myorg
  forgeagent deploy k8s --namespace production --replicas 3 --hpa
  forgeagent deploy vercel
  forgeagent deploy aws-lambda --region us-east-1
```

#### `forgeagent docs:generate`

```
forgeagent docs:generate [options]

Auto-generate API documentation from agent configurations.

Options:
  -o, --output <dir>          Output directory (default: ./docs/api)
  --format <type>             Output format: markdown|html (default: markdown)
  --include <sections>        Sections: agents,tools,memory,pipelines,plugins,config
  --interactive               Include runnable code blocks

Examples:
  forgeagent docs:generate
  forgeagent docs:generate -o ./docs/reference --format markdown
  forgeagent docs:generate --include agents,tools
```

---

## 4. Playground Architecture

### 4.1 Component Hierarchy (Detailed)

```
App.vue
  +-- RouterView
        |
        +-- PlaygroundView.vue (route: /playground)
        |     +-- PlaygroundHeader.vue
        |     |     +-- AgentSelector.vue
        |     |     |     Props: agents: AgentSummary[], modelValue: string
        |     |     |     Emits: update:modelValue
        |     |     +-- ConnectionIndicator.vue
        |     |     |     Props: connected: boolean
        |     |     +-- CostBadge.vue
        |     |           Props: usage: UsageSummary
        |     |
        |     +-- SplitPane.vue (resizable horizontal split)
        |           +-- ChatPanel.vue (slot: left)
        |           |     +-- MessageList.vue
        |           |     |     Props: messages: ChatMessage[]
        |           |     |     +-- MessageBubble.vue (v-for)
        |           |     |           Props: message: ChatMessage
        |           |     |           Renders conditionally:
        |           |     |           - UserMessageContent.vue
        |           |     |           - AssistantMessageContent.vue
        |           |     |           |     Uses: markdown-it + shiki for rendering
        |           |     |           - ToolCallCard.vue
        |           |     |           |     Props: toolCall: ToolCallData
        |           |     |           |     Collapsible: shows name, args, result, duration
        |           |     |           - SystemMessageBanner.vue
        |           |     |
        |           |     +-- ChatInput.vue
        |           |           Props: disabled: boolean, isStreaming: boolean
        |           |           Emits: send(text), stop()
        |           |           +-- AutoResizeTextarea.vue
        |           |           +-- SendButton.vue / StopButton.vue
        |           |
        |           +-- InspectorPanel.vue (slot: right)
        |                 +-- TabBar.vue
        |                 |     Props: tabs: TabDef[], activeTab: string
        |                 |
        |                 +-- TraceTab.vue (tab: "Trace")
        |                 |     +-- TraceTimeline.vue
        |                 |     |     Props: events: TraceEvent[]
        |                 |     |     Each event rendered as a timeline node
        |                 |     |     with icon (LLM/tool/budget), duration bar
        |                 |     +-- TraceEventDetail.vue
        |                 |           Props: event: TraceEvent | null
        |                 |           JSON tree viewer for event data
        |                 |
        |                 +-- MemoryTab.vue (tab: "Memory")
        |                 |     +-- NamespaceSelector.vue
        |                 |     +-- MemorySearchInput.vue
        |                 |     +-- MemoryEntryList.vue
        |                 |     |     Props: entries: MemoryEntry[]
        |                 |     +-- MemoryEntryEditor.vue
        |                 |           Props: entry: MemoryEntry | null
        |                 |           JSON editor with save/discard
        |                 |
        |                 +-- ConfigTab.vue (tab: "Config")
        |                 |     +-- InstructionsEditor.vue
        |                 |     |     Textarea with character count
        |                 |     +-- GuardrailsEditor.vue
        |                 |     |     Number inputs for maxTokens, maxCost, maxIterations
        |                 |     +-- ToolListViewer.vue
        |                 |           Read-only list of tool names + descriptions
        |                 |
        |                 +-- HistoryTab.vue (tab: "History")
        |                       +-- RunListFilter.vue
        |                       +-- RunList.vue
        |                       |     Props: runs: RunSummary[]
        |                       +-- RunDetailPanel.vue
        |                             Props: run: RunDetail | null
        |
        +-- MarketplaceView.vue (route: /playground/marketplace)
              +-- MarketplaceSearch.vue
              +-- CategorySidebar.vue
              +-- PluginGrid.vue
                    +-- PluginCard.vue (v-for)
```

### 4.2 WebSocket Protocol (Detailed)

#### Connection Lifecycle

```
1. Client connects to ws://localhost:3000/ws
2. Server accepts, registers WSClient in EventBridge with no filter
3. Client sends: { "type": "subscribe", "runId": "run-abc" }
4. Server updates ClientFilter to { runId: "run-abc" }
5. Server forwards matching DzipEvents as JSON strings
6. Client sends: { "type": "unsubscribe", "runId": "run-abc" }
7. Server resets ClientFilter to {}
8. On disconnect: Server removes WSClient from EventBridge
```

#### Message Types (Client to Server)

```typescript
type PlaygroundClientMessage =
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'ping' }
```

#### Message Types (Server to Client)

All messages are `DzipEvent` objects serialized as JSON. The playground client deserializes and dispatches to the appropriate Pinia store based on event type.

```typescript
// Event type -> Store mapping
const EVENT_STORE_MAP: Record<string, string> = {
  'agent:started':    'trace',
  'agent:completed':  'trace',
  'agent:failed':     'trace',
  'tool:called':      'trace',
  'tool:completed':   'trace',
  'tool:failed':      'trace',
  'llm:request':      'trace',
  'llm:response':     'trace',
  'budget:warning':   'trace',
  'budget:exceeded':  'trace',
  'memory:stored':    'memory',
  'memory:retrieved': 'memory',
  'run:completed':    'chat',
  'run:failed':       'chat',
}
```

#### Reconnection Strategy

The WebSocket client implements exponential backoff reconnection:

```
Attempt 1: wait 1s
Attempt 2: wait 2s
Attempt 3: wait 4s
Attempt 4: wait 8s
Attempt 5+: wait 15s (cap)
```

On reconnect, the client re-subscribes to the active `runId` if one exists.

### 4.3 State Management (Detailed)

Each Pinia store follows the same pattern: state, getters, and actions. The stores are independent and communicate through the WebSocket event dispatcher.

#### Chat Store Flow

```
User types message
  -> chatStore.send(text)
    -> POST /api/runs { agentId, messages: [...existing, { role: 'user', content: text }] }
    -> Response: { runId: 'run-abc' }
    -> wsStore.subscribe('run-abc')
    -> chatStore.isStreaming = true

WebSocket receives events:
  -> 'text' chunks -> chatStore.appendToCurrentMessage(chunk)
  -> 'tool_call'   -> chatStore.addToolCallMessage(data)
  -> 'tool_result' -> chatStore.updateToolCallResult(data)
  -> 'done'        -> chatStore.isStreaming = false

User clicks Stop:
  -> chatStore.abort()
    -> abortController.abort()
    -> POST /api/runs/run-abc/cancel
```

---

## 5. File Structure

### 5.1 `create-dzipagent` Package

```
packages/create-dzipagent/
  package.json                  # bin: { "create-dzipagent": "./dist/index.js" }
  tsconfig.json
  tsup.config.ts                # Bundle as single CLI entry

  src/
    index.ts                    # CLI entry point (#!/usr/bin/env node)
    cli.ts                      # Argument parsing (commander)
    prompts.ts                  # Interactive prompts (@clack/prompts)
    scaffold-engine.ts          # Core scaffolding logic
    template-renderer.ts        # EJS template rendering
    dependency-installer.ts     # npm/pnpm/yarn detection + install
    env-writer.ts               # .env file generation
    types.ts                    # ScaffoldOptions, ScaffoldResult types

    templates/
      manifests/
        minimal.json            # TemplateManifest for minimal template
        full-stack.json
        codegen.json
        multi-agent.json
        server.json

      shared/                   # Files shared across templates
        tsconfig.json.ejs
        .gitignore.ejs
        .env.example.ejs
        package.json.ejs
        forgeagent.config.json.ejs

      minimal/
        src/
          index.ts.ejs

      full-stack/
        src/
          index.ts.ejs
          agents/
            main-agent.ts.ejs
          tools/
            example-tool.ts.ejs
          plugins/
            index.ts.ejs
        docker-compose.yml.ejs
        Dockerfile.ejs
        tests/
          agents/
            main-agent.test.ts.ejs

      codegen/
        src/
          index.ts.ejs
          agents/
            codegen-agent.ts.ejs
          pipeline/
            codegen-pipeline.ts.ejs

      multi-agent/
        src/
          index.ts.ejs
          agents/
            orchestrator.ts.ejs
            worker-a.ts.ejs
            worker-b.ts.ejs

      server/
        src/
          index.ts.ejs
          routes/
            custom-routes.ts.ejs

  tests/
    scaffold-engine.test.ts     # Snapshot tests for generated projects
    prompts.test.ts             # Prompt flow tests
    template-renderer.test.ts   # Template rendering tests
```

### 5.2 `@dzipagent/playground` Package

```
packages/forgeagent-playground/
  package.json                  # Vue 3 SPA, build produces static assets
  tsconfig.json
  vite.config.ts                # base: '/playground/'
  index.html
  tailwind.css                  # Tailwind v4 entry

  src/
    main.ts                     # Vue app creation + router + pinia
    App.vue                     # Root layout

    router/
      index.ts                  # Vue Router config

    stores/
      agent-store.ts            # Pinia: agent list, active agent
      chat-store.ts             # Pinia: messages, streaming state
      trace-store.ts            # Pinia: trace events, usage
      memory-store.ts           # Pinia: memory browsing
      ws-store.ts               # Pinia: WebSocket connection

    composables/
      useWebSocket.ts           # WebSocket connection with reconnect
      useApi.ts                 # REST API client (ofetch wrapper)
      useMarkdown.ts            # markdown-it + shiki renderer

    views/
      PlaygroundView.vue
      MarketplaceView.vue

    components/
      layout/
        PlaygroundHeader.vue
        SplitPane.vue
        TabBar.vue

      chat/
        ChatPanel.vue
        MessageList.vue
        MessageBubble.vue
        UserMessageContent.vue
        AssistantMessageContent.vue
        ToolCallCard.vue
        SystemMessageBanner.vue
        ChatInput.vue
        AutoResizeTextarea.vue

      inspector/
        InspectorPanel.vue
        TraceTab.vue
        TraceTimeline.vue
        TraceEventDetail.vue
        MemoryTab.vue
        MemorySearchInput.vue
        MemoryEntryList.vue
        MemoryEntryEditor.vue
        ConfigTab.vue
        InstructionsEditor.vue
        GuardrailsEditor.vue
        ToolListViewer.vue
        HistoryTab.vue
        RunListFilter.vue
        RunList.vue
        RunDetailPanel.vue

      marketplace/
        MarketplaceSearch.vue
        CategorySidebar.vue
        PluginGrid.vue
        PluginCard.vue

      shared/
        ConnectionIndicator.vue
        CostBadge.vue
        AgentSelector.vue
        NamespaceSelector.vue
        JsonTreeViewer.vue
        LoadingSpinner.vue
        EmptyState.vue

    types/
      index.ts                  # ChatMessage, TraceEvent, etc.

  tests/
    components/
      ChatPanel.test.ts
      TraceTimeline.test.ts
    stores/
      chat-store.test.ts
    e2e/
      playground.spec.ts        # Playwright E2E tests
```

### 5.3 CLI Runtime Commands (in `@dzipagent/server`)

```
packages/forgeagent-server/
  src/
    cli/                        # NEW directory for CLI commands
      index.ts                  # CLI entry point (commander)
      dev-command.ts            # forgeagent dev
      add-command.ts            # forgeagent add
      remove-command.ts         # forgeagent remove
      plugins-command.ts        # forgeagent plugins
      test-scaffold-command.ts  # forgeagent test:scaffold
      docs-generate-command.ts  # forgeagent docs:generate
      deploy-command.ts         # forgeagent deploy
      memory-command.ts         # forgeagent memory:browse/search
      config-command.ts         # forgeagent config:validate/show
      trace-printer.ts          # Terminal event formatter for dev mode

    routes/
      playground.ts             # NEW: serve playground static assets
      memory-browse.ts          # NEW: GET /api/memory/:namespace

    docs/
      doc-generator.ts          # NEW: documentation generation engine
      agent-doc.ts              # Agent documentation renderer
      tool-doc.ts               # Tool documentation renderer
      pipeline-doc.ts           # Pipeline documentation renderer (Mermaid)

    deploy/
      docker-generator.ts       # NEW: Dockerfile + compose generation
      k8s-generator.ts          # NEW: K8s manifest generation
      vercel-generator.ts       # NEW: vercel.json generation
      lambda-generator.ts       # NEW: serverless/CDK generation
      cloudflare-generator.ts   # NEW: wrangler.toml generation
      health-checker.ts         # NEW: post-deploy health validation
```

### 5.4 Template File Structure (Generated Project)

For reference, the `full-stack` template with all features generates:

```
my-agent/
  package.json
  tsconfig.json
  forgeagent.config.json
  .env.example
  .env
  .gitignore
  docker-compose.yml
  Dockerfile
  README.md

  src/
    index.ts
    agents/
      main-agent.ts
    tools/
      example-tool.ts
    plugins/
      index.ts

  tests/
    helpers/
      forge-mocks.ts
    agents/
      main-agent.test.ts
```

---

## 6. Testing Strategy

### 6.1 CLI Integration Tests (Snapshot Testing)

The `create-dzipagent` scaffolder uses snapshot tests to verify generated project structures.

```typescript
// packages/create-dzipagent/tests/scaffold-engine.test.ts
import { describe, it, expect } from 'vitest'
import { ScaffoldEngine } from '../src/scaffold-engine.js'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ScaffoldEngine', () => {
  it('generates minimal template structure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-test-'))
    const engine = new ScaffoldEngine()

    const result = await engine.generate({
      projectName: 'test-agent',
      template: 'minimal',
      features: new Set(),
      database: 'in-memory',
      deployTarget: 'none',
      llmProvider: 'anthropic',
    })

    const files = await collectFiles(join(dir, 'test-agent'))
    expect(files.sort()).toMatchSnapshot('minimal-template-files')

    // Verify package.json content
    const pkgJson = await readFile(join(dir, 'test-agent', 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgJson)
    expect(pkg.type).toBe('module')
    expect(pkg.dependencies['@dzipagent/agent']).toBeDefined()
    expect(pkg.dependencies['@dzipagent/core']).toBeDefined()
  })

  it('generates full-stack template with postgres', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-test-'))
    const engine = new ScaffoldEngine()

    const result = await engine.generate({
      projectName: 'test-fullstack',
      template: 'full-stack',
      features: new Set(['memory', 'playground', 'streaming']),
      database: 'postgres',
      deployTarget: 'docker',
      llmProvider: 'anthropic',
    })

    const files = await collectFiles(join(dir, 'test-fullstack'))
    expect(files.sort()).toMatchSnapshot('fullstack-template-files')

    // Verify docker-compose exists
    expect(files).toContain('docker-compose.yml')
    expect(files).toContain('Dockerfile')
  })

  for (const template of ['minimal', 'full-stack', 'codegen', 'multi-agent', 'server'] as const) {
    it(`${template} template generates valid TypeScript`, async () => {
      // Generate project, run tsc --noEmit, expect zero errors
    })

    it(`${template} template generates valid forgeagent.config.json`, async () => {
      // Generate project, parse config, run validateConfig()
    })
  }
})
```

### 6.2 Playground E2E Tests (Playwright)

```typescript
// packages/forgeagent-playground/tests/e2e/playground.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Playground', () => {
  test.beforeEach(async ({ page }) => {
    // Start test server with mock agent
    await page.goto('http://localhost:3000/playground')
  })

  test('loads agent list', async ({ page }) => {
    const selector = page.locator('[data-testid="agent-selector"]')
    await expect(selector).toBeVisible()
    // Verify at least one agent option exists
    const options = await selector.locator('option').count()
    expect(options).toBeGreaterThan(0)
  })

  test('sends message and receives response', async ({ page }) => {
    const input = page.locator('[data-testid="chat-input"]')
    await input.fill('Hello, agent!')
    await page.locator('[data-testid="send-button"]').click()

    // Wait for user message to appear
    const userMsg = page.locator('[data-testid="user-message"]').last()
    await expect(userMsg).toContainText('Hello, agent!')

    // Wait for assistant response (with timeout for LLM call)
    const assistantMsg = page.locator('[data-testid="assistant-message"]').last()
    await expect(assistantMsg).toBeVisible({ timeout: 30_000 })
  })

  test('displays tool calls in trace', async ({ page }) => {
    // Send a message that triggers tool use
    const input = page.locator('[data-testid="chat-input"]')
    await input.fill('Read the file at /src/index.ts')
    await page.locator('[data-testid="send-button"]').click()

    // Switch to Trace tab
    await page.locator('[data-testid="tab-trace"]').click()

    // Verify tool call appears in timeline
    const toolEvent = page.locator('[data-testid="trace-event-tool"]').first()
    await expect(toolEvent).toBeVisible({ timeout: 30_000 })
  })

  test('websocket connection indicator', async ({ page }) => {
    const indicator = page.locator('[data-testid="connection-indicator"]')
    await expect(indicator).toHaveAttribute('data-status', 'connected')
  })

  test('memory browser loads namespaces', async ({ page }) => {
    await page.locator('[data-testid="tab-memory"]').click()
    const namespaceList = page.locator('[data-testid="namespace-list"]')
    await expect(namespaceList).toBeVisible()
  })
})
```

### 6.3 Template Validation Tests

```typescript
// packages/forgeagent-agent/src/templates/__tests__/template-validation.test.ts
import { describe, it, expect } from 'vitest'
import { AGENT_TEMPLATES } from '../agent-templates.js'

describe('Agent Templates', () => {
  // Validates all templates have required fields
  for (const [id, template] of Object.entries(AGENT_TEMPLATES)) {
    describe(`template: ${id}`, () => {
      it('has a valid id matching the key', () => {
        expect(template.id).toBe(id)
      })

      it('has non-empty instructions (>= 50 chars)', () => {
        expect(template.instructions.length).toBeGreaterThanOrEqual(50)
      })

      it('has a valid modelTier', () => {
        expect(['chat', 'reasoning', 'codegen']).toContain(template.modelTier)
      })

      it('has at least one suggested tool', () => {
        expect(template.suggestedTools.length).toBeGreaterThan(0)
      })

      it('has positive guardrail values', () => {
        expect(template.guardrails.maxTokens).toBeGreaterThan(0)
        expect(template.guardrails.maxCostCents).toBeGreaterThan(0)
        expect(template.guardrails.maxIterations).toBeGreaterThan(0)
      })

      it('has at least one tag', () => {
        expect(template.tags.length).toBeGreaterThan(0)
      })

      it('uses kebab-case id', () => {
        expect(template.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
      })
    })
  }
})
```

### 6.4 Template Composition Tests

```typescript
// packages/forgeagent-agent/src/templates/__tests__/template-composer.test.ts
import { describe, it, expect } from 'vitest'
import { composeTemplates } from '../template-composer.js'
import { getAgentTemplate } from '../agent-templates.js'

describe('composeTemplates', () => {
  it('merges two templates correctly', () => {
    const reviewer = getAgentTemplate('code-reviewer')!
    const security = getAgentTemplate('security-auditor')!

    const composed = composeTemplates(reviewer, security)

    expect(composed.id).toBe('code-reviewer+security-auditor')
    expect(composed.instructions).toContain('Code Reviewer Role')
    expect(composed.instructions).toContain('Security Auditor Role')
    expect(composed.suggestedTools).toContain('read_file')
    expect(composed.suggestedTools).toContain('search_code')
    expect(composed.suggestedTools).toContain('git_diff')
    expect(composed.suggestedTools).toContain('list_files')
    // No duplicates
    const uniqueTools = new Set(composed.suggestedTools)
    expect(uniqueTools.size).toBe(composed.suggestedTools.length)
  })

  it('uses highest model tier', () => {
    const chat = getAgentTemplate('documentation-agent')!    // chat
    const codegen = getAgentTemplate('devops-agent')!        // codegen

    const composed = composeTemplates(chat, codegen)
    expect(composed.modelTier).toBe('codegen')
  })

  it('uses maximum guardrail values', () => {
    const a = getAgentTemplate('code-reviewer')!     // 50k tokens
    const b = getAgentTemplate('migration-agent')!   // 200k tokens

    const composed = composeTemplates(a, b)
    expect(composed.guardrails.maxTokens).toBe(200_000)
  })

  it('throws on empty input', () => {
    expect(() => composeTemplates()).toThrow('At least one template')
  })
})
```

### 6.5 CLI Command Tests

```typescript
// packages/forgeagent-server/src/cli/__tests__/add-command.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('forgeagent add', () => {
  it('validates plugin manifest after install', async () => {
    // Mock npm install
    // Mock readFile for forgeagent-plugin.json
    // Verify validateManifest is called
    // Verify forgeagent.config.json is updated
  })

  it('rejects plugins with invalid manifests', async () => {
    // Mock npm install
    // Mock readFile returning invalid manifest
    // Verify error message and config is NOT updated
  })

  it('handles local plugin paths', async () => {
    // Verify ./my-plugin is resolved to absolute path
    // Verify manifest is read from local path
  })
})
```

### 6.6 Documentation Generator Tests

```typescript
// packages/forgeagent-server/src/docs/__tests__/doc-generator.test.ts
import { describe, it, expect } from 'vitest'

describe('DocGenerator', () => {
  it('generates agent documentation', async () => {
    // Create mock agent config
    // Run generator
    // Verify markdown output contains instructions, guardrails, tools
  })

  it('generates tool documentation with schema', async () => {
    // Create mock tool with zod schema
    // Run generator
    // Verify markdown contains parameter table
  })

  it('generates pipeline diagram in Mermaid', async () => {
    // Create mock workflow
    // Run generator
    // Verify output contains ```mermaid block
  })

  it('generates index with table of contents', async () => {
    // Generate full docs
    // Verify index.md links to all sub-documents
  })
})
```

---

## Appendix A: Effort Breakdown

| Feature | Priority | Effort | Dependencies |
|---------|----------|--------|-------------|
| F1: create-dzipagent CLI | P1 | 12h | ForgeConfig, AgentTemplate |
| F2: Agent Playground | P2 | 24h | @dzipagent/server routes, EventBridge |
| F3: Plugin Marketplace | P3 | 20h | Plugin discovery, playground UI |
| F4: Agent Templates Library | P1 | 8h | None (extends existing) |
| F5: Documentation Generation | P2 | 8h | Agent/tool introspection |
| F6: Integration Test Scaffolding | P1 | 4h | AgentTemplate, DzipAgentConfig |
| F7: Development Mode | P1 | 4h | @dzipagent/server, DzipEventBus |
| F8: Deployment Helpers | P2 | 8h | Platform adapters (existing) |
| **Total** | | **88h** | |

## Appendix B: Implementation Order

```
Phase 1 (P1 features, ~28h):
  F4: Agent Templates Library (8h)    -- no dependencies, extends existing code
  F7: Development Mode (4h)           -- needs DzipEventBus (exists)
  F6: Test Scaffolding (4h)           -- needs templates (F4)
  F1: create-dzipagent CLI (12h)     -- needs templates (F4), ForgeConfig (exists)

Phase 2 (P2 features, ~40h):
  F5: Documentation Generation (8h)   -- needs templates (F4)
  F8: Deployment Helpers (8h)         -- needs platform adapters (exist)
  F2: Agent Playground (24h)          -- needs server routes + EventBridge (exist)

Phase 3 (P3 features, ~20h):
  F3: Plugin Marketplace (20h)        -- needs playground (F2), plugin discovery (exists)
```

## Appendix C: Comparison with Competitors

| Capability | DzipAgent (Planned) | Mastra | CrewAI | LangGraph |
|-----------|---------------------|--------|--------|-----------|
| CLI Scaffolding | `create-dzipagent` (5 templates) | `create-mastra` (3 templates) | `crewai create` | None |
| Playground UI | Vue 3 SPA with trace viewer | React playground | None (Cloud only) | LangGraph Studio |
| Plugin System | `forgeagent-plugin.json` manifests | Integrations directory | Tools directory | None |
| Plugin Marketplace | npm + registry API | None | None | LangChain Hub |
| Agent Templates | 20+ templates with composition | 3 templates | Role-based agents | None |
| Documentation Gen | Auto-generate from config | None | None | None |
| Test Scaffolding | `test:scaffold` command | None | None | None |
| Dev Mode | Hot reload + live trace | `mastra dev` | None | Studio |
| Deployment | Docker/K8s/Vercel/Lambda/CF | Vercel/Cloudflare | Docker | LangGraph Cloud |

DzipAgent's differentiators: template composition, plugin marketplace with verification, integrated test scaffolding, and multi-platform deployment from a single command.
