# @dzupagent/codegen — API Tier Inventory

This document classifies every export from `packages/codegen/src/index.ts`
into one of four review tiers. New entries to the root facade MUST be added
to this file in the same change that introduces the export. See
`docs/API_TIER_GOVERNANCE.md` at the repo root for the governance rules.

The tiers are:

- **stable** — Public, documented, semver-protected. Breaking changes
  require a major bump and a documented migration path.
- **advanced** — Public power-user surface (sandbox, pipeline executor,
  guardrails, repo map). Stable signature, but internal data shapes may
  evolve in minor releases with release notes.
- **experimental** — Sandbox/runtime/correction surface that is shipped via
  the root entry but is iterating quickly. Signatures may change in any
  release.
- **internal** — Exported only because consumers currently import them; not
  part of the supported surface. Do not extend.

Compatibility window policy is identical to `@dzupagent/agent` — see
`packages/agent/docs/api-tiers.md` for the full statement. In short:
removals require one minor with a `@deprecated` tag, demotions are treated
as removal candidates.

---

## Tier: stable

| Export | Source | Notes |
|---|---|---|
| `VirtualFS` | `vfs/virtual-fs.ts` | Primary virtual filesystem. |
| `FileDiff` | `vfs/virtual-fs.ts` | Public diff record. |
| `CodeGenService` | `generation/code-gen-service.ts` | Public generation service. |
| `GenerateFileParams`, `GenerateFileResult` | `generation/code-gen-service.ts` | Generation contracts. |
| `parseCodeBlocks`, `extractLargestCodeBlock`, `detectLanguage`, `CodeBlock` | `generation/code-block-parser.ts` | Stable code-block helpers. |
| `GitExecutor` | `git/git-executor.ts` | Public git driver. |
| `createGitTools`, `createGitStatusTool`, `createGitDiffTool`, `createGitCommitTool`, `createGitLogTool`, `createGitBranchTool` | `git/git-tools.ts` | Stable git tool factories. |
| `GitFileStatus`, `GitFileEntry`, `GitStatusResult`, `GitDiffResult`, `GitLogEntry`, `GitCommitResult`, `GitExecutorConfig`, `CommitMessageConfig` | `git/git-types.ts` | Git contract types. |
| `dzupagent_CODEGEN_VERSION` | `index.ts` | Version constant. |

## Tier: advanced

Power-user APIs for tool authors and runtime integrators.

| Group | Exports | Notes |
|---|---|---|
| Snapshot/COW VFS | `saveSnapshot`, `loadSnapshot`, `SnapshotStore`, `SnapshotSaveResult`, `SnapshotLoadResult`, `CheckpointManager`, `CheckpointManagerConfig`, `CheckpointEntry`, `CheckpointDiff`, `CheckpointResult`, `CopyOnWriteVFS`, `MergeStrategy`, `MergeConflict`, `MergeResult`, `VFSDiff`, `SampleResult`, `sample`, `selectBest`, `commitBest`, `sampleAndCommitBest` | Advanced VFS tooling. |
| Patch engine | `parseUnifiedDiff`, `applyPatch`, `applyPatchSet`, `PatchParseError`, `PatchErrorCode`, `PatchHunk`, `PatchLine`, `FilePatch`, `HunkResult`, `PatchApplyResult`, `ApplyPatchSetOptions` | Patch parsing/application primitives. |
| Workspace runner/FS | `WorkspaceRunner`, `WorkspaceRunResult`, `WorkspaceRunOptions`, `InMemoryWorkspaceFS`, `DiskWorkspaceFS`, `GitWorktreeWorkspaceFS`, `WorkspaceFS`, `PatchOptions`, `WorkspacePatchResult` | Workspace runtime. |
| Run engine | `CodegenRunEngine`, `CodegenRunEngineConfig` | Public run orchestrator. |
| Incremental + tests | `splitIntoSections`, `detectAffectedSections`, `applyIncrementalChanges`, `buildIncrementalPrompt`, `CodeSection`, `IncrementalChange`, `IncrementalResult`, `determineTestStrategy`, `extractExports`, `generateTestSpecs`, `buildTestPath`, `TestStrategy`, `TestFramework`, `TestGenConfig`, `TestTarget`, `ExportInfo`, `TestSpec`, `TestCase` | Incremental gen + test gen. |
| Sandbox protocol | `SandboxProtocol`, `ExecOptions`, `ExecResult`, `SandboxProtocolV2`, `SessionOptions`, `ExecEvent`, `DockerSandbox`, `DockerSandboxConfig`, `MockSandbox`, `MockSandboxV2`, `createSandbox`, `SandboxProvider`, `SandboxFactoryConfig` | Stable sandbox protocol + factory. |
| Sandbox security | `TIER_DEFAULTS`, `MIN_MEMORY_MB`, `MIN_CPUS`, `MIN_TIMEOUT_MS`, `tierToDockerFlags`, `validateTierConfig`, `mergeTierConfig`, `tierToE2bConfig`, `compareTiers`, `mostRestrictiveTier`, `PermissionTier`, `TierConfig`, `TierValidationResult`, `SECURITY_PROFILES`, `getSecurityProfile`, `customizeProfile`, `toDockerFlags`, `SecurityLevel`, `SecurityProfile`, `NetworkPolicy`, `ResourceLimits`, `FilesystemPolicy`, `ProcessLimits` | Sandbox tiers + security profiles. |
| Sandbox pool/volumes/audit | `SandboxPool`, `PoolExhaustedError`, `PooledSandbox`, `SandboxPoolConfig`, `SandboxPoolMetrics`, `DockerResetStrategy`, `CloudResetStrategy`, `SandboxResetStrategy`, `DockerResetConfig`, `InMemoryVolumeManager`, `VolumeType`, `VolumeDescriptor`, `VolumeInfo`, `CleanupPolicy`, `VolumeManager`, `InMemoryAuditStore`, `AuditedSandbox`, `redactSecrets`, `AuditAction`, `SandboxAuditEntry`, `SandboxAuditStore`, `AuditedSandboxConfig` | Pool, volume, and audit subsystems. |
| Sandbox hardening | `toDockerSecurityFlags`, `detectEscapeAttempt`, `SeccompProfile`, `FilesystemACL`, `EgressRule`, `HardenedSandboxConfig`, `HardenedExecResult` | Hardening primitives. |
| Validation/quality | `validateImports`, `ImportValidationResult`, `ImportError`, `QualityDimension`, `DimensionResult`, `QualityResult`, `QualityContext`, `QualityScorer`, `ConventionGate`, `ConventionGateViolation`, `ConventionCategory`, `LearnedConvention`, `ConventionGateConfig`, `ConventionGateResult`, `typeStrictness`, `eslintClean`, `hasTests`, `codeCompleteness`, `hasJsDoc`, `builtinDimensions`, `analyzeCoverage`, `findUncoveredFiles`, `CoverageReport`, `CoverageConfig`, `validateImportCoherence`, `ImportIssue`, `ImportCoherenceResult`, `extractEndpoints`, `extractAPICalls`, `validateContracts`, `APIEndpoint`, `APICall`, `ContractIssue`, `ContractValidationResult` | Validation + quality scoring stack. |
| Adaptation/contract/context | `PathMapper`, `FrameworkAdapter`, `SupportedLanguage`, `LanguageConfig`, `LANGUAGE_CONFIGS`, `detectLanguageFromFiles`, `getLanguagePrompt`, `ApiEndpoint`, `ApiContract`, `ApiExtractor`, `FileRoleDetector`, `PhasePriorityMatrix`, `FileEntry`, `TokenBudgetOptions`, `TokenBudgetManager`, `DefaultRoleDetector`, `DefaultPriorityMatrix`, `summarizeFile`, `extractInterfaceSummary` | Framework adaptation + token budgeting. |
| Pipeline | `GenPipelineBuilder`, `PipelinePhase`, `DEFAULT_ESCALATION`, `getEscalationStrategy`, `EscalationConfig`, `EscalationStrategy`, `BaseGenState`, `GenPhaseConfig`, `SubAgentPhaseConfig`, `ValidationPhaseConfig`, `FixPhaseConfig`, `ReviewPhaseConfig`, `PipelineExecutor`, `runGuardrailGate`, `summarizeGateResult`, `GuardrailGateConfig`, `GuardrailGateResult`, `ExecutorConfig`, `ExecutorPhaseConfig`, `PhaseResult`, `PipelineExecutionResult`, `runBudgetGate`, `BudgetGateConfig`, `BudgetGateResult`, `hasKey`, `previousSucceeded`, `stateEquals`, `hasFilesMatching`, `allOf`, `anyOf` | Pipeline builder + executor + gates. |
| Tools | `CodegenToolContext`, `createWriteFileTool`, `createEditFileTool`, `createMultiEditTool`, `createGenerateFileTool`, `createRunTestsTool`, `createValidateTool`, `quickSyntaxCheck`, `sandboxLintCheck`, `LintError`, `LintResult` | Codegen tool factories. |
| Git middleware/worktree | `generateCommitMessage`, `gatherGitContext`, `formatGitContext`, `GitContextConfig`, `GitContext`, `GitWorktreeManager`, `WorktreeInfo`, `WorktreeManagerConfig` | Git middleware + worktree manager. |
| Repo map | `extractSymbols`, `ExtractedSymbol`, `extractSymbolsAST`, `isTreeSitterAvailable`, `detectTreeSitterLanguage`, `EXTENSION_MAP`, `ASTSymbol`, `TreeSitterLanguage`, `buildImportGraph`, `ImportEdge`, `ImportGraph`, `buildRepoMap`, `RepoMapConfig`, `RepoMap` | Repo map subsystem. |
| Chunking + search | `chunkByAST`, `CodeChunk`, `ASTChunkerConfig`, `CodeSearchService`, `CodeSearchOptions`, `CodeSearchResult`, `CodeSearchServiceConfig`, `IndexResult`, `IndexStats`, `ChunkMetadata` | Chunking + code search. |
| Guardrails | `GuardrailEngine`, `GuardrailEngineConfig`, `ConventionLearner`, `ConventionLearnerConfig`, `GuardrailReporter`, `ReportFormat`, `ReporterConfig`, `createBuiltinRules`, `createLayeringRule`, `createImportRestrictionRule`, `createNamingConventionRule`, `createSecurityRule`, `createTypeSafetyRule`, `createContractComplianceRule`, `ImportRestrictionConfig`, `GuardrailCategory`, `GuardrailSeverity`, `GeneratedFile`, `ProjectStructure`, `PackageInfo`, `ConventionSet`, `FileNamingPattern`, `ExportNamingPattern`, `ImportStylePattern`, `RequiredPattern`, `GuardrailContext`, `GuardrailViolation`, `GuardrailResult`, `GuardrailRule`, `GuardrailReport` | Guardrail engine + rules. |
| Streaming | `CodegenStreamEvent`, `mergeCodegenStreams` | Codegen streaming events. |
| Workspace | `SearchResult`, `CommandResult`, `WorkspaceOptions`, `Workspace`, `LocalWorkspace`, `SandboxedWorkspace`, `WorkspaceFactory` | Local + sandboxed workspace adapters. |
| Conventions | `detectConventions`, `DetectedConvention`, `ConventionReport`, `enforceConventions`, `conventionsToPrompt`, `ConventionViolation`, `EnforcementResult` | Convention detection + enforcement. |

## Tier: experimental

| Group | Exports | Notes |
|---|---|---|
| Cloud sandboxes | `E2BSandbox`, `E2BSandboxConfig`, `FlySandbox`, `FlySandboxConfig` | E2B/Fly providers iterate independently. |
| WASM sandbox | `WasiFilesystem`, `WasiFileEntry`, `WasiStatResult`, `CapabilityGuard`, `CapabilityDeniedError`, `WasiCapability`, `WasmSandbox`, `WasmSandboxConfig`, `WasmExecResult`, `SandboxResourceLimits`, `SandboxResourceError`, `SandboxTimeoutError`, `SandboxAccessDeniedError`, `WasmTypeScriptTranspiler`, `TranspileResult` | WASM sandbox is preview. |
| Kubernetes sandbox | `K8sClient`, `K8sPodSandbox`, `createAgentSandboxResource`, `AgentSandboxPhase`, `K8sSecurityLevel`, `AgentSandboxResourceRequests`, `AgentSandboxResourceLimits`, `AgentSandboxResources`, `AgentSandboxVolume`, `AgentSandboxNetwork`, `AgentSandboxEnvVar`, `AgentSandboxSpec`, `AgentSandboxStatus`, `AgentSandboxMetadata`, `AgentSandboxResource`, `K8sClientConfig`, `K8sSandboxConfig` | Kubernetes adapter is preview. |
| Preview tooling | `createPreviewAppTool`, `PreviewAppResult` | Preview app tool surface. |
| PR lifecycle / CI / review | `getNextAction`, `buildPRDescription`, `transitionState`, `PRState`, `PRContext`, `PRManagerConfig`, `PRAction`, `PREvent`, `ReviewComment`, `consolidateReviews`, `buildReviewFixPrompt`, `classifyCommentSeverity`, `ReviewFeedback`, `ReviewIssue`, `categorizeFailure`, `parseGitHubActionsStatus`, `parseCIWebhook`, `CIProvider`, `CIStatus`, `CIFailure`, `CIMonitorConfig`, `routeFailure`, `DEFAULT_FIX_STRATEGIES`, `FixStrategy`, `generateFixAttempts`, `buildFixPrompt`, `FixLoopConfig`, `FixAttempt`, `FixLoopResult`, `ReviewSeverity`, `ReviewCategory`, `ReviewRule`, `BUILTIN_RULES`, `CodeReviewComment`, `ReviewSummary`, `ReviewResult`, `CodeReviewConfig`, `reviewFiles`, `reviewDiff`, `formatReviewAsMarkdown` | PR + CI + review subsystems are still being aligned. |
| Self-correction loop | `SelfCorrectionLoop`, `CorrectionEventListeners`, `SelfCorrectionDeps`, `ReflectionNode`, `ReflectionSchema`, `ReflectionNodeConfig`, `ReflectionResult`, `LessonExtractor`, `LessonExtractorConfig`, `LessonExtractionResult`, `ErrorCategory`, `EvaluationResult`, `Reflection`, `CorrectionIteration`, `CorrectionResult`, `CorrectionContext`, `Lesson`, `SelfCorrectionConfig`, `CodeEvaluator`, `CodeFixer`, `CorrectionIterationEvent`, `CorrectionFixedEvent`, `CorrectionExhaustedEvent`, `DEFAULT_CORRECTION_CONFIG` | Self-correction module aligns with `@dzupagent/agent` self-correction. |
| Migration planner | `getMigrationPlan`, `analyzeMigrationScope`, `buildMigrationPrompt`, `MigrationTarget`, `MigrationStep`, `MigrationPlan` | Migration assistant is preview. |

## Tier: internal

No internal exports currently. The codegen facade has not yet accumulated
deprecated re-exports; new internals should not be added at the root.

---

## Adding a new export

Follow the same workflow documented in
`packages/agent/docs/api-tiers.md`:

1. Add the export to `src/index.ts`.
2. Add it to a tier table here.
3. Default new exports to `experimental` if their stability is not yet
   proven.
4. Promote between tiers via documented PR notes; demotions and removals
   require a `@deprecated` JSDoc and one minor of compatibility.
