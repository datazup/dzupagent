/**
 * Format standards — Agent Card v2, OpenAI compatibility, AGENTS.md v2 parser.
 */

// --- Agent Card V2 (A2A-compliant) ---
export {
  AgentCardV2Schema,
  validateAgentCard,
} from './agent-card-types.js'
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
} from './agent-card-types.js'

// --- OpenAI Function Types ---
export type {
  OpenAIFunctionDefinition,
  OpenAIToolDefinition,
} from './openai-function-types.js'

// --- Tool Format Adapters ---
export {
  zodToJsonSchema,
  jsonSchemaToZod,
  toOpenAIFunction,
  toOpenAITool,
  fromOpenAIFunction,
  toMCPToolDescriptor,
  fromMCPToolDescriptor,
} from './tool-format-adapters.js'
export type {
  ToolSchemaDescriptor,
  MCPToolDescriptorCompat,
} from './tool-format-adapters.js'

// --- AGENTS.md V2 Types ---
export type {
  AgentsMdDocument,
  AgentsMdMetadata,
  AgentsMdCapability,
  AgentsMdMemoryConfig,
  AgentsMdSecurityConfig,
} from './agents-md-types.js'

// --- AGENTS.md V2 Parser ---
export {
  parseAgentsMdV2,
  generateAgentsMd,
  toLegacyConfig,
} from './agents-md-parser-v2.js'
