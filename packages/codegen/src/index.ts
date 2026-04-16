/**
 * @dzupagent/codegen — Code generation engine
 *
 * Built on @dzupagent/core. Provides: virtual filesystem,
 * code generation nodes, sandbox execution, quality scoring,
 * framework adaptation, pipeline builder, generic tools,
 * and API contract extraction.
 */

// --- VFS ---
export { VirtualFS } from './vfs/virtual-fs.js'
export type { FileDiff } from './vfs/virtual-fs.js'
export { saveSnapshot, loadSnapshot } from './vfs/vfs-snapshot.js'
export type { SnapshotStore, SnapshotSaveResult, SnapshotLoadResult } from './vfs/vfs-snapshot.js'
export { CheckpointManager } from './vfs/checkpoint-manager.js'
export type { CheckpointManagerConfig, CheckpointEntry, CheckpointDiff, CheckpointResult } from './vfs/checkpoint-manager.js'
export { CopyOnWriteVFS } from './vfs/cow-vfs.js'
export type { MergeStrategy, MergeConflict, MergeResult, VFSDiff, SampleResult } from './vfs/vfs-types.js'
export { sample, selectBest, commitBest, sampleAndCommitBest } from './vfs/parallel-sampling.js'
export { parseUnifiedDiff, applyPatch, applyPatchSet, PatchParseError } from './vfs/patch-engine.js'
export type {
  PatchErrorCode,
  PatchHunk,
  PatchLine,
  FilePatch,
  HunkResult,
  PatchApplyResult,
  ApplyPatchSetOptions,
} from './vfs/patch-engine.js'

export { WorkspaceRunner } from './vfs/workspace-runner.js'
export type { WorkspaceRunResult, WorkspaceRunOptions } from './vfs/workspace-runner.js'

export { InMemoryWorkspaceFS, DiskWorkspaceFS, GitWorktreeWorkspaceFS } from './vfs/workspace-fs.js'
export type { WorkspaceFS, PatchOptions, WorkspacePatchResult } from './vfs/workspace-fs.js'

// --- Generation ---
export { CodeGenService } from './generation/code-gen-service.js'
export type { GenerateFileParams, GenerateFileResult } from './generation/code-gen-service.js'
export { CodegenRunEngine } from './generation/codegen-run-engine.js'
export type { CodegenRunEngineConfig } from './generation/codegen-run-engine.js'
export { parseCodeBlocks, extractLargestCodeBlock, detectLanguage } from './generation/code-block-parser.js'
export type { CodeBlock } from './generation/code-block-parser.js'
export {
  splitIntoSections,
  detectAffectedSections,
  applyIncrementalChanges,
  buildIncrementalPrompt,
} from './generation/incremental-gen.js'
export type { CodeSection, IncrementalChange, IncrementalResult } from './generation/incremental-gen.js'
export {
  determineTestStrategy,
  extractExports,
  generateTestSpecs,
  buildTestPath,
} from './generation/test-generator.js'
export type {
  TestStrategy,
  TestFramework,
  TestGenConfig,
  TestTarget,
  ExportInfo,
  TestSpec,
  TestCase,
} from './generation/test-generator.js'

// --- Sandbox ---
export type { SandboxProtocol, ExecOptions, ExecResult } from './sandbox/sandbox-protocol.js'
export type { SandboxProtocolV2, SessionOptions, ExecEvent } from './sandbox/sandbox-protocol-v2.js'
export { DockerSandbox } from './sandbox/docker-sandbox.js'
export type { DockerSandboxConfig } from './sandbox/docker-sandbox.js'
export { MockSandbox } from './sandbox/mock-sandbox.js'
export { MockSandboxV2 } from './sandbox/mock-sandbox-v2.js'
export { E2BSandbox } from './sandbox/e2b-sandbox.js'
export type { E2BSandboxConfig } from './sandbox/e2b-sandbox.js'
export { FlySandbox } from './sandbox/fly-sandbox.js'
export type { FlySandboxConfig } from './sandbox/fly-sandbox.js'
export { createSandbox } from './sandbox/sandbox-factory.js'
export type { SandboxProvider, SandboxFactoryConfig } from './sandbox/sandbox-factory.js'
export { TIER_DEFAULTS, tierToDockerFlags } from './sandbox/permission-tiers.js'
export type { PermissionTier, TierConfig } from './sandbox/permission-tiers.js'
export { SECURITY_PROFILES, getSecurityProfile, customizeProfile, toDockerFlags } from './sandbox/security-profile.js'
export type {
  SecurityLevel,
  SecurityProfile,
  NetworkPolicy,
  ResourceLimits,
  FilesystemPolicy,
  ProcessLimits,
} from './sandbox/security-profile.js'

// --- Sandbox Pool ---
export { SandboxPool, PoolExhaustedError } from './sandbox/pool/index.js'
export type { PooledSandbox, SandboxPoolConfig, SandboxPoolMetrics } from './sandbox/pool/index.js'
export { DockerResetStrategy, CloudResetStrategy } from './sandbox/pool/index.js'
export type { SandboxResetStrategy, DockerResetConfig } from './sandbox/pool/index.js'

// --- Sandbox Volumes ---
export { InMemoryVolumeManager } from './sandbox/volumes/index.js'
export type {
  VolumeType,
  VolumeDescriptor,
  VolumeInfo,
  CleanupPolicy,
  VolumeManager,
} from './sandbox/volumes/index.js'

// --- Sandbox Audit ---
export { InMemoryAuditStore, AuditedSandbox, redactSecrets } from './sandbox/audit/index.js'
export type {
  AuditAction,
  SandboxAuditEntry,
  SandboxAuditStore,
  AuditedSandboxConfig,
} from './sandbox/audit/index.js'

// --- Sandbox Hardening ---
export { toDockerSecurityFlags, detectEscapeAttempt } from './sandbox/sandbox-hardening.js'
export type {
  SeccompProfile,
  FilesystemACL,
  EgressRule,
  HardenedSandboxConfig,
  HardenedExecResult,
} from './sandbox/sandbox-hardening.js'

// --- WASM Sandbox ---
export { WasiFilesystem } from './sandbox/wasm/index.js'
export type { WasiFileEntry, WasiStatResult } from './sandbox/wasm/index.js'
export { CapabilityGuard, CapabilityDeniedError } from './sandbox/wasm/index.js'
export type { WasiCapability } from './sandbox/wasm/index.js'
export { WasmSandbox } from './sandbox/wasm/index.js'
export type { WasmSandboxConfig, WasmExecResult, SandboxResourceLimits } from './sandbox/wasm/index.js'
export {
  SandboxResourceError,
  SandboxTimeoutError,
  SandboxAccessDeniedError,
} from './sandbox/wasm/index.js'
export { WasmTypeScriptTranspiler } from './sandbox/wasm/index.js'
export type { TranspileResult } from './sandbox/wasm/index.js'

// --- Sandbox K8s ---
export {
  K8sClient,
  K8sPodSandbox,
  createAgentSandboxResource,
} from './sandbox/k8s/index.js'
export type {
  AgentSandboxPhase,
  K8sSecurityLevel,
  AgentSandboxResourceRequests,
  AgentSandboxResourceLimits,
  AgentSandboxResources,
  AgentSandboxVolume,
  AgentSandboxNetwork,
  AgentSandboxEnvVar,
  AgentSandboxSpec,
  AgentSandboxStatus,
  AgentSandboxMetadata,
  AgentSandboxResource,
  K8sClientConfig,
  K8sSandboxConfig,
} from './sandbox/k8s/index.js'

// --- Validation ---
export { validateImports } from './validation/import-validator.js'
export type { ImportValidationResult, ImportError } from './validation/import-validator.js'

// --- Quality ---
export type { QualityDimension, DimensionResult, QualityResult, QualityContext } from './quality/quality-types.js'
export { QualityScorer } from './quality/quality-scorer.js'
export { ConventionGate } from './quality/convention-gate.js'
export type {
  ConventionViolation as ConventionGateViolation,
  ConventionCategory,
  LearnedConvention,
  ConventionGateConfig,
  ConventionGateResult,
} from './quality/convention-gate.js'
export {
  typeStrictness,
  eslintClean,
  hasTests,
  codeCompleteness,
  hasJsDoc,
  builtinDimensions,
} from './quality/quality-dimensions.js'
export { analyzeCoverage, findUncoveredFiles } from './quality/coverage-analyzer.js'
export type { CoverageReport, CoverageConfig } from './quality/coverage-analyzer.js'
export { validateImports as validateImportCoherence } from './quality/import-validator.js'
export type {
  ImportIssue,
  ImportValidationResult as ImportCoherenceResult,
} from './quality/import-validator.js'
export {
  extractEndpoints,
  extractAPICalls,
  validateContracts,
} from './quality/contract-validator.js'
export type {
  APIEndpoint,
  APICall,
  ContractIssue,
  ContractValidationResult,
} from './quality/contract-validator.js'

// --- Adaptation ---
export { PathMapper } from './adaptation/path-mapper.js'
export { FrameworkAdapter } from './adaptation/framework-adapter.js'
export type { SupportedLanguage, LanguageConfig } from './adaptation/languages/index.js'
export { LANGUAGE_CONFIGS, detectLanguageFromFiles, getLanguagePrompt } from './adaptation/languages/index.js'

// --- Contract ---
export type { ApiEndpoint, ApiContract } from './contract/contract-types.js'
export { ApiExtractor } from './contract/api-extractor.js'

// --- Context ---
export type { FileRoleDetector, PhasePriorityMatrix, FileEntry, TokenBudgetOptions } from './context/token-budget.js'
export {
  TokenBudgetManager,
  DefaultRoleDetector,
  DefaultPriorityMatrix,
  summarizeFile,
  extractInterfaceSummary,
} from './context/token-budget.js'

// --- Pipeline ---
export { GenPipelineBuilder } from './pipeline/gen-pipeline-builder.js'
export type { PipelinePhase } from './pipeline/gen-pipeline-builder.js'
export { DEFAULT_ESCALATION, getEscalationStrategy } from './pipeline/fix-escalation.js'
export type { EscalationConfig, EscalationStrategy } from './pipeline/fix-escalation.js'
export type {
  BaseGenState,
  PhaseConfig as GenPhaseConfig,
  SubAgentPhaseConfig,
  ValidationPhaseConfig,
  FixPhaseConfig,
  ReviewPhaseConfig,
} from './pipeline/phase-types.js'
export { PipelineExecutor } from './pipeline/pipeline-executor.js'
export { runGuardrailGate, summarizeGateResult } from './pipeline/guardrail-gate.js'
export type { GuardrailGateConfig, GuardrailGateResult } from './pipeline/guardrail-gate.js'
export type {
  ExecutorConfig,
  PhaseConfig as ExecutorPhaseConfig,
  PhaseResult,
  PipelineExecutionResult,
} from './pipeline/pipeline-executor.js'
export { runBudgetGate } from './pipeline/budget-gate.js'
export type { BudgetGateConfig, BudgetGateResult } from './pipeline/budget-gate.js'
export {
  hasKey,
  previousSucceeded,
  stateEquals,
  hasFilesMatching,
  allOf,
  anyOf,
} from './pipeline/phase-conditions.js'

// --- Tools ---
export type { CodegenToolContext } from './tools/tool-context.js'
export { createWriteFileTool } from './tools/write-file.tool.js'
export { createEditFileTool } from './tools/edit-file.tool.js'
export { createMultiEditTool } from './tools/multi-edit.tool.js'
export { createGenerateFileTool } from './tools/generate-file.tool.js'
export { createRunTestsTool } from './tools/run-tests.tool.js'
export { createValidateTool } from './tools/validate.tool.js'
export { quickSyntaxCheck, sandboxLintCheck } from './tools/lint-validator.js'
export type { LintError, LintResult } from './tools/lint-validator.js'
export { createPreviewAppTool } from './tools/preview-app.tool.js'
export type { PreviewAppResult } from './tools/preview-app.tool.js'

// --- Git ---
export { GitExecutor } from './git/git-executor.js'
export {
  createGitTools,
  createGitStatusTool,
  createGitDiffTool,
  createGitCommitTool,
  createGitLogTool,
  createGitBranchTool,
} from './git/git-tools.js'
export { generateCommitMessage } from './git/commit-message.js'
export { gatherGitContext, formatGitContext } from './git/git-middleware.js'
export type { GitContextConfig, GitContext } from './git/git-middleware.js'
export { GitWorktreeManager } from './git/git-worktree.js'
export type { WorktreeInfo, WorktreeManagerConfig } from './git/git-worktree.js'
export type {
  GitFileStatus,
  GitFileEntry,
  GitStatusResult,
  GitDiffResult,
  GitLogEntry,
  GitCommitResult,
  GitExecutorConfig,
  CommitMessageConfig,
} from './git/git-types.js'

// --- Repo Map ---
export { extractSymbols } from './repomap/symbol-extractor.js'
export type { ExtractedSymbol } from './repomap/symbol-extractor.js'
export { extractSymbolsAST, isTreeSitterAvailable, detectLanguage as detectTreeSitterLanguage, EXTENSION_MAP } from './repomap/tree-sitter-extractor.js'
export type { ASTSymbol, SupportedLanguage as TreeSitterLanguage } from './repomap/tree-sitter-extractor.js'
export { buildImportGraph } from './repomap/import-graph.js'
export type { ImportEdge, ImportGraph } from './repomap/import-graph.js'
export { buildRepoMap } from './repomap/repo-map-builder.js'
export type { RepoMapConfig, RepoMap } from './repomap/repo-map-builder.js'

// --- Chunking ---
export { chunkByAST } from './chunking/ast-chunker.js'
export type { CodeChunk, ASTChunkerConfig } from './chunking/ast-chunker.js'

// --- Code Search ---
export { CodeSearchService } from './search/code-search-service.js'
export type {
  CodeSearchOptions,
  CodeSearchResult,
  CodeSearchServiceConfig,
  IndexResult,
  IndexStats,
  ChunkMetadata,
} from './search/code-search-types.js'

// --- PR Lifecycle ---
export { getNextAction, buildPRDescription, transitionState } from './pr/pr-manager.js'
export type { PRState, PRContext, PRManagerConfig, PRAction, PREvent, ReviewComment } from './pr/pr-manager.js'
export { consolidateReviews, buildReviewFixPrompt, classifyCommentSeverity } from './pr/review-handler.js'
export type { ReviewFeedback, ReviewIssue } from './pr/review-handler.js'

// --- CI ---
export { categorizeFailure, parseGitHubActionsStatus, parseCIWebhook } from './ci/ci-monitor.js'
export type { CIProvider, CIStatus, CIFailure, CIMonitorConfig } from './ci/ci-monitor.js'
export { routeFailure, DEFAULT_FIX_STRATEGIES } from './ci/failure-router.js'
export type { FixStrategy } from './ci/failure-router.js'
export { generateFixAttempts, buildFixPrompt } from './ci/fix-loop.js'
export type { FixLoopConfig, FixAttempt, FixLoopResult } from './ci/fix-loop.js'

// --- Code Review ---
export type { ReviewSeverity, ReviewCategory, ReviewRule } from './review/review-rules.js'
export { BUILTIN_RULES } from './review/review-rules.js'
export type { ReviewComment as CodeReviewComment, ReviewSummary, ReviewResult, CodeReviewConfig } from './review/code-reviewer.js'
export { reviewFiles, reviewDiff, formatReviewAsMarkdown } from './review/code-reviewer.js'

// --- Conventions ---
export { detectConventions } from './conventions/convention-detector.js'
export type { DetectedConvention, ConventionReport } from './conventions/convention-detector.js'
export { enforceConventions, conventionsToPrompt } from './conventions/convention-enforcer.js'
export type { ConventionViolation, EnforcementResult } from './conventions/convention-enforcer.js'

// --- Correction (self-correction loop) ---
export { SelfCorrectionLoop } from './correction/index.js'
export type { CorrectionEventListeners, SelfCorrectionDeps } from './correction/index.js'
export { ReflectionNode, ReflectionSchema } from './correction/index.js'
export type { ReflectionNodeConfig, ReflectionResult } from './correction/index.js'
export { LessonExtractor } from './correction/index.js'
export type { LessonExtractorConfig, LessonExtractionResult } from './correction/index.js'
export type {
  ErrorCategory,
  EvaluationResult,
  Reflection,
  CorrectionIteration,
  CorrectionResult,
  CorrectionContext,
  Lesson,
  SelfCorrectionConfig,
  CodeEvaluator,
  CodeFixer,
  CorrectionIterationEvent,
  CorrectionFixedEvent,
  CorrectionExhaustedEvent,
} from './correction/index.js'
export { DEFAULT_CORRECTION_CONFIG } from './correction/index.js'

// --- Migration ---
export { getMigrationPlan, analyzeMigrationScope, buildMigrationPrompt } from './migration/migration-planner.js'
export type { MigrationTarget, MigrationStep, MigrationPlan } from './migration/migration-planner.js'

// --- Guardrails ---
export { GuardrailEngine } from './guardrails/guardrail-engine.js'
export type { GuardrailEngineConfig } from './guardrails/guardrail-engine.js'
export { ConventionLearner } from './guardrails/convention-learner.js'
export type { ConventionLearnerConfig } from './guardrails/convention-learner.js'
export { GuardrailReporter } from './guardrails/guardrail-reporter.js'
export type { ReportFormat, ReporterConfig } from './guardrails/guardrail-reporter.js'
export {
  createBuiltinRules,
  createLayeringRule,
  createImportRestrictionRule,
  createNamingConventionRule,
  createSecurityRule,
  createTypeSafetyRule,
  createContractComplianceRule,
} from './guardrails/rules/index.js'
export type { ImportRestrictionConfig } from './guardrails/rules/index.js'
export type {
  GuardrailCategory,
  GuardrailSeverity,
  GeneratedFile,
  ProjectStructure,
  PackageInfo,
  ConventionSet,
  FileNamingPattern,
  ExportNamingPattern,
  ImportStylePattern,
  RequiredPattern,
  GuardrailContext,
  GuardrailViolation,
  GuardrailResult,
  GuardrailRule,
  GuardrailReport,
} from './guardrails/guardrail-types.js'

// --- Streaming ---
export type { CodegenStreamEvent } from './streaming/index.js'
export { mergeCodegenStreams } from './streaming/index.js'

// --- Workspace ---
export type { SearchResult, CommandResult, WorkspaceOptions, Workspace } from './workspace/index.js'
export { LocalWorkspace, SandboxedWorkspace, WorkspaceFactory } from './workspace/index.js'

// Placeholder export to make the package valid
export const dzupagent_CODEGEN_VERSION = '0.1.0'
