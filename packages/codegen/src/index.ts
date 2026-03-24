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

// --- Sandbox ---
export type { SandboxProtocol, ExecOptions, ExecResult } from './sandbox/sandbox-protocol.js'
export { DockerSandbox } from './sandbox/docker-sandbox.js'
export type { DockerSandboxConfig } from './sandbox/docker-sandbox.js'
export { MockSandbox } from './sandbox/mock-sandbox.js'
export { TIER_DEFAULTS, tierToDockerFlags } from './sandbox/permission-tiers.js'
export type { PermissionTier, TierConfig } from './sandbox/permission-tiers.js'

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

// --- Adaptation ---
export { PathMapper } from './adaptation/path-mapper.js'
export { FrameworkAdapter } from './adaptation/framework-adapter.js'

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
  PhaseConfig,
  SubAgentPhaseConfig,
  ValidationPhaseConfig,
  FixPhaseConfig,
  ReviewPhaseConfig,
} from './pipeline/phase-types.js'

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

// Placeholder export to make the package valid
export const FORGEAGENT_CODEGEN_VERSION = '0.1.0'
