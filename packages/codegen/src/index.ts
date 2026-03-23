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
export { createGenerateFileTool } from './tools/generate-file.tool.js'
export { createRunTestsTool } from './tools/run-tests.tool.js'
export { createValidateTool } from './tools/validate.tool.js'

// Placeholder export to make the package valid
export const FORGEAGENT_CODEGEN_VERSION = '0.1.0'
