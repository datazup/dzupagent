/**
 * @dzupagent/core/pipeline — Pipeline DSL, formats, structured output,
 * agent registry, MCP, skills, sub-agents, and flow handle types.
 *
 * @example
 * ```ts
 * import {
 *   PipelineDefinitionSchema,
 *   serializePipeline,
 *   InMemoryRegistry,
 *   SkillManager,
 *   MCPClient,
 * } from '@dzupagent/core/pipeline'
 * ```
 */

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------
export { SubAgentSpawner } from "./subagent/subagent-spawner.js";
export { REACT_DEFAULTS } from "./subagent/subagent-types.js";
export type {
  SubAgentConfig,
  SubAgentResult,
  SubAgentUsage,
} from "./subagent/subagent-types.js";
export { mergeFileChanges, fileDataReducer } from "./subagent/file-merge.js";

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
export { SkillLoader } from "./skills/skill-loader.js";
export { injectSkills } from "./skills/skill-injector.js";
export type {
  SkillDefinition,
  SkillRegistryEntry,
  LoadedSkill,
  SkillMatch,
} from "./skills/skill-types.js";
export { SkillRegistry } from "./skills/skill-registry.js";
export {
  SkillDirectoryLoader,
  parseMarkdownSkill,
  parseJsonSkill,
} from "./skills/skill-directory-loader.js";
export type { SkillDirectoryLoaderOptions } from "./skills/skill-directory-loader.js";
export { SkillManager } from "./skills/skill-manager.js";
export type {
  SkillManagerConfig,
  CreateSkillInput,
  PatchSkillInput,
  SkillWriteResult,
} from "./skills/skill-manager.js";
export { SkillLearner } from "./skills/skill-learner.js";
export type {
  SkillMetrics,
  SkillExecutionResult,
  SkillLearnerConfig,
} from "./skills/skill-learner.js";
export type {
  SkillResolutionContext,
  FeatureBrief,
  WorkItem,
  PersonaProfile,
  PersonaRoleType,
  SkillLifecycleStatus,
  SkillScope,
  SkillReviewPolicy,
  SkillDefinitionV2,
  SkillUsageRecord,
  SkillReviewRecord,
} from "./skills/skill-model-v2.js";
export {
  SKILL_LIFECYCLE_TRANSITIONS,
  isValidSkillTransition,
} from "./skills/skill-model-v2.js";
export {
  createSkillChain,
  validateChain,
  SkillChainBuilder,
} from "./skills/skill-chain.js";
export type {
  SkillChainStep,
  SkillChain,
  ChainValidationResult,
  RetryPolicy,
} from "./skills/skill-chain.js";
export {
  parseAgentsMd,
  mergeAgentsMdConfigs,
} from "./skills/agents-md-parser.js";
export type { AgentsMdConfig } from "./skills/agents-md-parser.js";
export { discoverAgentConfigs } from "./skills/hierarchical-walker.js";
export type { HierarchyLevel } from "./skills/hierarchical-walker.js";
export { WorkflowCommandParser } from "./skills/workflow-command-parser.js";
export type {
  WorkflowCommandParserConfig,
  WorkflowCommandParseResult,
  WorkflowCommandParseSuccess,
  WorkflowCommandParseFailure,
  WorkflowSeparatorStyle,
  ParsedStepToken,
  ParseConfidenceTier,
  CandidateInterpretation,
  WorkflowKeywordPattern,
  WorkflowAliasEntry,
} from "./skills/workflow-command-parser.js";
export { WorkflowRegistry } from "./skills/workflow-registry.js";
export type {
  WorkflowRegistryEntry,
  WorkflowRegistrySnapshot,
  WorkflowRegistrationOptions,
  WorkflowComposeOptions,
  WorkflowFindResult,
  WorkflowListEntry,
} from "./skills/workflow-registry.js";

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
export { MCPClient } from "./mcp/mcp-client.js";
export {
  mcpToolToLangChain,
  mcpToolsToLangChain,
  langChainToolToMcp,
} from "./mcp/mcp-tool-bridge.js";
export { DeferredToolLoader } from "./mcp/deferred-loader.js";
export { DzupAgentMCPServer, isMCPRequest } from "./mcp/mcp-server.js";
export type {
  MCPServerOptions,
  MCPExposedTool,
  MCPExposedResource,
  MCPExposedResourceTemplate,
  MCPExposedPrompt,
  MCPServerCapabilities,
  MCPInitializeResult,
  MCPRequest,
  MCPRequestId,
  MCPResponse,
} from "./mcp/mcp-server.js";
export type {
  MCPTransport,
  MCPServerConfig,
  MCPToolDescriptor,
  MCPToolParameter,
  MCPToolResult,
  MCPConnectionState,
  MCPServerStatus,
} from "./mcp/mcp-types.js";
export type { DeferredLoaderConfig } from "./mcp/deferred-loader.js";
export { McpReliabilityManager } from "./mcp/mcp-reliability.js";
export type {
  McpServerHealth,
  McpReliabilityConfig,
} from "./mcp/mcp-reliability.js";
export { InMemoryMcpManager } from "./mcp/mcp-manager.js";
export type {
  McpManager,
  InMemoryMcpManagerOptions,
} from "./mcp/mcp-manager.js";
export {
  McpServerDefinitionSchema,
  McpProfileSchema,
} from "./mcp/mcp-registry-types.js";
export type {
  McpServerDefinition,
  McpProfile,
  McpServerInput,
  McpServerPatch,
  McpTestResult,
} from "./mcp/mcp-registry-types.js";
export {
  validateMcpExecutablePath,
  sanitizeMcpEnv,
  assertMcpCommandAllowed,
} from "./mcp/mcp-security.js";
export type { McpStdioArgPolicy } from "./mcp/mcp-security.js";
export { MCPResourceClient } from "./mcp/mcp-resources.js";
export type { MCPResourceClientConfig } from "./mcp/mcp-resources.js";
export type {
  MCPResource,
  MCPResourceTemplate,
  MCPResourceContent,
  ResourceSubscription,
  ResourceChangeHandler,
} from "./mcp/mcp-resource-types.js";
export type {
  MCPPromptArgument,
  MCPPromptDescriptor,
  MCPPromptGetResult,
  MCPPromptHandler,
  MCPPromptContent,
  MCPPromptMessage,
  MCPPromptTextContent,
  MCPPromptImageContent,
  MCPPromptResourceContent,
} from "./mcp/mcp-prompt-types.js";
export {
  createSamplingHandler,
  registerSamplingHandler,
} from "./mcp/mcp-sampling.js";
export type {
  MCPSamplingConfig,
  LLMInvokeMessage,
  LLMInvokeOptions,
  LLMInvokeResult,
  LLMInvokeFn,
  SamplingRegistration,
} from "./mcp/mcp-sampling.js";
export type {
  MCPSamplingRequest,
  MCPSamplingResponse,
  MCPSamplingContent,
  MCPSamplingMessage,
  MCPModelPreferences,
  SamplingHandler,
} from "./mcp/mcp-sampling-types.js";

// ---------------------------------------------------------------------------
// Registry (agent registry)
// ---------------------------------------------------------------------------
export { InMemoryRegistry } from "./registry/index.js";
export { CapabilityMatcher, compareSemver } from "./registry/index.js";
export {
  STANDARD_CAPABILITIES,
  isStandardCapability,
  getCapabilityDescription,
  listStandardCapabilities,
} from "./registry/index.js";
export type {
  CapabilityDescriptor,
  AgentHealthStatus,
  DeregistrationReason,
  AgentHealth,
  AgentSLA,
  AgentAuthentication,
  RegisteredAgent,
  RegisterAgentInput,
  DiscoveryQuery,
  ScoreBreakdown,
  DiscoveryResult,
  DiscoveryResultPage,
  RegistryStats,
  RegistryEventType,
  RegistrySubscriptionFilter,
  RegistryEvent,
  AgentRegistryConfig,
  AgentRegistry,
} from "./registry/index.js";
export type { CapabilityTree, CapabilityTreeNode } from "./registry/index.js";
export {
  KeywordFallbackSearch,
  createKeywordFallbackSearch,
} from "./registry/index.js";
export type { SemanticSearchProvider } from "./registry/index.js";
export { VectorStoreSemanticSearch } from "./registry/index.js";

// ---------------------------------------------------------------------------
// Flow handle types
// ---------------------------------------------------------------------------
export type {
  SkillHandle,
  McpToolHandle,
  WorkflowHandle,
  ResolvedAgentHandle,
  AgentHandle,
  FlowHandle,
  McpInvocationResult,
  AgentInvocation,
  AgentInvocationResult,
  SkillExecutionContext,
} from "./flow/index.js";

// ---------------------------------------------------------------------------
// Pipeline schemas and types
// ---------------------------------------------------------------------------
export type {
  NodeRetryPolicy,
  PipelineNodeBase,
  AgentNode,
  ToolNode,
  TransformNode,
  GateNode,
  ForkNode,
  JoinNode,
  LoopNode,
  SuspendNode,
  PipelineNode,
  SequentialEdge,
  ConditionalEdge,
  ErrorEdge,
  PipelineEdge,
  CheckpointStrategy,
  PipelineDefinition,
  PipelineValidationError,
  PipelineValidationWarning,
  PipelineValidationResult,
  PipelineCheckpoint,
  PipelineCheckpointSummary,
  PipelineCheckpointStore,
} from "./pipeline/index.js";
export {
  AgentNodeSchema,
  ToolNodeSchema,
  TransformNodeSchema,
  GateNodeSchema,
  ForkNodeSchema,
  JoinNodeSchema,
  LoopNodeSchema,
  SuspendNodeSchema,
  PipelineNodeSchema,
  SequentialEdgeSchema,
  ConditionalEdgeSchema,
  ErrorEdgeSchema,
  PipelineEdgeSchema,
  PipelineCheckpointSchema,
  PipelineDefinitionSchema,
  serializePipeline,
  deserializePipeline,
  autoLayout,
} from "./pipeline/index.js";
export type {
  NodePosition,
  ViewportState,
  PipelineLayout,
} from "./pipeline/index.js";

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------
export {
  AgentCardV2Schema,
  validateAgentCard,
  zodToJsonSchema,
  jsonSchemaToZod,
  toOpenAISafeSchema,
  toStructuredOutputJsonSchema,
  describeStructuredOutputSchema,
  buildStructuredOutputSchemaName,
  attachStructuredOutputErrorContext,
  detectStructuredOutputStrategy,
  resolveStructuredOutputCapabilities,
  resolveStructuredOutputSchemaProvider,
  shouldAttemptNativeStructuredOutput,
  prepareStructuredOutputSchemaContract,
  unwrapStructuredEnvelope,
  executeStructuredParseLoop,
  executeStructuredParseStreamLoop,
  buildStructuredOutputCorrectionPrompt,
  buildStructuredOutputExhaustedError,
  isStructuredOutputExhaustedErrorMessage,
  toOpenAIFunction,
  toOpenAITool,
  fromOpenAIFunction,
  toMCPToolDescriptor,
  fromMCPToolDescriptor,
  parseAgentsMdV2,
  generateAgentsMd,
  toLegacyConfig,
} from "./formats/index.js";
export type {
  ContentMode,
  AgentCardV2,
  AgentCardCapability,
  AgentCardSkill,
  AgentAuthScheme,
  AgentCardAuthentication,
  AgentCardSLA,
  AgentCardProvider,
  AgentCardValidationResult,
  OpenAIFunctionDefinition,
  OpenAIToolDefinition,
  StructuredOutputSchemaSummary,
  StructuredOutputSchemaDescriptor,
  StructuredOutputErrorSchemaRef,
  StructuredOutputFailureCategory,
  StructuredOutputErrorContextInput,
  StructuredOutputProvider,
  StructuredOutputRuntimeMeta,
  StructuredOutputSchemaContract,
  StructuredOutputSchemaRef,
  StructuredParseAttempt,
  StructuredParseLoopSuccess,
  StructuredParseLoopFailure,
  StructuredParseLoopResult,
  ExecuteStructuredParseLoopInput,
  ExecuteStructuredParseStreamLoopInput,
  StructuredParseStreamLoopEvent,
  ToolSchemaDescriptor,
  MCPToolDescriptorCompat,
  AgentsMdDocument,
  AgentsMdMetadata,
  AgentsMdCapability as AgentsMdCapabilityV2,
  AgentsMdMemoryConfig,
  AgentsMdSecurityConfig,
} from "./formats/index.js";

// ---------------------------------------------------------------------------
// Structured output (shared primitives)
// ---------------------------------------------------------------------------
export {
  JsonOutputSchema,
  RegexOutputSchema,
  extractJsonFromMarkdown,
  toSchemaRef,
  createZodStructuredValidator,
} from "./structured/index.js";
export type { OutputSchema, ParseResult } from "./structured/index.js";
