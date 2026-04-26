# @dzupagent/agent — API Tier Inventory

This document classifies every export from `packages/agent/src/index.ts` into one
of four review tiers. New entries to the root facade MUST be added to this file
in the same change that introduces the export. See
`docs/API_TIER_GOVERNANCE.md` at the repo root for the governance rules.

The tiers are:

- **stable** — Public, documented, semver-protected. Breaking changes require a
  major bump and a documented migration path.
- **advanced** — Public but power-user surface. Stable signature, but consumers
  should expect lower-level concerns (state shapes, internal events, registry
  hooks) to evolve in minor releases with release notes.
- **experimental** — Shipped behind the same root entry but not stability
  protected. Signatures and behaviour can change in any release. New code in
  this tier requires an issue/ADR before promotion to advanced/stable.
- **internal** — Exported only because consumers in the workspace currently
  import it; not part of the supported surface. Expect to be moved to a
  subpath or removed in a future major. Do not expand internal exports.

Every export MUST live in exactly one tier. When promoting an export from
`experimental` → `advanced` → `stable`, link the change with the relevant ADR
or release note.

## Compatibility window policy

- Demoting an export (e.g. `stable` → `advanced`) is a breaking change and is
  treated as a removal candidate: open a deprecation in the next minor and
  remove no sooner than the following major.
- Removing an export is gated on at least one minor release where the export
  is still emitted with a `@deprecated` JSDoc tag pointing to the replacement.

---

## Tier: stable

Curated DX entry points consumed by application code. Treated as the supported
public API.

| Export | Source | Notes |
|---|---|---|
| `DzupAgent` | `agent/dzip-agent.ts` | Top-level agent class. |
| `createAgentWithMemory` | `agent/agent-factory.ts` | Memory-aware constructor. |
| `DzupAgentConfig` | `agent/agent-types.ts` | Constructor options type. |
| `GenerateOptions`, `GenerateResult` | `agent/agent-types.ts` | Generate API contracts. |
| `AgentStreamEvent` | `agent/agent-types.ts` | Top-level streaming union. |
| `WorkflowBuilder`, `CompiledWorkflow`, `createWorkflow` | `workflow/workflow-builder.ts` | Stable workflow API. |
| `WorkflowConfig`, `WorkflowStep`, `WorkflowContext`, `WorkflowEvent`, `MergeStrategy` | `workflow/workflow-types.ts` | Workflow contracts. |
| `IterationBudget` | `guardrails/iteration-budget.ts` | Required by tool-loop integrators. |
| `GuardrailConfig`, `BudgetState`, `BudgetWarning` | `guardrails/guardrail-types.ts` | Guardrail contracts. |
| `createForgeTool` | `tools/create-tool.ts` | Public tool factory. |
| `ForgeToolConfig` | `tools/create-tool.ts` | Public tool factory config. |
| `ApprovalGate` | `approval/approval-gate.ts` | Public HITL gate. |
| `ApprovalConfig`, `ApprovalMode`, `ApprovalResult` | `approval/approval-types.ts` | HITL contracts. |
| `RunHandle`, `RunResult`, `LaunchOptions`, `Unsubscribe`, `CheckpointInfo` | `agent/run-handle-types.ts` | Public run handle contracts. |
| `dzupagent_AGENT_VERSION` | `index.ts` | Version constant. |

## Tier: advanced

Power-user/runtime-integrator surface. Stable in current minor but expected to
evolve with deliberate release notes.

| Group | Exports | Notes |
|---|---|---|
| Tool loop | `runToolLoop`, `ToolLoopConfig`, `ToolLoopResult`, `ToolStat`, `StopReason` | Internal loop driver — useful for custom runtimes. |
| Memory profiles | `getMemoryProfilePreset`, `resolveArrowMemoryConfig`, `MemoryProfile`, `MemoryProfilePreset`, `AgentMailboxConfig`, `ArrowMemoryConfig`, `CompressionLogEntry` | Memory tuning hooks. |
| Run handle (concrete) | `ConcreteRunHandle`, `InvalidRunStateError`, `CheckpointExpiredError`, `ForkLimitExceededError`, `RunNotFoundError` | Concrete impl + error taxonomy. |
| Parallel executor | `executeToolsParallel`, `ParallelToolCall`, `ToolExecutionResult`, `ToolLookup`, `ParallelExecutorOptions` | Tool fan-out primitives. |
| Tool arg validation | `validateAndRepairToolArgs`, `formatSchemaHint`, `ValidationResult`, `ToolArgValidatorConfig` | Custom tool runtimes. |
| Stuck/cascading guardrails | `StuckDetector`, `StuckDetectorConfig`, `StuckStatus`, `StuckError`, `EscalationLevel`, `StuckRecoveryAction`, `CascadingTimeout`, `CascadingTimeoutConfig` | Failure-mode detectors. |
| Orchestration core | `AgentOrchestrator`, `MergeFn`, `SupervisorConfig`, `SupervisorResult`, `OrchestrationError`, `OrchestrationPattern` | Built-in orchestrator surface. |
| Map/reduce + merge | `mapReduce`, `mapReduceMulti`, `MapReduceConfig`, `MapReduceResult`, `AgentOutput`, `concatMerge`, `voteMerge`, `numberedMerge`, `jsonArrayMerge`, `getMergeStrategy`, `MergeStrategyFn` | Built-in patterns. |
| Contract-net | `ContractNetManager`, `lowestCostStrategy`, `fastestStrategy`, `highestQualityStrategy`, `createWeightedStrategy`, `ContractNetPhase`, `CallForProposals`, `ContractBid`, `ContractAward`, `ContractResult`, `ContractNetState`, `BidEvaluationStrategy`, `ContractNetConfig` | Contract-net pattern. |
| Delegation | `DelegatingSupervisor`, `DelegatingSupervisorConfig`, `TaskAssignment`, `AggregatedDelegationResult`, `PlanAndDelegateOptions`, `SimpleDelegationTracker`, `DelegationRequest`, `DelegationResult`, `DelegationContext`, `DelegationMetadata`, `DelegationStatus`, `DelegationTracker`, `DelegationExecutor`, `ActiveDelegation`, `SimpleDelegationTrackerConfig` | Delegating supervisor + tracker. |
| Topology | `TopologyAnalyzer`, `TopologyExecutor`, `MeshResult`, `RingResult`, `ExecuteResult`, `TopologyType`, `TaskCharacteristics`, `TopologyRecommendation`, `TopologyMetrics`, `TopologyExecutorConfig` | Topology analyzer + executor. |
| Routing policies | `RuleBasedRouting`, `HashRouting`, `LLMRouting`, `RoundRobinRouting`, `AgentSpec`, `AgentTask`, `RoutingDecision`, `RoutingPolicy`, `RuleBasedRoutingConfig`, `HashRoutingConfig` | Pluggable routing. |
| Orchestration merge contracts | `AllRequiredMergeStrategy`, `UsePartialMergeStrategy`, `FirstWinsMergeStrategy`, `AgentResult`, `MergedResult`, `OrchestrationMergeStrategy`, `BuiltInMergeStrategyName` | Merge strategies. |
| Circuit breaker | `AgentCircuitBreaker`, `CircuitState`, `CircuitBreakerConfig` | Per-agent circuit breaker. |
| Provider port | `ProviderExecutionPort`, `ProviderExecutionResult` | Adapter integration port. |
| Context | `autoCompress`, `FrozenSnapshot`, `AutoCompressConfig`, `CompressResult`, `withTokenLifecycle`, `TokenLifecycleHooks`, `TokenLifecyclePhase`, `TokenPressureListener` | Context lifecycle. |
| Tool registry | `DynamicToolRegistry`, `ToolRegistryEvent` | Runtime registry. |
| Human contact | `createHumanContactTool`, `InMemoryPendingContactStore`, `HumanContactInput`, `HumanContactToolConfig`, `PendingContactStore` | HITL contact tooling. |
| Snapshots | `createSnapshot`, `verifySnapshot`, `compressSnapshot`, `decompressSnapshot`, `AgentStateSnapshot`, `CreateSnapshotParams`, `serializeMessage`, `migrateMessages`, `SerializedMessage`, `MultimodalContent` | Snapshot/replay support. |
| Structured output | `generateStructuredOutput`, `detectStrategy`, `StructuredOutputStrategy`, `StructuredOutputCapabilities`, `StructuredOutputConfig`, `StructuredOutputResult`, `StructuredLLM`, `StructuredLLMWithMeta` | JSON/structured generation. |
| Tool schema registry | `ToolSchemaRegistry`, `ToolSchemaEntry`, `CompatCheckResult` | Tool schema versioning. |
| Streaming primitives | `StreamActionParser`, `StreamedToolCall`, `StreamActionEvent`, `StreamActionParserConfig`, `StreamEvent`, `TextDeltaEvent`, `ToolCallStartEvent`, `ToolCallEndEvent`, `DoneEvent`, `ErrorEvent`, `TextDeltaBuffer`, `StreamingRunHandle`, `StreamingStatus`, `StreamingRunHandleOptions` | Streaming runtime. |
| Templates | `AGENT_TEMPLATES`, `ALL_AGENT_TEMPLATES`, `getAgentTemplate`, `listAgentTemplates`, `AgentTemplate`, `AgentTemplateCategory`, `composeTemplates`, `TemplateRegistry` | Agent templates. |
| Pipeline runtime | `validatePipeline`, `InMemoryPipelineCheckpointStore`, `PipelineRuntime`, `executeLoop`, `stateFieldTruthy`, `qualityBelow`, `hasErrors`, `PipelineState`, `NodeResult`, `PipelineRunResult`, `NodeExecutor`, `NodeExecutionContext`, `PipelineRuntimeConfig`, `PipelineRuntimeEvent`, `LoopMetrics`, `RetryPolicy`, `OTelSpanLike`, `PipelineTracer` | Generic pipeline runtime. |
| Step type registry | `StepTypeRegistry`, `defaultStepTypeRegistry`, `StepContext`, `StepTypeDescriptor` | Pipeline step plugins. |
| Pipeline retry | `DEFAULT_RETRY_POLICY`, `calculateBackoff`, `isRetryable`, `resolveRetryPolicy` | Retry policy helpers. |
| Pipeline templates | `createCodeReviewPipeline`, `createFeatureGenerationPipeline`, `createTestGenerationPipeline`, `createRefactoringPipeline`, `CodeReviewPipelineOptions`, `FeatureGenerationPipelineOptions`, `TestGenerationPipelineOptions`, `RefactoringPipelineOptions` | Pre-built pipeline templates. |
| Security | `AgentAuth`, `AgentCredential`, `SignedAgentMessage`, `AgentAuthConfig` | Per-message auth. |
| Pipeline analytics | `PipelineAnalytics`, `NodeMetrics`, `BottleneckEntry`, `PipelineAnalyticsReport`, `AnalyticsNodeResult`, `AnalyticsRunInput` | Pipeline analytics. |
| Recovery | `RecoveryCopilot`, `StrategyGenerator`, `FailureAnalyzer`, `FailureHistoryEntry`, `FailureAnalysis`, `StrategyRanker`, `RankingWeights`, `RecoveryExecutor`, `ActionHandler`, `RecoveryExecutorConfig`, `FailureType`, `FailureContext`, `RecoveryActionType`, `RecoveryAction`, `RiskLevel`, `RecoveryStrategy`, `RecoveryPlanStatus`, `RecoveryPlan`, `RecoveryCopilotConfig`, `RecoveryResult` | Recovery copilot. |
| Mailbox | `MailMessage`, `MailboxQuery`, `MailboxStore`, `AgentMailbox`, `InMemoryMailboxStore`, `AgentMailboxImpl`, `AgentMailboxOptions`, `createSendMailTool`, `createCheckMailTool`, `MailToolConfig`, `InMemoryDeadLetterStore`, `DeadLetter`, `DeadLetterMeta`, `DeadLetterStore`, `RateLimiter`, `MailRateLimitedError`, `DEFAULT_RATE_LIMIT`, `RateLimiterConfig` | Mailbox subsystem. |
| Token lifecycle plugin | `createTokenLifecyclePlugin`, `AgentLoopPlugin`, `TokenLifecyclePluginOptions`, `CompressionHintListener` | Token lifecycle plugin loader. |
| Cluster (workspaces) | `ClusterRole`, `AgentCluster`, `InMemoryAgentCluster`, `InMemoryAgentClusterConfig` | In-memory agent cluster. |
| Skill chain executor | `executeTextualWorkflow`, `streamTextualWorkflow`, `createSkillChainWorkflow`, `TextualWorkflowOptions`, `SharedAgentSkillResolver`, `SkillChainExecutor`, `SkillStepResolver`, `SharedAgentSkillResolverConfig`, `SkillChainExecutorConfig`, `ExecuteOptions`, `DryRunStepInfo`, `DryRunResult`, `ChainStepInput`, `ChainStepOutput`, `ChainFinalState`, `StateTransformer`, `CandidateInterpretation`, `SkillNotFoundError`, `ChainValidationError`, `StepExecutionError`, `WorkflowParseError` | Skill chain runtime. |

## Tier: experimental

Newer subsystems undergoing rapid iteration. Prefer importing from the
authoring module if you need stability today; expect breaking changes.

| Group | Exports | Notes |
|---|---|---|
| Planning agent | `PlanningAgent`, `buildExecutionLevels`, `validatePlanStructure`, `PlanNodeSchema`, `DecompositionSchema`, `PlanNode`, `ExecutionPlan`, `PlanExecutionResult`, `PlanningAgentConfig`, `DecompositionResult`, `DecomposeOptions` | Plan synthesis is still being shaped by the orchestration roadmap. |
| Playground | `AgentPlayground`, `PlaygroundConfig`, `SharedWorkspace`, `TeamCoordinator`, `AgentRole`, `AgentSpawnConfig`, `CoordinationPattern`, `TeamConfig`, `AgentStatus`, `SpawnedAgent`, `PlaygroundEvent`, `TeamRunResult` | The playground module is intentionally framework-internal; product UX must live in apps. |
| TeamRuntime | `TeamRuntime`, `DEFAULT_ROUTER_MODEL`, `DEFAULT_PARTICIPANT_MODEL`, `DEFAULT_GOVERNANCE_MODEL`, `TeamRuntimeEvent`, `TeamRuntimeEventEmitter`, `TeamRuntimeOptions`, `ParticipantResolver`, `TeamRuntimeTracer`, `TeamOTelSpanLike`, `TeamCoordinatorPattern`, `ParticipantDefinition`, `TeamDefinition`, `ExecutionPolicy`, `GovernancePolicy`, `MemoryPolicy`, `IsolationPolicy`, `MailboxPolicy`, `EvaluationPolicy`, `TeamPolicies`, `TeamPhase`, `TeamPhaseModel`, `TeamCheckpoint`, `ResumeContract`, `SupervisionPolicy`, `AgentBreakerState` | Declarative team execution engine; under active development. |
| Reflection | `RunReflector`, `ReflectionScore`, `ReflectionDimensions`, `ReflectionInput`, `ReflectorConfig`, `ReflectionAnalyzer`, `ReflectionAnalyzerConfig`, `InMemoryReflectionStore`, `ReflectionPattern`, `ReflectionSummary`, `RunReflectionStore`, `createReflectionLearningBridge`, `buildWorkflowEventsFromToolStats`, `ReflectionLearningBridgeConfig` | Reflection bridge contracts evolve with the learning roadmap. |
| Replay debugger | `TraceCapture`, `ReplayEngine`, `ReplayController`, `ReplayInspector`, `TraceSerializer`, `ReplayEvent`, `Breakpoint`, `ReplayStatus`, `ReplaySession`, `TraceCaptureConfig`, `CapturedTrace`, `StateDiffEntry`, `TimelineNode`, `TimelineData`, `SerializationFormat`, `SerializeOptions`, `ReplayEventCallback`, `BreakpointHitCallback`, `StatusChangeCallback`, `ReplayNodeMetrics`, `ReplaySummary` | Replay debugger surface. |
| Instructions (AGENTS.md) | `parseAgentsMd`, `mergeAgentsMd`, `discoverAgentsMdHierarchy`, `AgentsMdSection`, `mergeInstructions`, `MergedInstructions`, `loadAgentsFiles`, `LoadedAgentsFile`, `LoadAgentsOptions` | Format and discovery rules still in flux. |
| Self-correction (full subsystem) | `ReflectionLoop`, `parseCriticResponse`, `ReflectionConfig`, `ReflectionIteration`, `ReflectionResult`, `ScoreResult`, `AdaptiveIterationController`, `IterationDecision`, `IterationControllerConfig`, `createSelfCorrectingExecutor`, `SelfCorrectingConfig`, `SelfCorrectingResult`, `ErrorDetectionOrchestrator`, `ErrorSource`, `ErrorSeverity`, `DetectedError`, `ErrorDetectorConfig`, `RootCauseAnalyzer`, `RootCauseReport`, `RootCauseAnalyzerConfig`, `AnalyzeParams`, `HeuristicClassification`, `VerificationProtocol`, `jaccardSimilarity`, `VerificationStrategy`, `VerificationResult`, `VerificationConfig`, `SelfLearningRuntime`, `SelfLearningConfig`, `SelfLearningRunResult`, `SelfLearningPipelineHook`, `SelfLearningHookConfig`, `HookMetrics`, `PostRunAnalyzer`, `RunAnalysis`, `AnalysisResult`, `PostRunAnalyzerConfig`, `AnalysisHistoryEntry`, `AdaptivePromptEnricher`, `PromptEnrichment`, `EnricherConfig`, `EnrichParams`, `EnrichWithBudgetParams`, `PipelineStuckDetector`, `PipelineStuckConfig`, `PipelineStuckStatus`, `PipelineStuckSummary`, `PipelineSuggestedAction`, `TrajectoryCalibrator`, `StepReward`, `TrajectoryRecord`, `SuboptimalResult`, `TrajectoryCalibratorConfig`, `ObservabilityCorrectionBridge`, `CorrectionSignal`, `CorrectionSignalType`, `SignalSeverity`, `ObservabilityThresholds`, `ObservabilityBridgeConfig`, `StrategySelector`, `FixStrategy`, `StrategyRate`, `StrategyRecommendation`, `StrategySelectorConfig`, `RecoveryFeedback`, `RecoveryLesson`, `RecoveryFeedbackConfig`, `AgentPerformanceOptimizer`, `OptimizationDecision`, `PerformanceHistory`, `PerformanceOptimizerConfig`, `LangGraphLearningMiddleware`, `LangGraphLearningConfig`, `LearningRunMetrics`, `WrapNodeOptions`, `FeedbackCollector`, `FeedbackType`, `FeedbackOutcome`, `FeedbackRecord`, `FeedbackStats`, `FeedbackCollectorConfig`, `LearningDashboardService`, `LearningOverview`, `QualityTrend`, `CostTrend`, `NodePerformanceSummary`, `LearningDashboard`, `DashboardServiceConfig` | Self-correction is the largest experimental cluster — it is governed by the self-learning roadmap and changes frequently. |
| Presets | `AgentPreset`, `PresetRuntimeDeps`, `PresetConfig`, `buildConfigFromPreset`, `PresetRegistry`, `createDefaultPresetRegistry`, `RAGChatPreset`, `ResearchPreset`, `SummarizerPreset`, `QAPreset`, `BUILT_IN_PRESETS` | Built-in presets and preset shape are still being curated. |

## Tier: internal

Exports retained only because callers in the workspace currently depend on
them. Do not extend. Plan a subpath migration in a future major.

| Export | Source | Plan |
|---|---|---|
| `serializeMessages`, `deserializeMessages` | `agent/agent-state.ts` | Superseded by enhanced snapshot APIs; keep until consumers migrate. |
| `LegacyAgentStateSnapshot`, `LegacySerializedMessage` | `agent/agent-state.ts` | Legacy snapshot shape; replaced by `AgentStateSnapshot`. |

---

## Adding a new export

1. Add the export to `src/index.ts` as today.
2. Add an entry to the matching tier table above. If unclear, file the export
   as `experimental` and link an issue.
3. If the export crosses a stability boundary (e.g. promotes from experimental
   to advanced), include the rationale in the PR description.
4. Removals require a `@deprecated` JSDoc tag for at least one minor release
   before the export is deleted.
