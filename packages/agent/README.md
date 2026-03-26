# @forgeagent/agent

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Beta | **Coverage:** 80% | **Exports:** 116

| Metric | Value |
|--------|-------|
| Source Files | 76 |
| Lines of Code | 28,873 |
| Test Files | 41 |
| Internal Dependencies | `@forgeagent/context`, `@forgeagent/core`, `@forgeagent/memory-ipc` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @forgeagent/agent
```
<!-- AUTO-GENERATED-END -->

Top-level agent abstraction for the ForgeAgent framework. Provides the `ForgeAgent` class with generate/stream/asTool capabilities, guardrails, workflow engine, multi-agent orchestration, pipelines, structured output, approval gates, and security.

## Installation

```bash
yarn add @forgeagent/agent
# or
npm install @forgeagent/agent
```

## Quick Start

```ts
import { ForgeAgent } from '@forgeagent/agent'

const agent = new ForgeAgent({
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

### Agent

- `ForgeAgent` -- main agent class with `generate()`, `stream()`, and `asTool()` methods
- `runToolLoop(config): Promise<ToolLoopResult>` -- execute a tool loop with budget tracking
- `DynamicToolRegistry` -- runtime tool add/remove with event notifications

**Types:** `ForgeAgentConfig`, `ArrowMemoryConfig`, `GenerateOptions`, `GenerateResult`, `AgentStreamEvent`, `ToolLoopConfig`, `ToolLoopResult`, `ToolRegistryEvent`

### Guardrails

- `IterationBudget` -- enforces iteration and token limits on agent loops
- `StuckDetector` -- detects repeated tool calls and error loops
- `CascadingTimeout` -- hierarchical timeouts (agent > step > tool)

**Types:** `GuardrailConfig`, `BudgetState`, `BudgetWarning`, `StuckDetectorConfig`, `StuckStatus`, `CascadingTimeoutConfig`

### Workflow

- `WorkflowBuilder` -- fluent API for building multi-step workflows
- `CompiledWorkflow` -- executable workflow compiled from the builder
- `createWorkflow(config): CompiledWorkflow` -- convenience factory

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

**Types:** `AgentCredential`, `SignedAgentMessage`, `AgentAuthConfig`

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

- `FORGEAGENT_AGENT_VERSION: string` -- `'0.1.0'`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@forgeagent/core` | `0.1.0` | Core infrastructure (LLM, memory, events) |
| `@forgeagent/context` | `0.1.0` | Context window management |
| `@forgeagent/memory-ipc` | `0.1.0` | Arrow-based memory IPC |

## Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@langchain/core` | `>=1.0.0` | Base LangChain types |
| `@langchain/langgraph` | `>=1.0.0` | Graph execution |
| `zod` | `>=4.0.0` | Schema validation |

## License

MIT
