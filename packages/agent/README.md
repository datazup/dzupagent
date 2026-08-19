# @dzupagent/agent

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Beta | **Coverage:** 80% | **Exports:** 116

| Metric | Value |
|--------|-------|
| Source Files | 76 |
| Lines of Code | 28,873 |
| Test Files | 41 |
| Internal Dependencies | `@dzupagent/context`, `@dzupagent/core`, `@dzupagent/memory-ipc` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @dzupagent/agent
```
<!-- AUTO-GENERATED-END -->

Top-level agent abstraction for the DzupAgent framework. Provides the `DzupAgent` class with generate/stream/asTool capabilities, guardrails, workflow engine, multi-agent orchestration, pipelines, structured output, approval gates, and security.

## Installation

```bash
yarn add @dzupagent/agent
# or
npm install @dzupagent/agent
```

## Quick Start

```ts
import { DzupAgent } from '@dzupagent/agent'

const agent = new DzupAgent({
  name: 'code-reviewer',
  model: chatModel,
  systemPrompt: 'You are a code review agent.',
  tools: [lintTool, testTool],
  iterationBudget: { maxIterations: 10, maxTokens: 100_000 },
})

// Generate a response
const result = await agent.generate('Review this PR for security issues.')

// Stream events
for await (const event of agent.stream('Review this PR.')) {
  console.log(event.type, event.data)
}

// Use as a tool inside another agent
const reviewTool = agent.asTool({ description: 'Run code review' })
```

## API Reference

### Experimental cohesive runner

`@dzupagent/agent/runner` exposes the provider-free R5A runner slice:
`InMemoryAgentRunner`, `RunControl`, and `InMemoryAgentRunnerPersistence`. It
accepts only the bounded runner model port and read-only tool port exported from
the same subpath. One scheduler drives new and resumed `run()`/`stream()`
projections and returns canonical `@dzupagent/agent-types/run` state/events.

The in-memory persistence seam commits each successor state and event together.
Approval-required read tools suspend before dispatch, and `resume()` or
`resumeStream()` can continue the same invocation in a new runner instance after
a digest-, revision-, generation-, policy-, and actor-bound decision. The legacy
`InMemoryAgentRunStore` and `InMemoryAgentEventJournal` remain lower-level
experimental primitives; the exact-resume runner does not compose them
sequentially.

An optional `sessionId` binds a run to an in-memory revisioned conversation
transaction. Existing history and new input are composed deterministically;
successful completion commits new input and canonical run items once, approval
suspension retains the transaction for resume, and rejected, failed, or
cancelled runs abort staged history. Simultaneous runs from one base revision
surface a conflict instead of silently interleaving history. This all-or-nothing
policy is experimental and is not a universal product retention policy.

This subpath remains experimental and memory-only. It does not qualify a durable
adapter, final `AgentSession` port ownership, mutation-capable tool, host
execution adapter, live provider, or production host, and it does not replace or
control legacy `DzupAgent.generate()`, `stream()`, or `launch()`.

### Agent

- `DzupAgent` -- main agent class with `generate()`, `stream()`, and `asTool()` methods
- `runToolLoop(config): Promise<ToolLoopResult>` -- execute a tool loop with budget tracking
- `DynamicToolRegistry` -- runtime tool add/remove with event notifications

**Types:** `DzupAgentConfig`, `ArrowMemoryConfig`, `GenerateOptions`, `GenerateResult`, `AgentStreamEvent`, `ToolLoopConfig`, `ToolLoopResult`, `ToolRegistryEvent`

#### Lifecycle-aware memory context

Set `memoryContextMode: 'lifecycle'` to use the canonical
`@dzupagent/memory/retrieval` contract without configuring the legacy
`MemoryService` namespace path:

```ts
const agent = new DzupAgent({
  id: 'reviewer',
  instructions: 'Review the current change.',
  model: chatModel,
  memoryContextMode: 'lifecycle',
  lifecycleMemoryRetrieval: {
    scope,
    profile,
    retriever,
    asOf: () => new Date().toISOString(),
  },
})
```

The host owns the scope, clock, candidate/lifecycle resolver, and any optional
query-rewriter or reranker. Identical concurrent reads are coalesced in a
bounded per-agent map, but settled results are not cached, so subsequent turns
re-resolve corrections and revocations. Retryable, rejected, or degraded
canonical retrieval never falls back to the legacy namespace service. This is
a read-only context path; it grants no memory mutation, provider spending, or
operational authority.

The injected prompt section labels lifecycle memory as untrusted data and
states that remembered instructions, credentials, consent, or authority grant
no permission to act. Each underlying retrieval stage is hard-deadline bounded;
the single-flight key includes the host-provided `asOf` instant, and only
concurrent identical reads coalesce. Settled corrections and revocations are
therefore re-resolved on the next load.

#### Human-contact runtime binding

`createHumanContactTool()` uses the exact call-local run, tenant, and model
tool-call identity propagated by `DzupAgent.generate()` and `stream()`. Set an
optional app-owned preference key per call without exposing profile or delivery
records to the tool:

```ts
await agent.generate(messages, {
  runId: 'run-42',
  humanContact: { profileKey: 'profile-7' },
})
```

The built-in tool supports only `in-app`, `slack`, `email`, and `webhook`.
Channel precedence is explicit tool input, injected async preference resolver,
configured default, then `in-app`. Resolver failures and unsupported channels
fail closed before persistence or pause effects.

Direct standalone invocation must supply the exported runnable configuration:

```ts
import {
  createHumanContactTool,
  humanContactRunnableConfig,
} from '@dzupagent/agent/tools'

const humanContactTool = createHumanContactTool()

await humanContactTool.invoke(
  { mode: 'approval', question: 'Proceed?' },
  humanContactRunnableConfig({
    runId: 'run-42',
    tenantId: 'tenant-blue',
    invocationId: 'tool-call-9',
  }),
)
```

Production hosts must inject a durable `PendingContactStore` and an idempotent
`onPause` adapter. The bundled in-memory store and Server critical section
qualify process-local behavior only; cross-replica exact-once resume requires a
durable compare-and-set implementation. Raw resume tokens belong only at the
pause/delivery boundary and must not enter model output, logs, or metadata.

### Guardrails

- `IterationBudget` -- enforces iteration and token limits on agent loops
- `StuckDetector` -- detects repeated tool calls and error loops
- `CascadingTimeout` -- hierarchical timeouts (agent > step > tool)

**Types:** `GuardrailConfig`, `BudgetState`, `BudgetWarning`, `StuckDetectorConfig`, `StuckStatus`, `CascadingTimeoutConfig`

### Workflow

- `WorkflowBuilder` -- fluent API for building multi-step workflows
- `CompiledWorkflow` -- executable workflow compiled from the builder
- `createWorkflow(config): WorkflowBuilder` -- convenience factory; call `.build()` to produce a `CompiledWorkflow`

**Types:** `WorkflowConfig`, `WorkflowStep`, `WorkflowContext`, `WorkflowEvent`, `MergeStrategy`

### Orchestration

- `AgentOrchestrator` -- supervisor pattern for delegating to specialist agents
- `ContractNetManager` -- contract net protocol for competitive agent bidding
- `TopologyAnalyzer` -- recommends optimal agent topology for a task
- `TopologyExecutor` -- executes mesh, ring, and other topology patterns
- `mapReduce(config)` / `mapReduceMulti(config)` -- map-reduce orchestration
- Merge strategies: `concatMerge`, `voteMerge`, `numberedMerge`, `jsonArrayMerge`

**Types:** `SupervisorConfig`, `SupervisorResult`, `OrchestrationPattern`, `MapReduceConfig`, `ContractNetConfig`, `ContractBid`, `TopologyType`, `TopologyRecommendation`

### Pipeline

- `PipelineRuntime` -- execute multi-node pipelines with checkpointing and retries
- `validatePipeline(nodes)` -- validate pipeline graph structure
- `executeLoop(config)` -- execute retry loops with custom conditions
- `PipelineAnalytics` -- track node metrics and identify bottlenecks
- `InMemoryPipelineCheckpointStore` -- in-memory checkpoint storage
- Pipeline templates: `createCodeReviewPipeline`, `createFeatureGenerationPipeline`, `createTestGenerationPipeline`, `createRefactoringPipeline`

**Types:** `PipelineState`, `NodeResult`, `PipelineRunResult`, `PipelineRuntimeConfig`, `NodeMetrics`, `BottleneckEntry`

#### Runtime Validation Helpers

Compiled flow runtime leaves such as `validate`, `validate.schema`, and
`shell.run` can be wired through `createRuntimeToolHandlers`:

```ts
import {
  createRuntimeAjvValidationRunner,
  createRuntimeShellValidationCommandRunner,
  createRuntimeToolHandlers,
  createRuntimeValidatePort,
  createRuntimeValidationSuiteRegistry,
  runtimeShellAllowlistPresets,
} from '@dzupagent/agent/pipeline'

const schemas = {
  'review.schema': {
    type: 'object',
    required: ['status'],
  },
}

const suites = createRuntimeValidationSuiteRegistry({
  suites: {
    'app.preflight': [
      { id: 'schema', command: 'schema:review.schema', kind: 'schema' },
      { id: 'typecheck', command: 'yarn typecheck', kind: 'shell' },
    ],
  },
})

const schemaRunner = createRuntimeAjvValidationRunner({
  schemas,
  ajv,
  selectData: (request) => request.context.state,
})
const shellRunner = createRuntimeShellValidationCommandRunner(
  runtimeShellAllowlistPresets.yarnChecks(['yarn typecheck']),
)

const handlers = createRuntimeToolHandlers({
  validate: createRuntimeValidatePort({
    resolveSuite: suites.resolveSuite,
    runCommand: (command, request) =>
      command.kind === 'schema'
        ? schemaRunner(command, request)
        : shellRunner(command, request),
  }),
  shellRun: async ({ command }) => ({
    output: { command, exitCode: 0 },
  }),
})
```

For shell-backed validation suites, pass an allowlist preset to
`createRuntimeShellValidationCommandRunner` and compose it with schema runners
inside your app-owned command runner:

```ts
import {
  createRuntimeZodValidationRunner,
} from '@dzupagent/agent/pipeline'

const zodRunner = createRuntimeZodValidationRunner({
  schemas: { 'review.zod': reviewSchema },
})
```

`shell.run` is intentionally host-owned. The package exposes the typed
`shellRun` port so apps can enforce their own command policy, working
directory, environment, audit trail, and sandboxing; it does not ship a generic
`shell.run` executor. The reusable shell helper is scoped to validation suites
and still requires an explicit allowlist.

### Structured Output

- `generateStructuredOutput(config)` -- generate typed output from an LLM using Zod schemas
- `detectStrategy(model)` -- detect the best structured output strategy for a model

**Types:** `StructuredOutputStrategy`, `StructuredOutputConfig`, `StructuredOutputResult`, `StructuredLLM`

### Approval

- `ApprovalGate` -- human-in-the-loop approval for sensitive operations

**Types:** `ApprovalConfig`, `ApprovalMode`, `ApprovalResult`

### Snapshot & Serialization

- `createSnapshot(params)` -- create an agent state snapshot with integrity verification
- `verifySnapshot(snapshot)` -- verify snapshot integrity hash
- `compressSnapshot(snapshot)` / `decompressSnapshot(data)` -- snapshot compression
- `serializeMessage(msg)` / `migrateMessages(msgs)` -- message serialization with multimodal support

**Types:** `AgentStateSnapshot`, `SerializedMessage`, `MultimodalContent`

### Security

- `AgentAuth` -- agent credential management and message signing
- `createProductionToolGovernancePreset(options)` -- opt-in production preset
  that wires tool governance, safety scanning, fail-closed scanner behavior,
  argument validation, per-tool timeouts, permission policy, event bus
  telemetry, tracer propagation, and durable run IDs into `toolExecution`.
- `withProductionToolGovernancePreset(config, options)` -- convenience helper
  that applies the production preset to an existing `DzupAgentConfig`.

**Types:** `AgentCredential`, `SignedAgentMessage`, `AgentAuthConfig`,
`ProductionToolGovernancePresetOptions`, `ProductionToolGovernancePreset`

Legacy `DzupAgent` defaults remain compatible: tool governance controls are
available as primitives, but they are not enabled unless callers pass
`toolExecution` or use the production preset. The production preset defaults to
fail-closed scanning and a default-deny permission policy when no allowlist or
custom policy is provided.

```ts
import {
  DzupAgent,
  withProductionToolGovernancePreset,
} from '@dzupagent/agent'

const config = withProductionToolGovernancePreset(
  {
    id: 'operator',
    instructions: 'Operate approved tools only.',
    model: chatModel,
    tools: [readFileTool, deployTool],
  },
  {
    runId: executionRunId,
    allowedToolNames: ['read_file', 'deploy'],
    approvalRequiredToolNames: ['deploy'],
    timeouts: { read_file: 10_000, deploy: 60_000 },
  },
)

const agent = new DzupAgent(config)
```

### Templates

- `AGENT_TEMPLATES` / `ALL_AGENT_TEMPLATES` -- 22 built-in agent template presets
- `getAgentTemplate(id)` / `listAgentTemplates()` -- template lookup
- `composeTemplates(templates)` -- merge multiple templates
- `TemplateRegistry` -- runtime template registration

**Types:** `AgentTemplate`, `AgentTemplateCategory`

### Tools

- `createForgeTool(config)` -- factory for LangChain-compatible tools
- `ToolSchemaRegistry` -- versioned tool schema registry with compatibility checking

**Types:** `ForgeToolConfig`, `ToolSchemaEntry`, `CompatCheckResult`

### Streaming

- `StreamActionParser` -- parse streaming tool calls from LLM output

**Types:** `StreamedToolCall`, `StreamActionEvent`, `StreamActionParserConfig`

### Version

- `dzupagent_AGENT_VERSION: string` -- `'0.2.0'`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@dzupagent/core` | `0.2.0` | Core infrastructure (LLM, memory, events) |
| `@dzupagent/context` | `0.2.0` | Context window management |
| `@dzupagent/memory-ipc` | `0.2.0` | Arrow-based memory IPC |

## Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@langchain/core` | `>=1.0.0` | Base LangChain types |
| `@langchain/langgraph` | `>=1.0.0` | Graph execution |
| `zod` | `>=4.0.0` | Schema validation |

## License

MIT
