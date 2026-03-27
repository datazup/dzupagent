# DzipAgent Ecosystem — Implementation Tickets (Phases 4-6)

> **Created:** 2026-03-24
> **Covers:** Documents 07-12 (Runtime, Evaluation, Formats, Pipelines, DX, Security)
> **Ticket Range:** ECO-100 through ECO-199
> **Phases:** 4 (Weeks 7-8), 5 (Weeks 9-10), 6 (Future/P3)

---

## Summary Table

| Phase | Tickets | Total Effort | Key Deliverables |
|-------|---------|-------------|-----------------|
| **Phase 4** | ECO-100 -- ECO-131 (32 tickets) | ~176h | Pipeline definition protocol, unified execution engine, workflow persistence, eval framework (scorers, datasets, runner, recorder), Agent Card v2, OpenAI compat, structured output, orchestration patterns, cost attribution |
| **Phase 5** | ECO-132 -- ECO-167 (36 tickets) | ~196h | Sandbox pooling/volumes/audit, resource quotas, zero-trust policy engine, safety monitoring, compliance audit trail, memory poisoning defense, sandbox hardening, CLI scaffolding, dev mode, agent templates, test scaffolding, deployment helpers |
| **Phase 6** | ECO-168 -- ECO-185 (18 tickets) | ~152h | WASM sandbox, K8s CRD + operator, agent playground, plugin marketplace, doc generation, benchmark suite, cross-agent security, incident response, data classification, security testing framework, visual pipeline editor, pipeline analytics |
| **Grand Total** | **86 tickets** | **~524h** | |

---

## Phase 4: Advanced Orchestration & Evaluation (Weeks 7-8)

### Pipeline Definition & Execution (Doc 10)

---

### ECO-100: Pipeline Definition Protocol -- Core Types
- **Source:** Doc 10, Feature F1
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** None (foundational types)
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/pipeline/pipeline-definition.ts` -- PipelineNodeBase, AgentNode, ToolNode, TransformNode, GateNode, ForkNode, JoinNode, LoopNode, SuspendNode, PipelineEdge types, PipelineDefinition interface
  - `packages/forgeagent-core/src/pipeline/index.ts` -- barrel export
  - `packages/forgeagent-core/src/index.ts` -- re-export pipeline types
- **Acceptance Criteria:**
  - [ ] All 8 node types defined with discriminated union on `type` field
  - [ ] 3 edge types (sequential, conditional, error) defined
  - [ ] PipelineDefinition is fully JSON-serializable (no function references)
  - [ ] PipelineValidationResult, PipelineValidationError, PipelineValidationWarning types defined
  - [ ] Zero `any` types; strict mode compatible
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-101: Pipeline Definition Validator
- **Source:** Doc 10, Feature F1
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 4h
- **Dependencies:** ECO-100 (Pipeline Definition types)
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/pipeline/pipeline-validator.ts` -- validatePipeline(), reachability check, cycle detection, fork/join pairing, loop body validation
- **Acceptance Criteria:**
  - [ ] Detects missing entry node, dangling edges, orphan nodes, unbounded cycles, duplicate IDs, unbalanced fork/join, invalid loop bodies
  - [ ] Warnings for unreachable nodes, no error handlers, high maxIterations, missing timeouts
  - [ ] Cycle detection uses DFS coloring (white/gray/black)
  - [ ] BFS reachability from entry node
  - [ ] Unit tests for each validation rule (at least 10 test cases)
  - [ ] Zero TS errors

---

### ECO-102: Pipeline Checkpoint Store Interface
- **Source:** Doc 10, Feature F3
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 2h
- **Dependencies:** ECO-100
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/pipeline/pipeline-checkpoint-store.ts` -- PipelineCheckpointStore interface, PipelineCheckpoint, PipelineCheckpointSummary, SerializedNodeResult
- **Acceptance Criteria:**
  - [ ] Interface with save/load/loadVersion/listVersions/delete/prune methods
  - [ ] PipelineCheckpoint captures full resumable state (completedNodeIds, state, suspendedAtNodeId, budgetState)
  - [ ] schemaVersion field for forward compatibility
  - [ ] Zero TS errors

---

### ECO-103: In-Memory Pipeline Checkpoint Store
- **Source:** Doc 10, Feature F3
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 2h
- **Dependencies:** ECO-102
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/pipeline/in-memory-checkpoint-store.ts` -- InMemoryPipelineCheckpointStore
  - `packages/forgeagent-agent/src/pipeline/execution-state.ts` -- ExecutionState, serializeExecutionState(), deserializeExecutionState()
- **Acceptance Criteria:**
  - [ ] Implements all PipelineCheckpointStore methods
  - [ ] structuredClone for isolation between saved and returned checkpoints
  - [ ] prune() removes entries older than maxAgeMs
  - [ ] Round-trip test: serialize -> deserialize produces equivalent state
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-104: Postgres Pipeline Checkpoint Store
- **Source:** Doc 10, Feature F3
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 4h
- **Dependencies:** ECO-102
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/persistence/postgres-pipeline-checkpoint-store.ts` -- PostgresPipelineCheckpointStore
  - `packages/forgeagent-server/src/persistence/drizzle-schema.ts` -- add pipeline_checkpoints table
- **Acceptance Criteria:**
  - [ ] Drizzle schema with composite PK (pipeline_run_id, version)
  - [ ] Indexes on pipeline_run_id and created_at
  - [ ] Upsert with onConflictDoUpdate
  - [ ] prune() uses SQL DELETE with timestamp comparison
  - [ ] Works with existing Drizzle migration pattern
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-105: Unified Pipeline Execution Engine
- **Source:** Doc 10, Feature F2
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 8h
- **Dependencies:** ECO-100, ECO-101, ECO-102, ECO-103
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/pipeline/pipeline-runtime.ts` -- PipelineRuntime class implementing PipelineRuntimeAPI (execute, resume, cancel, getRunState)
  - `packages/forgeagent-agent/src/pipeline/pipeline-runtime-types.ts` -- PipelineState, NodeExecutor, NodeExecutionContext, PipelineFunctionRegistry, PipelineRuntimeConfig, NodeResult, PipelineRunResult, PipelineRuntimeEvent
- **Acceptance Criteria:**
  - [ ] Topological sort for acyclic node execution
  - [ ] Fork/join parallel execution with configurable merge strategies
  - [ ] Conditional edge routing via named predicates
  - [ ] Error edges for failure routing
  - [ ] Gate nodes (approval suspend, budget check, quality check)
  - [ ] Suspend/resume with checkpoint persistence
  - [ ] Cancellation via AbortSignal
  - [ ] Pipeline events emitted to DzipEventBus
  - [ ] Checkpoint after each node (configurable strategy)
  - [ ] At least 15 unit tests covering each node type
  - [ ] Zero TS errors

---

### ECO-106: Loop Execution Engine
- **Source:** Doc 10, Feature F4
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 4h
- **Dependencies:** ECO-105
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/pipeline/loop-executor.ts` -- executeLoop(), LoopMetrics, built-in loop predicates
- **Acceptance Criteria:**
  - [ ] Executes body nodes in sequence per iteration
  - [ ] Evaluates continue predicate after each iteration
  - [ ] Terminates on: condition met, maxIterations, budget exceeded, cancellation
  - [ ] LoopMetrics tracks iterationCount, durations, convergenceRate
  - [ ] failOnMaxIterations flag honored
  - [ ] loop_iteration events emitted
  - [ ] Built-in predicates: `stateFieldTruthy`, `qualityBelow`, `hasErrors`
  - [ ] Tests for each termination condition
  - [ ] Zero TS errors

---

### ECO-107: Sub-Graph Composition
- **Source:** Doc 10, Feature F5
- **Phase:** 4
- **Priority:** P2
- **Package:** @dzipagent/agent
- **Effort:** 4h
- **Dependencies:** ECO-105
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/pipeline/sub-graph.ts` -- SubGraphNode type, sub-graph execution, input/output mapping, budget inheritance
- **Acceptance Criteria:**
  - [ ] SubGraphNode references a PipelineDefinition by ID
  - [ ] Input/output state mapping between parent and child pipeline
  - [ ] Budget propagation: child pipeline shares parent's remaining budget
  - [ ] Checkpoint includes sub-graph execution state
  - [ ] Tests for nested pipeline execution
  - [ ] Zero TS errors

---

### ECO-108: WorkflowBuilder.toPipelineDefinition()
- **Source:** Doc 10, Feature F1
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 3h
- **Dependencies:** ECO-100, ECO-105
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/workflow/workflow-builder.ts` -- add toPipelineDefinition() method
- **Acceptance Criteria:**
  - [ ] Existing WorkflowBuilder.build() continues to work (backward compatible)
  - [ ] toPipelineDefinition() produces valid PipelineDefinition from then/parallel/branch/suspend calls
  - [ ] Parallel steps become Fork+Join nodes
  - [ ] Branch steps become ConditionalEdge
  - [ ] Suspend steps become SuspendNode
  - [ ] Round-trip: builder -> definition -> runtime produces same execution order
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-109: GenPipelineBuilder.toPipelineDefinition()
- **Source:** Doc 10, Feature F1
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/codegen
- **Effort:** 3h
- **Dependencies:** ECO-100
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/pipeline/pipeline-builder.ts` -- add toPipelineDefinition() method
- **Acceptance Criteria:**
  - [ ] Existing getPhases() continues to work
  - [ ] Maps codegen phases (generation, subagent, validation, fix, review) to AgentNode/ToolNode/GateNode
  - [ ] Fix-validate cycles become LoopNodes
  - [ ] Produces valid PipelineDefinition (passes validator)
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-110: Pipeline Registry
- **Source:** Doc 10, Feature F6
- **Phase:** 4
- **Priority:** P2
- **Package:** @dzipagent/server
- **Effort:** 4h
- **Dependencies:** ECO-100, ECO-104
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/persistence/pipeline-registry.ts` -- PipelineRegistry (save, get, list, search by tags, version management)
  - `packages/forgeagent-server/src/persistence/drizzle-schema.ts` -- add pipeline_definitions table
  - `packages/forgeagent-server/src/routes/pipelines.ts` -- REST API for pipeline CRUD
- **Acceptance Criteria:**
  - [ ] Store/retrieve PipelineDefinition by ID + version
  - [ ] List with tag-based filtering
  - [ ] Version history per pipeline ID
  - [ ] REST endpoints: GET/POST/PUT/DELETE /api/pipelines
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### Evaluation & Testing Framework (Doc 08)

---

### ECO-111: Enhanced Scorer Interface
- **Source:** Doc 08, Feature F1
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/evals
- **Effort:** 4h
- **Dependencies:** None (enhances existing types)
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-evals/src/types.ts` -- Score, ScorerConfig, ScorerResult, Scorer<TInput>, EvalInput (enhanced with tags, latencyMs, costCents), EvalRecord, EvalResultStore, EvalResultFilter
- **Acceptance Criteria:**
  - [ ] Scorer interface is generic: Scorer<TInput = EvalInput>
  - [ ] ScorerConfig has id, name, description, type, threshold, version
  - [ ] ScorerResult has scores array, aggregateScore, passed, durationMs, costCents
  - [ ] Backward compat: deprecated EvalResult alias exported
  - [ ] Existing tests continue to compile
  - [ ] Zero TS errors

---

### ECO-112: LLM-as-Judge Scorer (Multi-Criteria)
- **Source:** Doc 08, Feature F2
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/evals
- **Effort:** 6h
- **Dependencies:** ECO-111
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-evals/src/scorers/llm-judge.ts` -- createLLMJudge() with multi-criteria, rubric, cost tracking, structured output parsing
  - `packages/forgeagent-evals/src/scorers/criteria.ts` -- STANDARD_CRITERIA, CODE_CRITERIA, CLEAR_CRITERIA, FIVE_POINT_RUBRIC, TEN_POINT_RUBRIC
- **Acceptance Criteria:**
  - [ ] Single-criterion mode (string criteria)
  - [ ] Multi-criteria mode (JudgeCriterion array with weights)
  - [ ] Weighted aggregate score
  - [ ] Retry on parse failure (up to maxRetries)
  - [ ] Cost tracking from usage_metadata
  - [ ] Custom prompt template support
  - [ ] Returns zero scores with 'error' label on total failure (non-throwing)
  - [ ] Pre-built criteria sets: STANDARD_CRITERIA, CODE_CRITERIA, CLEAR_CRITERIA
  - [ ] FIVE_POINT_RUBRIC and TEN_POINT_RUBRIC
  - [ ] Tests with mock model
  - [ ] Zero TS errors

---

### ECO-113: Deterministic Scorers (JSON Schema, Keyword, Latency, Cost)
- **Source:** Doc 08, Feature F3
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/evals
- **Effort:** 4h
- **Dependencies:** ECO-111
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-evals/src/scorers/deterministic.ts` -- createJSONSchemaScorer, createKeywordScorer, createLatencyScorer, createCostScorer, validateBasicSchema
- **Acceptance Criteria:**
  - [ ] JSONSchemaScorer: validates output against JSON schema (type, required, enum)
  - [ ] KeywordScorer: required + forbidden keywords, case sensitivity option
  - [ ] LatencyScorer: linear degradation from target to max
  - [ ] CostScorer: linear degradation from target to max
  - [ ] All conform to Scorer<EvalInput> interface
  - [ ] Each scorer has at least 3 unit tests
  - [ ] Zero TS errors

---

### ECO-114: Eval Dataset
- **Source:** Doc 08, Feature F4
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/evals
- **Effort:** 4h
- **Dependencies:** ECO-111
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-evals/src/dataset/eval-dataset.ts` -- EvalDataset class, EvalEntry, DatasetMetadata
  - `packages/forgeagent-evals/src/dataset/loaders.ts` -- fromJSON, fromJSONL, fromCSV factory methods
- **Acceptance Criteria:**
  - [ ] EvalDataset.fromJSON(), fromJSONL(), fromCSV() static loaders
  - [ ] EvalDataset.from() for inline creation
  - [ ] filter() by tags (AND logic) and ids
  - [ ] sample() with seeded PRNG for reproducibility
  - [ ] allTags() returns sorted unique tags
  - [ ] Immutable after construction (Object.freeze)
  - [ ] CSV parser handles quoted fields with commas
  - [ ] Tests for each loader + filter + sample
  - [ ] Zero TS errors

---

### ECO-115: Eval Runner (Enhanced)
- **Source:** Doc 08, Feature F5
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/evals
- **Effort:** 6h
- **Dependencies:** ECO-111, ECO-114
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-evals/src/runner/eval-runner.ts` -- EvalRunner with evaluateDataset(), concurrency control, progress events, CI mode, regression detection
  - `packages/forgeagent-evals/src/runner/eval-report.ts` -- EvalReport, EvalReportEntry, buildEvalReport(), toMarkdown(), toJSON(), toCIAnnotations()
- **Acceptance Criteria:**
  - [ ] evaluateDataset() with configurable concurrency limit
  - [ ] Progress callback after each entry
  - [ ] AbortSignal support for cancellation
  - [ ] EvalReport with aggregates (byScorerAverage, overallPass rate)
  - [ ] Regression detection comparing against baseline Map<scorerId, avgScore>
  - [ ] CI mode: throws EvalRegressionError on regression
  - [ ] toMarkdown() produces table with scorer columns
  - [ ] toCIAnnotations() produces GitHub Actions annotation format
  - [ ] Persistence to EvalResultStore (optional)
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-116: LLM Recorder (ESM Fix + JSONL Cassettes)
- **Source:** Doc 08, Feature F6
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/testing
- **Effort:** 6h
- **Dependencies:** None (enhances existing)
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-testing/src/recorder/llm-recorder.ts` -- Fix ESM violation (replace require with import), JSONL multi-fixture cassettes, fuzzy matching, recording filters
  - `packages/forgeagent-testing/src/recorder/cassette.ts` -- Cassette file format, load/save, hash computation
- **Acceptance Criteria:**
  - [ ] No `require()` calls; fully ESM
  - [ ] Cassette format: JSONL (one fixture per line) with SHA-256 request hash
  - [ ] Three modes: 'record', 'replay', 'passthrough'
  - [ ] Pluggable hash function for fuzzy matching (ignore timestamps, randomness)
  - [ ] Recording filters: include/exclude by model name, message content pattern
  - [ ] wrap() returns a BaseChatModel-compatible proxy
  - [ ] Test: record -> replay produces identical responses
  - [ ] Zero TS errors

---

### ECO-117: Enhanced Mock Chat Model
- **Source:** Doc 08, Feature F7
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/testing
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-testing/src/mock/mock-chat-model.ts` -- Add error simulation, pattern-matched responses, latency simulation, tool call scripting
- **Acceptance Criteria:**
  - [ ] Pattern-matched responses: match input message content to response
  - [ ] Error simulation: throw on Nth call or specific pattern
  - [ ] Latency simulation: configurable delay per call
  - [ ] Tool call scripting: return specific tool_calls based on input
  - [ ] Call history tracking with assertion helpers
  - [ ] Backward compatible with existing MockChatModel usage
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-118: Integration Test Harness
- **Source:** Doc 08, Feature F8
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/testing
- **Effort:** 6h
- **Dependencies:** ECO-117
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-testing/src/harness/test-dzip-agent.ts` -- TestDzipAgent wrapper with built-in assertions
  - `packages/forgeagent-testing/src/harness/test-mcp-server.ts` -- TestMCPServer for testing MCP tool integrations
  - `packages/forgeagent-testing/src/harness/scenario-runner.ts` -- Multi-turn conversation scenario runner
  - `packages/forgeagent-testing/src/harness/assertions.ts` -- assertToolCalled, assertNoToolErrors, assertBudgetUnder, assertOutputContains
- **Acceptance Criteria:**
  - [ ] TestDzipAgent: wraps DzipAgent with mock model, captures events, provides assertion helpers
  - [ ] TestMCPServer: in-memory MCP server that registers tools for testing
  - [ ] ScenarioRunner: execute multi-turn conversations from JSON definition
  - [ ] At least 8 assertion helpers covering tools, budget, output, events
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-119: CI/CD Eval Pipeline Template
- **Source:** Doc 08, Feature F10
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/evals
- **Effort:** 3h
- **Dependencies:** ECO-115
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-evals/templates/forge-evals.yml` -- GitHub Actions workflow template
  - `packages/forgeagent-evals/src/cli/eval-cli.ts` -- CLI entry point for running evals from command line
- **Acceptance Criteria:**
  - [ ] GitHub Actions workflow: install, build, run evals, compare baselines, post PR comment
  - [ ] CLI: `forge-eval run --dataset path --baseline path --ci`
  - [ ] Exit code 1 on regression
  - [ ] Markdown report as PR comment body
  - [ ] Baseline file auto-generation on first run
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### Formats & Standards (Doc 09)

---

### ECO-120: Agent Card v2 Types
- **Source:** Doc 09, Feature F1
- **Phase:** 4
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 2h
- **Dependencies:** ECO-001 (ForgeIdentity -- Phase 1)
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/formats/agent-card-types.ts` -- AgentCardV2, AgentCardCapability, AgentCardSkill, AgentCardAuthentication, AgentAuthScheme, ContentMode, AgentCardSLA, JsonSchema
  - `packages/forgeagent-core/src/formats/agent-card-validator.ts` -- validateAgentCard()
- **Acceptance Criteria:**
  - [ ] Full A2A-compliant types with JSON-LD context, capabilities with I/O schemas, auth modes, SLA
  - [ ] Zod-based validation function
  - [ ] JsonSchema utility type for IDE autocompletion
  - [ ] Zero TS errors

---

### ECO-121: Agent Card v2 Builder + Serving
- **Source:** Doc 09, Feature F1
- **Phase:** 4
- **Priority:** P0
- **Package:** @dzipagent/server
- **Effort:** 2h
- **Dependencies:** ECO-120
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/a2a/agent-card-v2.ts` -- buildAgentCardV2(), agentCardFromDzipAgent()
  - `packages/forgeagent-server/src/routes/a2a.ts` -- serve at both /.well-known/agent.json and /.well-known/agent-card.json
- **Acceptance Criteria:**
  - [ ] buildAgentCardV2() produces valid A2A Agent Card
  - [ ] agentCardFromDzipAgent() auto-generates from agent config + tools
  - [ ] Served at both well-known paths
  - [ ] Old AgentCardV1 type re-exported for one release cycle
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-122: OpenAI Function Calling Compatibility
- **Source:** Doc 09, Feature F3
- **Phase:** 4
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/formats/openai-function-types.ts` -- OpenAIFunctionDefinition, OpenAIToolDefinition, OpenAIToolCall
  - `packages/forgeagent-core/src/formats/tool-format-adapters.ts` -- ToolSchemaDescriptor, zodToJsonSchema(), jsonSchemaToZod(), toOpenAIFunction/Tool, fromOpenAIFunction, toMCPToolDescriptor, fromMCPToolDescriptor, fromLangChainTool
- **Acceptance Criteria:**
  - [ ] Bidirectional Zod <-> JSON Schema conversion
  - [ ] OpenAI strict mode support (additionalProperties: false, all properties required)
  - [ ] Bidirectional OpenAI function <-> ToolSchemaDescriptor
  - [ ] MCP tool <-> ToolSchemaDescriptor
  - [ ] LangChain tool -> ToolSchemaDescriptor extraction
  - [ ] Round-trip tests for each conversion
  - [ ] Zero TS errors

---

### ECO-123: Structured Output Standard
- **Source:** Doc 09, Feature F4
- **Phase:** 4
- **Priority:** P0
- **Package:** @dzipagent/agent
- **Effort:** 4h
- **Dependencies:** ECO-122
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/structured/structured-output-types.ts` -- StructuredOutputStrategy, StructuredOutputConfig
  - `packages/forgeagent-agent/src/structured/structured-output-engine.ts` -- generateStructured() with model-specific strategy selection, validation retry, fallback chain
  - `packages/forgeagent-agent/src/structured/strategy-detector.ts` -- detectStrategy() based on model provider
- **Acceptance Criteria:**
  - [ ] Auto-detect strategy from model type (Anthropic tool_use, OpenAI json_schema, generic, fallback)
  - [ ] Retry on schema validation failure (maxRetries, sends error back to model)
  - [ ] Fallback chain: native structured -> withStructuredOutput -> generate+parse
  - [ ] Strategy can be forced via config
  - [ ] Zod schema validation on output
  - [ ] Tests with mock model for each strategy
  - [ ] Zero TS errors

---

### ECO-124: AGENTS.md Extended Parser + Generator
- **Source:** Doc 09, Feature F2
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/formats/agents-md-types.ts` -- AgentsMdDocument, AgentsMdMetadata, AgentsMdCapability, AgentsMdMemoryConfig, AgentsMdSecurityConfig
  - `packages/forgeagent-core/src/formats/agents-md-parser-v2.ts` -- parseAgentsMdV2() with YAML front matter, capability/memory/security sections, toLegacyConfig()
  - `packages/forgeagent-core/src/formats/agents-md-generator.ts` -- generateAgentsMd(), agentsMdFromDzipAgent()
- **Acceptance Criteria:**
  - [ ] Parses YAML front matter (name, description, version, tags)
  - [ ] Parses Capabilities, Memory, Security structured sections
  - [ ] toLegacyConfig() backward compatible with existing AgentsMdConfig
  - [ ] Generator produces valid AAIF-standard markdown
  - [ ] agentsMdFromDzipAgent() auto-generates from agent config
  - [ ] Round-trip: parse -> generate -> parse produces equivalent document
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-125: Pipeline Definition Format (Serialization)
- **Source:** Doc 09, Feature F5
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 2h
- **Dependencies:** ECO-100
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/pipeline/pipeline-serialization.ts` -- serializePipeline(), deserializePipeline(), Zod schemas for validation on deserialization
- **Acceptance Criteria:**
  - [ ] JSON serialization with validation on load
  - [ ] Zod schema matches PipelineDefinition type exactly
  - [ ] Version migration support (schemaVersion field)
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-126: Agent Snapshot Format (Enhanced)
- **Source:** Doc 09, Feature F6
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/agent-state.ts` -- Enhanced AgentStateSnapshot with full config, working memory, memory dump, compression, content hash
- **Acceptance Criteria:**
  - [ ] Snapshot includes: messages, budget state, config, tool list, working memory
  - [ ] Content hash (SHA-256) for integrity verification
  - [ ] Compression option (gzip for large snapshots)
  - [ ] Schema version for forward compatibility
  - [ ] Backward compatible with existing snapshot consumers
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-127: Tool Schema Registry
- **Source:** Doc 09, Feature F7
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 3h
- **Dependencies:** ECO-122
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/tools/tool-schema-registry.ts` -- Schema versioning, backward compat checking, auto-docs generation from tool schemas
- **Acceptance Criteria:**
  - [ ] Register tool schemas with version
  - [ ] Backward compatibility check between schema versions
  - [ ] Export all tool schemas as ToolSchemaDescriptor array
  - [ ] Auto-generate markdown documentation from schemas
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-128: Message Format Standard
- **Source:** Doc 09, Feature F8
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/agent-state.ts` -- Enhanced SerializedMessage with tool_calls array, metadata, multimodal content support, migration from old format
- **Acceptance Criteria:**
  - [ ] SerializedMessage includes tool_calls array on AI messages
  - [ ] Metadata field for arbitrary message annotations
  - [ ] Migration function from old format to new
  - [ ] Multimodal content type (text + image references)
  - [ ] Backward compatible serialization
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### Observability -- Cost Attribution (Doc 06)

---

### ECO-129: Cost Attribution per Agent/Tool/Run
- **Source:** Doc 06, Feature (cost attribution)
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** Existing cost-tracking middleware
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/middleware/cost-attribution.ts` -- CostAttributionMiddleware that tags LLM calls with agentId/toolName/runId, CostReport with per-agent/per-tool/per-run breakdowns
- **Acceptance Criteria:**
  - [ ] Tags each LLM invocation with agentId, toolName, runId context
  - [ ] Aggregates cost by agent, by tool, by run
  - [ ] CostReport type with breakdowns
  - [ ] Integrates with existing cost-tracking middleware
  - [ ] Emits cost:attribution DzipEvent
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### Orchestration Patterns (Doc 04)

---

### ECO-130: Contract-Net Protocol
- **Source:** Doc 04, Feature (contract-net)
- **Phase:** 4
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 6h
- **Dependencies:** ECO-105 (Pipeline Runtime)
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/orchestration/contract-net.ts` -- ContractNetOrchestrator: manager broadcasts task, agents bid, manager selects winner, winner executes
- **Acceptance Criteria:**
  - [ ] Manager broadcasts call-for-proposal to registered agents
  - [ ] Agents respond with bids (estimated cost, time, confidence)
  - [ ] Manager selects winner based on configurable strategy (cheapest, fastest, best-quality)
  - [ ] Winner executes task; result returned to manager
  - [ ] Timeout handling for non-responsive agents
  - [ ] Events emitted for each protocol step
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-131: Dynamic Topology + Blackboard Pattern
- **Source:** Doc 04, Feature (dynamic topology, blackboard)
- **Phase:** 4
- **Priority:** P2
- **Package:** @dzipagent/agent
- **Effort:** 6h
- **Dependencies:** ECO-130
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/orchestration/dynamic-topology.ts` -- DynamicTopologyManager: add/remove agents at runtime, topology events
  - `packages/forgeagent-agent/src/orchestration/blackboard.ts` -- BlackboardPattern: shared state object, knowledge sources, control component
- **Acceptance Criteria:**
  - [ ] Dynamic topology: agents can join/leave during execution
  - [ ] Blackboard: shared state with read/write access, knowledge sources contribute
  - [ ] Control component selects which knowledge source to activate
  - [ ] Conflict resolution when multiple sources write to same key
  - [ ] Tests pass
  - [ ] Zero TS errors

---

## Phase 5: Runtime, DX & Security (Weeks 9-10)

### Runtime & Deployment (Doc 07)

---

### ECO-132: Sandbox Pool -- Core Implementation
- **Source:** Doc 07, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/codegen
- **Effort:** 6h
- **Dependencies:** None
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/pool/sandbox-pool.ts` -- SandboxPool class with start(), acquire(), release(), evict(), drain(), metrics()
  - `packages/forgeagent-codegen/src/sandbox/pool/pool-metrics.ts` -- SandboxPoolMetrics collection
- **Acceptance Criteria:**
  - [ ] Pre-warms minIdle sandboxes on start()
  - [ ] acquire() returns immediately when idle sandbox available
  - [ ] acquire() blocks up to maxWaitMs when pool exhausted
  - [ ] PoolExhaustedError thrown after maxWaitMs
  - [ ] Health check on acquire (configurable)
  - [ ] Background eviction timer removes idle-too-long sandboxes
  - [ ] drain() waits for active sandboxes then destroys all
  - [ ] Concurrency-safe (no deadlocks under 50 concurrent ops)
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-133: Sandbox Reset Strategies
- **Source:** Doc 07, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/codegen
- **Effort:** 2h
- **Dependencies:** ECO-132
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/pool/sandbox-reset.ts` -- SandboxResetStrategy interface, DockerResetStrategy, CloudResetStrategy
- **Acceptance Criteria:**
  - [ ] DockerResetStrategy: rm -rf /work/* /tmp/*, verify responsiveness
  - [ ] CloudResetStrategy: always returns false (destroy and recreate)
  - [ ] Reset failure causes sandbox destruction + replacement
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-134: Persistent Volumes -- Interface + Docker Implementation
- **Source:** Doc 07, Feature F3
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/codegen
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/volumes/volume-manager.ts` -- VolumeManager interface, VolumeDescriptor, VolumeInfo, VolumeCleanupPolicy, DEFAULT_CLEANUP_POLICIES
  - `packages/forgeagent-codegen/src/sandbox/volumes/docker-volume-manager.ts` -- DockerVolumeManager
  - `packages/forgeagent-codegen/src/sandbox/volumes/memory-volume-manager.ts` -- InMemoryVolumeManager (dev/test)
- **Acceptance Criteria:**
  - [ ] Three volume types: workspace (per-run), cache (per-tenant), temp (per-sandbox)
  - [ ] provision() creates or reuses volume by (name, scopeId)
  - [ ] release() triggers cleanup for workspace/temp, preserves cache
  - [ ] sweep() evicts volumes exceeding cleanup policy (LRU/LFU/oldest-first)
  - [ ] toMountArgs() produces Docker -v flags
  - [ ] InMemoryVolumeManager uses temp directories
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-135: Resource Quota Manager -- Interface
- **Source:** Doc 07, Feature F4
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 2h
- **Dependencies:** None
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/runtime/resource-quota.ts` -- ResourceQuotaManager interface, ResourceDimensions, ResourceQuota, ResourceReservation, QuotaCheckResult, QuotaOveragePolicy, QuotaExceededError
- **Acceptance Criteria:**
  - [ ] Interface with setQuota/getQuota/check/reserve/release/getUsage/listReservations/sweepExpired
  - [ ] Reservation-based model with auto-expiry
  - [ ] QuotaCheckResult discriminated union (allowed/denied with dimension details)
  - [ ] Zero TS errors

---

### ECO-136: InMemory Quota Manager
- **Source:** Doc 07, Feature F4
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 2h
- **Dependencies:** ECO-135
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/runtime/memory-quota-manager.ts` -- InMemoryQuotaManager
- **Acceptance Criteria:**
  - [ ] All ResourceQuotaManager methods implemented
  - [ ] Atomic reserve/release (usage = SUM(active reservations))
  - [ ] Double release is idempotent
  - [ ] No quota set = unlimited
  - [ ] sweepExpired removes stale reservations
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-137: Postgres Quota Manager + Schema
- **Source:** Doc 07, Feature F4
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 4h
- **Dependencies:** ECO-135
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/runtime/postgres-quota-manager.ts` -- PostgresQuotaManager
  - `packages/forgeagent-server/src/persistence/drizzle-schema.ts` -- add forge_resource_quotas, forge_resource_reservations tables
- **Acceptance Criteria:**
  - [ ] Transactional reserve (increment usage + insert reservation in single tx)
  - [ ] Transactional release (decrement usage + set releasedAt in single tx)
  - [ ] Concurrent reserve respects limits under race conditions
  - [ ] Drizzle schema matches spec
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-138: Sandbox Audit Logging -- Types + Decorator
- **Source:** Doc 07, Feature F7
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/codegen
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/audit/audit-types.ts` -- AuditEntry, AuditAction, AuditStore interface, AuditFilter
  - `packages/forgeagent-codegen/src/sandbox/audit/audited-sandbox.ts` -- AuditedSandbox decorator implementing SandboxProtocol
  - `packages/forgeagent-codegen/src/sandbox/audit/memory-audit-store.ts` -- InMemoryAuditStore
- **Acceptance Criteria:**
  - [ ] AuditedSandbox wraps any SandboxProtocol transparently
  - [ ] Records execute(), uploadFiles(), downloadFiles(), cleanup() calls
  - [ ] Hash chain (SHA-256) for tamper detection
  - [ ] Secret redaction in command strings
  - [ ] Audit logging failure does NOT break sandbox execution (fire-and-forget)
  - [ ] verifyChain() detects tampering
  - [ ] InMemoryAuditStore for testing
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-139: Sandbox Audit -- Postgres Store + REST API
- **Source:** Doc 07, Feature F7
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** ECO-138
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/persistence/drizzle-schema.ts` -- add forge_sandbox_audit_log table
  - `packages/forgeagent-server/src/routes/audit.ts` -- GET /api/runs/:id/audit, GET /api/sandboxes/:id/audit, GET /api/audit/verify/:sandboxId
- **Acceptance Criteria:**
  - [ ] Drizzle schema for append-only audit log
  - [ ] REST endpoints for querying audit entries
  - [ ] Hash chain verification endpoint
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### Security & Governance (Doc 12)

---

### ECO-140: Zero-Trust Policy Engine -- Types
- **Source:** Doc 12, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/security/policy/policy-types.ts` -- PolicyRule, PolicyEffect, PrincipalType, PolicyCondition, ConditionOperator, PolicySet, PolicyContext, PolicyDecision
  - `packages/forgeagent-core/src/security/policy/policy-store.ts` -- PolicyStore interface
- **Acceptance Criteria:**
  - [ ] PolicyRule with principal/action/resource filters and conditions
  - [ ] 11 condition operators (eq, neq, gt, gte, lt, lte, in, not_in, contains, glob, regex)
  - [ ] PolicySet with versioning and active flag
  - [ ] PolicyContext captures full request environment
  - [ ] PolicyDecision includes matched rules and deciding rule
  - [ ] Zero TS errors

---

### ECO-141: Zero-Trust Policy Engine -- Evaluator
- **Source:** Doc 12, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 6h
- **Dependencies:** ECO-140
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/security/policy/policy-evaluator.ts` -- PolicyEvaluator class (pure, sync, no I/O)
- **Acceptance Criteria:**
  - [ ] Deny-overrides conflict resolution
  - [ ] Default-deny for unknown actions
  - [ ] Principal matching by type, id, roles
  - [ ] Action matching by exact name and glob pattern
  - [ ] Resource matching by id, type, glob pattern
  - [ ] All 11 condition operators implemented
  - [ ] Expired rules skipped
  - [ ] Priority ordering within policy set
  - [ ] Pure function: no I/O, no async, no LLM
  - [ ] Evaluation time tracked in microseconds
  - [ ] validate() returns structural errors
  - [ ] New error codes: POLICY_DENIED, POLICY_INVALID
  - [ ] New event types: policy:evaluated, policy:denied, policy:set_updated
  - [ ] At least 20 unit tests
  - [ ] Zero TS errors

---

### ECO-142: Policy Engine -- Postgres Store + REST API
- **Source:** Doc 12, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 4h
- **Dependencies:** ECO-140, ECO-141
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/persistence/postgres-policy-store.ts` -- PostgresPolicyStore
  - `packages/forgeagent-server/src/routes/policies.ts` -- CRUD REST API for policy sets
  - `packages/forgeagent-server/src/persistence/drizzle-schema.ts` -- add forge_policy_sets table
- **Acceptance Criteria:**
  - [ ] Version history per policy set
  - [ ] REST: GET/POST/PUT/DELETE /api/policies, GET /api/policies/:id/versions
  - [ ] InMemoryPolicyStore in core for dev/test
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-143: Policy Translator (NL to Policy)
- **Source:** Doc 12, Feature F1
- **Phase:** 5
- **Priority:** P2
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** ECO-140
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/security/policy/policy-translator.ts` -- PolicyTranslator: translate() NL -> PolicyRule, explain() PolicyRule -> NL
- **Acceptance Criteria:**
  - [ ] AUTHORING tool only, never in enforcement path
  - [ ] translate() returns PolicyRule + confidence + explanation
  - [ ] explain() returns human-readable description of a rule
  - [ ] Uses LLM with structured output
  - [ ] Tests with mock model
  - [ ] Zero TS errors

---

### ECO-144: Runtime Safety Monitor
- **Source:** Doc 12, Feature F2
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 6h
- **Dependencies:** ECO-141
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/security/monitor/safety-monitor.ts` -- createSafetyMonitor(), SafetyMonitor interface, SafetyViolation, SafetyRule, SafetyCategory
  - `packages/forgeagent-core/src/security/monitor/built-in-rules.ts` -- prompt injection scanner, PII/secret leak scanner, tool abuse detector, escalation detector
- **Acceptance Criteria:**
  - [ ] Subscribes to DzipEventBus automatically
  - [ ] 5 built-in scanning rules (injection, PII, secrets, tool abuse, escalation)
  - [ ] Behavioral anomaly detection (consecutive failures, repeated calls)
  - [ ] Configurable severity and action per category
  - [ ] scanContent() for on-demand scanning
  - [ ] Events: safety:violation, safety:blocked, safety:kill_requested
  - [ ] dispose() unsubscribes cleanly
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-145: Compliance Audit Trail -- Types + In-Memory Store
- **Source:** Doc 12, Feature F3
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/security/audit/audit-types.ts` -- AuditEntry (with hash chain), AuditFilter, RetentionPolicy, IntegrityCheckResult
  - `packages/forgeagent-core/src/security/audit/audit-store.ts` -- AuditStore interface (append-only, no update/delete)
  - `packages/forgeagent-core/src/security/audit/in-memory-audit-store.ts` -- InMemoryAuditStore
  - `packages/forgeagent-core/src/security/audit/audit-logger.ts` -- AuditLogger interface, bridge from DzipEventBus
- **Acceptance Criteria:**
  - [ ] Hash chain: SHA-256(previous entry fields + previousHash)
  - [ ] AuditStore is append-only (no update, no delete on individual entries)
  - [ ] verifyIntegrity() detects tampering
  - [ ] AuditLogger subscribes to security-relevant DzipEvents (12 event types mapped)
  - [ ] RetentionPolicy with archive/delete actions
  - [ ] NDJSON export via AsyncIterable
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-146: Compliance Audit Trail -- Postgres Store + Routes
- **Source:** Doc 12, Feature F3
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 4h
- **Dependencies:** ECO-145
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/persistence/postgres-audit-store.ts` -- PostgresAuditStore
  - `packages/forgeagent-server/src/persistence/drizzle-schema.ts` -- add forge_audit_entries table
  - `packages/forgeagent-server/src/routes/audit-security.ts` -- GET /api/audit, GET /api/audit/:id, GET /api/audit/integrity, POST /api/audit/export, POST /api/audit/retention, GET /api/audit/stats
- **Acceptance Criteria:**
  - [ ] Append-only Postgres table
  - [ ] Hash chain maintained across concurrent appends (row-level lock on last hash)
  - [ ] All 6 REST endpoints
  - [ ] Retention policy application via scheduled sweep
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-147: Memory Poisoning Defense
- **Source:** Doc 12, Feature F4
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 6h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/security/memory/memory-defense.ts` -- MemoryDefense interface, MemoryDefenseResult, MemoryThreat, MemoryDefenseConfig, createMemoryDefense()
- **Acceptance Criteria:**
  - [ ] Homoglyph normalization (Unicode NFKD + confusables table)
  - [ ] Base64/hex encoding detection and decode+rescan
  - [ ] Cross-reference against existing trusted facts (configurable)
  - [ ] Bulk modification detection (max facts per write)
  - [ ] Optional LLM analysis for ambiguous cases (disabled by default)
  - [ ] Three actions: allow, quarantine, reject
  - [ ] Provenance verification (content hash, writer identity)
  - [ ] Events: memory:threat_detected, memory:quarantined
  - [ ] Integration point: slots between sanitizeMemoryContent() and PolicyAwareStagedWriter
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-148: Sandbox Hardening
- **Source:** Doc 12, Feature F5
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/codegen
- **Effort:** 6h
- **Dependencies:** None
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/sandbox-hardening.ts` -- HardenedSandboxConfig, HardenedExecResult, HardenedSandbox interface, SeccompProfile, FilesystemACL, EgressRule
  - `packages/forgeagent-codegen/src/sandbox/hardened-docker-sandbox.ts` -- HardenedDockerSandbox implementation
  - `packages/forgeagent-codegen/src/sandbox/seccomp/nodejs.json` -- Node.js seccomp profile
- **Acceptance Criteria:**
  - [ ] Seccomp profiles: default, strict, nodejs, custom
  - [ ] Node.js seccomp profile with minimal required syscalls
  - [ ] Filesystem ACLs (path + read/write/none)
  - [ ] Network egress whitelisting (host + port + protocol)
  - [ ] OOM detection from cgroup stats
  - [ ] Two-phase kill: SIGTERM (soft timeout) then SIGKILL (hard timeout)
  - [ ] Escape detection heuristics (suspicious syscalls via seccomp log)
  - [ ] PID limit, drop all capabilities, selective add-back
  - [ ] HardenedExecResult includes oomKilled, peakMemoryBytes, escapeAttemptDetected, hardKilled
  - [ ] Docker flag mapping for each config option
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-149: Output Safety Filters (Enhanced)
- **Source:** Doc 12, Feature F7
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/security/output/output-filter-enhanced.ts` -- Enhanced OutputPipeline with harmful-content filter, classification-aware PII redaction
- **Acceptance Criteria:**
  - [ ] Harmful content filter (configurable categories)
  - [ ] Classification-aware redaction (higher sensitivity for classified data)
  - [ ] Extends existing OutputPipeline without breaking changes
  - [ ] Non-fatal: filter failure logs but does not block response
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### Developer Experience (Doc 11)

---

### ECO-150: Agent Templates Library (Expanded)
- **Source:** Doc 11, Feature F4
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 6h
- **Dependencies:** None
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/templates/agent-templates.ts` -- Expand from 6 to 20+ templates (code, data, infrastructure, content, research, automation categories)
  - `packages/forgeagent-agent/src/templates/template-composer.ts` -- composeTemplates() for merging multiple templates
  - `packages/forgeagent-agent/src/templates/template-registry.ts` -- TemplateRegistry with register/get/list/listByTag/listByCategory
- **Acceptance Criteria:**
  - [ ] At least 20 templates across 6 categories
  - [ ] Each template: id, name, description, instructions (>50 chars), modelTier, suggestedTools, guardrails, tags
  - [ ] composeTemplates() merges instructions, unions tools/tags, uses highest model tier, max guardrail values
  - [ ] TemplateRegistry: register custom templates, list by tag/category
  - [ ] Validation test for every template (required fields, reasonable bounds)
  - [ ] Template composition tests
  - [ ] Zero TS errors

---

### ECO-151: Development Mode (forgeagent dev)
- **Source:** Doc 11, Feature F7
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/cli/dev-command.ts` -- devCommand() with hot reload, live trace viewer, cost tracker
  - `packages/forgeagent-server/src/cli/trace-printer.ts` -- Terminal event formatter (subscribes to DzipEventBus)
- **Acceptance Criteria:**
  - [ ] Starts Hono server on configured port
  - [ ] File watching via tsx --watch
  - [ ] Live trace output: formatted events in terminal (timestamp, runId, event type, details)
  - [ ] Cumulative cost display in terminal header
  - [ ] --no-playground and --verbose flags
  - [ ] Config reload on forgeagent.config.json change
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-152: Integration Test Scaffolding Command
- **Source:** Doc 11, Feature F6
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 4h
- **Dependencies:** ECO-150
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/cli/test-scaffold-command.ts` -- forgeagent test:scaffold command
  - `packages/forgeagent-server/src/cli/templates/unit-test.ts.ejs` -- Unit test template
  - `packages/forgeagent-server/src/cli/templates/forge-mocks.ts.ejs` -- Mock helper template (createMockModel, createMockMemory)
- **Acceptance Criteria:**
  - [ ] Generates unit test files from agent configuration
  - [ ] --agent flag for specific agent, --pattern for test types (unit, integration, eval)
  - [ ] --mock-helpers generates shared mock setup file
  - [ ] Generated tests compile with vitest
  - [ ] --overwrite flag for regeneration
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-153: create-dzipagent CLI -- Scaffold Engine
- **Source:** Doc 11, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** create-dzipagent (new package)
- **Effort:** 4h
- **Dependencies:** ECO-150
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/create-dzipagent/package.json` -- package setup with bin entry
  - `packages/create-dzipagent/src/types.ts` -- ScaffoldOptions, ScaffoldResult, ScaffoldEngine
  - `packages/create-dzipagent/src/scaffold-engine.ts` -- Core scaffolding logic
  - `packages/create-dzipagent/src/template-renderer.ts` -- EJS template rendering
- **Acceptance Criteria:**
  - [ ] ScaffoldEngine.generate() creates project from ScaffoldOptions
  - [ ] EJS template rendering with variable interpolation
  - [ ] 5 template manifests (minimal, full-stack, codegen, multi-agent, server)
  - [ ] Shared templates (tsconfig, .gitignore, .env.example, package.json, forgeagent.config.json)
  - [ ] Generated projects have correct dependencies based on features
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-154: create-dzipagent CLI -- Interactive Prompts
- **Source:** Doc 11, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** create-dzipagent
- **Effort:** 4h
- **Dependencies:** ECO-153
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/create-dzipagent/src/index.ts` -- CLI entry point
  - `packages/create-dzipagent/src/cli.ts` -- Argument parsing (commander)
  - `packages/create-dzipagent/src/prompts.ts` -- Interactive prompts (@clack/prompts)
  - `packages/create-dzipagent/src/dependency-installer.ts` -- npm/pnpm/yarn detection
  - `packages/create-dzipagent/src/env-writer.ts` -- .env generation
- **Acceptance Criteria:**
  - [ ] 7-step interactive prompt flow (project name, template, features, database, deploy, LLM provider, confirmation)
  - [ ] Non-interactive mode with -y flag
  - [ ] Package manager detection (npm/pnpm/yarn)
  - [ ] .env creation with API key from prompts
  - [ ] "Getting Started" banner after completion
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-155: create-dzipagent CLI -- Templates
- **Source:** Doc 11, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** create-dzipagent
- **Effort:** 4h
- **Dependencies:** ECO-153
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/create-dzipagent/src/templates/minimal/` -- minimal template EJS files
  - `packages/create-dzipagent/src/templates/full-stack/` -- full-stack template EJS files
  - `packages/create-dzipagent/src/templates/codegen/` -- codegen template EJS files
  - `packages/create-dzipagent/src/templates/multi-agent/` -- multi-agent template EJS files
  - `packages/create-dzipagent/src/templates/server/` -- server template EJS files
  - `packages/create-dzipagent/src/templates/manifests/` -- TemplateManifest JSON files
- **Acceptance Criteria:**
  - [ ] Each template generates valid TypeScript project
  - [ ] Generated projects compile with tsc --noEmit (zero errors)
  - [ ] Generated forgeagent.config.json passes validateConfig()
  - [ ] Feature flags control which files are included
  - [ ] Snapshot tests for each template structure
  - [ ] Zero TS errors

---

### ECO-156: Runtime CLI -- Plugin Commands
- **Source:** Doc 11, Feature F1
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** Existing plugin infrastructure
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/cli/index.ts` -- CLI entry point (commander)
  - `packages/forgeagent-server/src/cli/add-command.ts` -- forgeagent add
  - `packages/forgeagent-server/src/cli/remove-command.ts` -- forgeagent remove
  - `packages/forgeagent-server/src/cli/plugins-command.ts` -- forgeagent plugins
- **Acceptance Criteria:**
  - [ ] forgeagent add: npm install + validate manifest + update config
  - [ ] forgeagent remove: npm uninstall + remove from config
  - [ ] forgeagent plugins: list installed with status
  - [ ] Local path support (./my-plugin)
  - [ ] Rejects invalid manifests
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-157: Runtime CLI -- Config + Memory Commands
- **Source:** Doc 11, Feature F7
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 2h
- **Dependencies:** None
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/cli/config-command.ts` -- forgeagent config:validate, config:show
  - `packages/forgeagent-server/src/cli/memory-command.ts` -- forgeagent memory:browse, memory:search
- **Acceptance Criteria:**
  - [ ] config:validate parses and validates forgeagent.config.json
  - [ ] config:show prints resolved configuration
  - [ ] memory:browse lists entries in a namespace
  - [ ] memory:search searches across namespaces
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-158: Deployment Helpers -- Docker
- **Source:** Doc 11, Feature F8
- **Phase:** 5
- **Priority:** P2
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/cli/deploy-command.ts` -- forgeagent deploy
  - `packages/forgeagent-server/src/deploy/docker-generator.ts` -- Dockerfile, docker-compose.yml, .dockerignore generation
  - `packages/forgeagent-server/src/deploy/health-checker.ts` -- Post-deploy health validation
- **Acceptance Criteria:**
  - [ ] Generates multi-stage Dockerfile (Node 20, build + run stages)
  - [ ] Generates docker-compose.yml with Postgres + app
  - [ ] Health check validation after deployment
  - [ ] --dry-run generates files without building
  - [ ] --tag and --push flags for container registry
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-159: Deployment Helpers -- K8s
- **Source:** Doc 11, Feature F8
- **Phase:** 5
- **Priority:** P2
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** ECO-158
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/deploy/k8s-generator.ts` -- Deployment, Service, ConfigMap, Secret template, HPA generation
- **Acceptance Criteria:**
  - [ ] Generates K8s Deployment with resource limits
  - [ ] Service (ClusterIP)
  - [ ] ConfigMap from forgeagent.config.json
  - [ ] Secret template for API keys
  - [ ] Optional HPA (--hpa flag)
  - [ ] Readiness/liveness probes
  - [ ] --namespace and --replicas flags
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-160: Deployment Helpers -- Serverless (Vercel/Lambda/Cloudflare)
- **Source:** Doc 11, Feature F8
- **Phase:** 5
- **Priority:** P2
- **Package:** @dzipagent/server
- **Effort:** 2h
- **Dependencies:** ECO-158
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/deploy/vercel-generator.ts` -- vercel.json + api entry point
  - `packages/forgeagent-server/src/deploy/lambda-generator.ts` -- serverless.yml or CDK + handler
  - `packages/forgeagent-server/src/deploy/cloudflare-generator.ts` -- wrangler.toml + handler
- **Acceptance Criteria:**
  - [ ] Each generator produces correct config + handler entry point
  - [ ] Uses existing toLambdaHandler/toVercelHandler/toCloudflareHandler adapters
  - [ ] Rollback support for Docker/K8s targets
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-161: Agent Hot-Reload
- **Source:** Doc 07, Feature F6
- **Phase:** 5
- **Priority:** P2
- **Package:** @dzipagent/server
- **Effort:** 6h
- **Dependencies:** None
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/runtime/hot-reload.ts` -- AgentHotReloader with start/stop/reload/rollback/getActiveVersion/getVersionHistory
  - `packages/forgeagent-server/src/routes/agents.ts` -- add POST /api/agents/:id/reload, POST /api/agents/:id/rollback, GET /api/agents/:id/versions
- **Acceptance Criteria:**
  - [ ] Dev mode: file watcher (chokidar) detects .ts/.json changes
  - [ ] Production: API-driven reload endpoint
  - [ ] Version tracking with content hash for change detection
  - [ ] Active runs keep pinned version; new runs use latest
  - [ ] Rollback to previous version
  - [ ] maxRetainedVersions eviction
  - [ ] Debounce for rapid file changes
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-162: Multi-Sandbox Orchestration
- **Source:** Doc 07, Feature F8
- **Phase:** 5
- **Priority:** P2
- **Package:** @dzipagent/codegen
- **Effort:** 6h
- **Dependencies:** ECO-132 (Sandbox Pool), ECO-134 (Volumes)
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/orchestration/sandbox-orchestrator.ts` -- SandboxOrchestrator with execute() and validate()
  - `packages/forgeagent-codegen/src/sandbox/orchestration/task-graph.ts` -- DAG validation + topological sort
  - `packages/forgeagent-codegen/src/sandbox/orchestration/output-bridge.ts` -- File transfer between sandboxes
- **Acceptance Criteria:**
  - [ ] DAG-based task execution with dependency ordering
  - [ ] Parallel execution up to maxParallel limit
  - [ ] Cycle detection in task graph
  - [ ] Dependency output mounting as read-only in dependent tasks
  - [ ] Failure policies: abort, skip-dependents, continue
  - [ ] Total orchestration timeout
  - [ ] cancel() cleans up all active sandboxes
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-163: Pipeline Templates
- **Source:** Doc 10, Feature F7
- **Phase:** 5
- **Priority:** P2
- **Package:** @dzipagent/agent
- **Effort:** 3h
- **Dependencies:** ECO-100, ECO-105
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/pipeline/pipeline-templates.ts` -- Pre-built pipeline templates (code-review, feature-generation, test-generation, refactoring)
- **Acceptance Criteria:**
  - [ ] At least 4 pipeline templates
  - [ ] Each template produces valid PipelineDefinition
  - [ ] Templates accept customization parameters
  - [ ] All templates pass validator
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-164: Pipeline Events in DzipEventBus
- **Source:** Doc 10, Feature F2
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 2h
- **Dependencies:** ECO-100
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/events/event-types.ts` -- Add PipelineRuntimeEvent types to DzipEvent union (pipeline:started, node_started, node_completed, node_failed, node_skipped, suspended, resumed, loop_iteration, checkpoint_saved, completed, failed, cancelled)
- **Acceptance Criteria:**
  - [ ] 12 new pipeline event types added to DzipEvent union
  - [ ] Proper discriminated union structure
  - [ ] Backward compatible (existing event handlers unaffected)
  - [ ] Zero TS errors

---

### ECO-165: Security Events in DzipEventBus
- **Source:** Doc 12, Features F1-F4
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 2h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/events/event-types.ts` -- Add security event types (policy:evaluated, policy:denied, policy:set_updated, safety:violation, safety:blocked, safety:kill_requested, memory:threat_detected, memory:quarantined)
- **Acceptance Criteria:**
  - [ ] 8 new security event types in DzipEvent union
  - [ ] Backward compatible
  - [ ] Zero TS errors

---

### ECO-166: Server Routes -- Memory Browse + Run Trace
- **Source:** Doc 11, Feature F2 (Playground prerequisites)
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/routes/memory-browse.ts` -- GET /api/memory/:namespace
  - `packages/forgeagent-server/src/routes/runs.ts` -- GET /api/runs/:id/trace (execution trace with events + usage)
- **Acceptance Criteria:**
  - [ ] Memory browse: scope filter, limit, search query
  - [ ] Run trace: ordered events with timestamps, usage summary (tokens, cost, LLM calls)
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-167: Runtime Manager (Pool + Quota + Audit Integration)
- **Source:** Doc 07, Architecture
- **Phase:** 5
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** ECO-132, ECO-135, ECO-138
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/runtime/runtime-manager.ts` -- RuntimeManager that ties sandbox pool, quota manager, and audit logging together
- **Acceptance Criteria:**
  - [ ] acquireSandbox(): check quota -> reserve -> acquire from pool -> wrap with audit
  - [ ] releaseSandbox(): release pool -> release quota
  - [ ] Graceful shutdown: drain pool, sweep expired reservations
  - [ ] Tests pass
  - [ ] Zero TS errors

---

## Phase 6: Future (P3 Features, No Fixed Timeline)

### ECO-168: WASM Sandbox -- WASI Filesystem
- **Source:** Doc 07, Feature F5
- **Phase:** 6
- **Priority:** P3
- **Package:** @dzipagent/codegen
- **Effort:** 8h
- **Dependencies:** None
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/wasm/wasi-fs.ts` -- In-memory WASI filesystem
  - `packages/forgeagent-codegen/src/sandbox/wasm/capability-guard.ts` -- Capability-based permission enforcement
- **Acceptance Criteria:**
  - [ ] In-memory filesystem with read/write/stat operations
  - [ ] Capability enforcement: ungrated capabilities throw errors
  - [ ] 8 capability types (fs-read, fs-write, env, clock, random, stdout, stderr, stdin)
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-169: WASM Sandbox -- QuickJS Integration
- **Source:** Doc 07, Feature F5
- **Phase:** 6
- **Priority:** P3
- **Package:** @dzipagent/codegen
- **Effort:** 8h
- **Dependencies:** ECO-168
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/wasm/wasm-sandbox.ts` -- WasmSandbox implementing SandboxProtocol
- **Acceptance Criteria:**
  - [ ] QuickJS WASM module integration (ES2023 support)
  - [ ] Sub-millisecond startup
  - [ ] Fuel metering for timeout enforcement
  - [ ] Memory page limit enforcement
  - [ ] Implements full SandboxProtocol (isAvailable, execute, uploadFiles, downloadFiles, cleanup)
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-170: WASM Sandbox -- TypeScript Support
- **Source:** Doc 07, Feature F5
- **Phase:** 6
- **Priority:** P3
- **Package:** @dzipagent/codegen
- **Effort:** 8h
- **Dependencies:** ECO-169
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/wasm/ts-transpiler.ts` -- TypeScript to JS transpilation within WASM (esbuild-wasm or swc-wasm)
- **Acceptance Criteria:**
  - [ ] Transpile TypeScript to JavaScript inside WASM sandbox
  - [ ] Type checking via bundled tsc as WASM
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-171: Kubernetes CRD Definition + Types
- **Source:** Doc 07, Feature F2
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/codegen
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `k8s/crd/agent-sandbox.yaml` -- CRD definition
  - `packages/forgeagent-codegen/src/sandbox/k8s/operator-types.ts` -- AgentSandboxSpec, AgentSandboxPhase, AgentSandboxStatus, AgentSandboxResource
- **Acceptance Criteria:**
  - [ ] CRD with spec (image, securityLevel, runtimeClass, resources, network, volumes, runRef, ttlSeconds) and status
  - [ ] TypeScript types match CRD schema exactly
  - [ ] Example CRD instances (strict, minimal)
  - [ ] Zero TS errors

---

### ECO-172: K8s Pod Sandbox Client
- **Source:** Doc 07, Feature F2
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/codegen
- **Effort:** 6h
- **Dependencies:** ECO-171
- **Agent:** forgeagent-codegen-dev
- **Files to create/modify:**
  - `packages/forgeagent-codegen/src/sandbox/k8s/k8s-sandbox.ts` -- K8sPodSandbox implementing SandboxProtocol
  - `packages/forgeagent-codegen/src/sandbox/k8s/k8s-client.ts` -- Minimal K8s API client
- **Acceptance Criteria:**
  - [ ] Creates AgentSandbox CRD, waits for Ready phase
  - [ ] Execute via K8s exec API (WebSocket)
  - [ ] File upload/download via tar stream
  - [ ] Cleanup deletes CRD (operator handles pod cleanup)
  - [ ] Configurable namespace, timeout, defaults
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-173: K8s Operator + Helm Chart
- **Source:** Doc 07, Feature F2
- **Phase:** 6
- **Priority:** P2
- **Package:** Separate (k8s/operator/)
- **Effort:** 6h
- **Dependencies:** ECO-171
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `k8s/operator/src/reconciler.ts` -- Main reconcile loop
  - `k8s/operator/src/pod-builder.ts` -- Build pod spec from AgentSandboxSpec
  - `k8s/operator/src/netpol-builder.ts` -- Build NetworkPolicy
  - `k8s/helm/forgeagent-operator/` -- Helm chart (Chart.yaml, values.yaml, templates/)
- **Acceptance Criteria:**
  - [ ] Operator watches AgentSandbox CRDs
  - [ ] Creates/manages pods with security policies
  - [ ] Auto-generates NetworkPolicy per sandbox
  - [ ] TTL enforcement (auto-destroy after ttlSeconds)
  - [ ] Helm chart for deployment
  - [ ] Zero TS errors

---

### ECO-174: Agent Playground -- Core Layout + Chat
- **Source:** Doc 11, Feature F2
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/playground (new package)
- **Effort:** 8h
- **Dependencies:** ECO-166 (memory browse + trace routes)
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-playground/` -- Vue 3 SPA (package.json, vite.config.ts, src/main.ts, App.vue)
  - `packages/forgeagent-playground/src/views/PlaygroundView.vue`
  - `packages/forgeagent-playground/src/components/chat/` -- ChatPanel, MessageList, ChatInput
  - `packages/forgeagent-playground/src/stores/chat-store.ts`, `ws-store.ts`
  - `packages/forgeagent-playground/src/composables/useWebSocket.ts`, `useApi.ts`
- **Acceptance Criteria:**
  - [ ] Vue 3 + Vite SPA served at /playground
  - [ ] Agent selector from /api/agents
  - [ ] Chat interface with markdown rendering
  - [ ] WebSocket connection for streaming events
  - [ ] Reconnection with exponential backoff
  - [ ] Zero TS errors

---

### ECO-175: Agent Playground -- Inspector Panels
- **Source:** Doc 11, Feature F2
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/playground
- **Effort:** 8h
- **Dependencies:** ECO-174
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-playground/src/components/inspector/` -- TraceTab, MemoryTab, ConfigTab, HistoryTab
  - `packages/forgeagent-playground/src/stores/trace-store.ts`, `memory-store.ts`
- **Acceptance Criteria:**
  - [ ] Trace viewer: timeline of events with duration bars
  - [ ] Memory browser: namespace list, search, entry editor
  - [ ] Config editor: instructions, guardrails, tool list
  - [ ] History: paginated run list with replay
  - [ ] Tool call visualization (collapsible cards)
  - [ ] Cost badge with running totals
  - [ ] Zero TS errors

---

### ECO-176: Agent Playground -- Serving Integration
- **Source:** Doc 11, Feature F2
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/server
- **Effort:** 2h
- **Dependencies:** ECO-174, ECO-175
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/routes/playground.ts` -- serveStatic for playground assets, SPA fallback
- **Acceptance Criteria:**
  - [ ] Pre-built playground assets served from /playground
  - [ ] SPA fallback for client-side routing
  - [ ] Dev mode: optional Vite proxy for HMR
  - [ ] Zero TS errors

---

### ECO-177: Plugin Marketplace
- **Source:** Doc 11, Feature F3
- **Phase:** 6
- **Priority:** P3
- **Package:** @dzipagent/playground, @dzipagent/server
- **Effort:** 8h
- **Dependencies:** ECO-174
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-playground/src/views/MarketplaceView.vue`
  - `packages/forgeagent-playground/src/components/marketplace/` -- Search, CategorySidebar, PluginGrid, PluginCard
  - `packages/forgeagent-server/src/cli/marketplace-command.ts` -- forgeagent marketplace
- **Acceptance Criteria:**
  - [ ] Browse plugins from static registry JSON
  - [ ] Search by name, description, capabilities
  - [ ] Category filtering
  - [ ] Verified badge for signed plugins
  - [ ] Install button triggers forgeagent add
  - [ ] CLI: forgeagent marketplace (terminal table or open browser)
  - [ ] Zero TS errors

---

### ECO-178: Documentation Generation
- **Source:** Doc 11, Feature F5
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/server
- **Effort:** 6h
- **Dependencies:** ECO-150
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/cli/docs-generate-command.ts` -- forgeagent docs:generate
  - `packages/forgeagent-server/src/docs/doc-generator.ts` -- DocGenerator
  - `packages/forgeagent-server/src/docs/agent-doc.ts` -- Agent page renderer
  - `packages/forgeagent-server/src/docs/tool-doc.ts` -- Tool page renderer (schema table, examples)
  - `packages/forgeagent-server/src/docs/pipeline-doc.ts` -- Pipeline Mermaid diagram renderer
- **Acceptance Criteria:**
  - [ ] Generates markdown docs for agents, tools, memory, pipelines, plugins, config
  - [ ] Tool docs include parameter tables from JSON Schema
  - [ ] Pipeline docs include Mermaid flow diagrams
  - [ ] Index page with table of contents
  - [ ] --format markdown|html, --output flag, --include filter
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-179: Benchmark Suite
- **Source:** Doc 08, Feature F9
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/evals
- **Effort:** 8h
- **Dependencies:** ECO-114, ECO-115
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-evals/src/benchmarks/` -- Standard benchmark datasets + runner for code generation, QA, tool use, multi-turn conversation
- **Acceptance Criteria:**
  - [ ] At least 4 benchmark suites (code-gen, QA, tool-use, multi-turn)
  - [ ] Each suite: dataset + scorers + baseline thresholds
  - [ ] CLI: forge-eval benchmark --suite code-gen
  - [ ] Results persist for trend tracking
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-180: Cross-Agent Security
- **Source:** Doc 12, Feature F6
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/agent
- **Effort:** 6h
- **Dependencies:** ECO-141 (Policy Engine)
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/security/agent-auth.ts` -- AgentCredential, SignedAgentMessage, message signing/verification (Ed25519), capability-based access control
- **Acceptance Criteria:**
  - [ ] Ed25519 key pair generation per agent
  - [ ] Message signing (canonical JSON + Ed25519)
  - [ ] Signature verification
  - [ ] Replay prevention (nonce + timestamp window)
  - [ ] Capability-based restrictions on agent-to-agent calls
  - [ ] Integration with PolicyEvaluator
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-181: Incident Response
- **Source:** Doc 12, Feature F8
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/server
- **Effort:** 6h
- **Dependencies:** ECO-144 (Safety Monitor), ECO-145 (Audit Trail)
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/security/incident-response.ts` -- IncidentPlaybook, IncidentResponse engine, automated actions (kill agent, disable tool, quarantine memory, notify via webhook)
- **Acceptance Criteria:**
  - [ ] Playbook definition (trigger condition -> automated actions)
  - [ ] Built-in actions: kill agent, disable tool, quarantine namespace, webhook notification
  - [ ] Incident record with timeline and actions taken
  - [ ] REST API for playbook management
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-182: Data Classification
- **Source:** Doc 12, Feature F9
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/security/classification/data-classification.ts` -- DataClassification types (public, internal, confidential, restricted), classification tagging for memory namespaces, classification-aware access policies
- **Acceptance Criteria:**
  - [ ] 4-level classification (public, internal, confidential, restricted)
  - [ ] Namespace-level classification tagging
  - [ ] Classification-aware policy conditions
  - [ ] Auto-classification heuristics (PII patterns, secret patterns)
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-183: Security Testing Framework
- **Source:** Doc 12, Feature F10
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/testing
- **Effort:** 6h
- **Dependencies:** ECO-118 (Test Harness), ECO-141 (Policy Engine)
- **Agent:** forgeagent-test-dev
- **Files to create/modify:**
  - `packages/forgeagent-testing/src/security/` -- Prompt injection test suite, privilege escalation test suite, memory poisoning test suite, sandbox escape test suite
- **Acceptance Criteria:**
  - [ ] Pre-built test suites for each STRIDE threat category
  - [ ] At least 20 test cases across all suites
  - [ ] runSecuritySuite() function with configurable severity thresholds
  - [ ] Report format compatible with EvalReport
  - [ ] Tests pass
  - [ ] Zero TS errors

---

### ECO-184: Visual Pipeline Editor Data Model
- **Source:** Doc 10, Feature F8
- **Phase:** 6
- **Priority:** P3
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** ECO-100
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/pipeline/pipeline-layout.ts` -- PipelineLayout type (node positions, viewport), PipelineDefinition.metadata.layout field
- **Acceptance Criteria:**
  - [ ] Node position data (x, y, width, height) stored in metadata
  - [ ] Viewport state (zoom, pan)
  - [ ] Layout preserved across serialization
  - [ ] Zero TS errors

---

### ECO-185: Pipeline Analytics
- **Source:** Doc 10, Feature F9
- **Phase:** 6
- **Priority:** P2
- **Package:** @dzipagent/agent
- **Effort:** 4h
- **Dependencies:** ECO-105
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/pipeline/pipeline-analytics.ts` -- PipelineAnalytics: execution time per node, bottleneck detection, cost attribution per node, success/failure rates
- **Acceptance Criteria:**
  - [ ] Aggregate metrics from PipelineRunResult history
  - [ ] Bottleneck detection (slowest/most expensive nodes)
  - [ ] Cost attribution per node type
  - [ ] Success/failure rate per node
  - [ ] Summary report generation
  - [ ] Tests pass
  - [ ] Zero TS errors

---

## Grand Total (All Phases, Docs 07-12)

| Phase | Tickets | Effort | Focus |
|-------|---------|--------|-------|
| Phase 4 (Weeks 7-8) | 32 | ~176h | Pipeline protocol + execution, eval framework, formats/standards, orchestration patterns |
| Phase 5 (Weeks 9-10) | 36 | ~196h | Sandbox runtime, resource management, security (policy, monitoring, audit, hardening), CLI/DX |
| Phase 6 (Future) | 18 | ~152h | WASM, K8s, playground, marketplace, benchmarks, cross-agent security, incident response |
| **Total Docs 07-12** | **86** | **~524h** | |

### Combined with Phase 1-3 Estimates (from 00-INDEX.md)

| Phase | Weeks | Effort |
|-------|-------|--------|
| Phase 1: Foundation Abstractions | 1-2 | ~38h |
| Phase 2: Observability & Communication | 3-4 | ~56h |
| Phase 3: Memory Sharing & Discovery | 5-6 | ~56h |
| Phase 4: Advanced Orchestration & Evaluation | 7-8 | ~176h |
| Phase 5: Runtime, DX & Security | 9-10 | ~196h |
| Phase 6: Future | Unscheduled | ~152h |
| **Grand Total (All Phases)** | | **~674h** |

### Ticket Numbering Guide

| Range | Phase | Source Documents |
|-------|-------|-----------------|
| ECO-001 -- ECO-099 | Phases 1-3 | Docs 01-06 (Identity, Communication, Discovery, Orchestration, Memory, Observability) |
| ECO-100 -- ECO-131 | Phase 4 | Docs 08, 09, 10, 04, 06 |
| ECO-132 -- ECO-167 | Phase 5 | Docs 07, 11, 12 |
| ECO-168 -- ECO-185 | Phase 6 | Docs 07, 08, 10, 11, 12 |

### Critical Path Dependencies

```
ECO-100 (Pipeline types) --> ECO-101, ECO-102, ECO-105, ECO-108, ECO-109, ECO-125
ECO-102 (Checkpoint interface) --> ECO-103, ECO-104
ECO-105 (Execution engine) --> ECO-106, ECO-107, ECO-108, ECO-130, ECO-163
ECO-111 (Scorer interface) --> ECO-112, ECO-113, ECO-114, ECO-115
ECO-140 (Policy types) --> ECO-141, ECO-142, ECO-143
ECO-141 (Policy evaluator) --> ECO-144, ECO-180, ECO-183
ECO-132 (Sandbox pool) --> ECO-133, ECO-162, ECO-167
ECO-135 (Quota interface) --> ECO-136, ECO-137, ECO-167
ECO-145 (Audit types) --> ECO-146, ECO-181
ECO-153 (Scaffold engine) --> ECO-154, ECO-155
ECO-174 (Playground core) --> ECO-175, ECO-176, ECO-177
```
