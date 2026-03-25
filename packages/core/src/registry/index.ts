/**
 * Registry module — barrel exports.
 */

// --- Types ---
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
} from './types.js'

// --- Capability taxonomy ---
export {
  STANDARD_CAPABILITIES,
  isStandardCapability,
  getCapabilityDescription,
  listStandardCapabilities,
} from './capability-taxonomy.js'
export type { CapabilityTree, CapabilityTreeNode } from './capability-taxonomy.js'

// --- Capability matcher ---
export { CapabilityMatcher, compareSemver } from './capability-matcher.js'

// --- In-memory registry ---
export { InMemoryRegistry } from './in-memory-registry.js'

// --- Semantic search (ECO-050) ---
export { KeywordFallbackSearch, createKeywordFallbackSearch } from './semantic-search.js'
export type { SemanticSearchProvider } from './semantic-search.js'
