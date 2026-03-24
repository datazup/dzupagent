/**
 * @forgeagent/codegen — Code generation engine
 *
 * Built on @forgeagent/core. Provides: virtual filesystem,
 * code generation nodes, sandbox execution, quality scoring,
 * framework adaptation, pipeline builder, generic tools,
 * and API contract extraction.
 */

// --- VFS ---
export { VirtualFS } from './vfs/virtual-fs.js'
export type { FileDiff } from './vfs/virtual-fs.js'
export { saveSnapshot, loadSnapshot } from './vfs/vfs-snapshot.js'
export type { SnapshotStore } from './vfs/vfs-snapshot.js'
export { CheckpointManager } from './vfs/checkpoint-manager.js'
export type { CheckpointManagerConfig, CheckpointEntry, CheckpointDiff } from './vfs/checkpoint-manager.js'

// --- Generation ---
export { CodeGenService } from './generation/code-gen-service.js'
export type { GenerateFileParams, GenerateFileResult } from './generation/code-gen-service.js'
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
export { DockerSandbox } from './sandbox/docker-sandbox.js'
export type { DockerSandboxConfig } from './sandbox/docker-sandbox.js'
export { MockSandbox } from './sandbox/mock-sandbox.js'
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

// --- Validation ---
export { validateImports } from './validation/import-validator.js'
export type { ImportValidationResult, ImportError } from './validation/import-validator.js'

// --- Quality ---
export type { QualityDimension, DimensionResult, QualityResult, QualityContext } from './quality/quality-types.js'
export { QualityScorer } from './quality/quality-scorer.js'
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
export type {
  ExecutorConfig,
  PhaseConfig as ExecutorPhaseConfig,
  PhaseResult,
  PipelineExecutionResult,
} from './pipeline/pipeline-executor.js'
export {
  hasKey,
  previousSucceeded,
  stateEquals,
  hasFilesMatching,
  allOf,
  anyOf,
} from './pipeline/phase-conditions.js'

// --- Tools ---
export { createWriteFileTool } from './tools/write-file.tool.js'
export { createEditFileTool } from './tools/edit-file.tool.js'
export { createMultiEditTool } from './tools/multi-edit.tool.js'
export { createGenerateFileTool } from './tools/generate-file.tool.js'
export { createRunTestsTool } from './tools/run-tests.tool.js'
export { createValidateTool } from './tools/validate.tool.js'
export { quickSyntaxCheck, sandboxLintCheck } from './tools/lint-validator.js'
export type { LintError, LintResult } from './tools/lint-validator.js'

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
export { buildImportGraph } from './repomap/import-graph.js'
export type { ImportEdge, ImportGraph } from './repomap/import-graph.js'
export { buildRepoMap } from './repomap/repo-map-builder.js'
export type { RepoMapConfig, RepoMap } from './repomap/repo-map-builder.js'

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

// --- Migration ---
export { getMigrationPlan, analyzeMigrationScope, buildMigrationPrompt } from './migration/migration-planner.js'
export type { MigrationTarget, MigrationStep, MigrationPlan } from './migration/migration-planner.js'

// Placeholder export to make the package valid
export const FORGEAGENT_CODEGEN_VERSION = '0.1.0'
