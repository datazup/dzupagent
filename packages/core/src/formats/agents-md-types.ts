/**
 * AGENTS.md v2 document types.
 *
 * Represents a structured AGENTS.md file with YAML front matter
 * and markdown sections for capabilities, memory, and security.
 */

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface AgentsMdMetadata {
  name: string
  description?: string
  version?: string
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface AgentsMdCapability {
  name: string
  description: string
}

// ---------------------------------------------------------------------------
// Memory configuration
// ---------------------------------------------------------------------------

export interface AgentsMdMemoryConfig {
  namespaces?: string[]
  maxRecords?: number
}

// ---------------------------------------------------------------------------
// Security configuration
// ---------------------------------------------------------------------------

export interface AgentsMdSecurityConfig {
  allowedTools?: string[]
  blockedTools?: string[]
}

// ---------------------------------------------------------------------------
// Full document
// ---------------------------------------------------------------------------

export interface AgentsMdDocument {
  metadata: AgentsMdMetadata
  capabilities?: AgentsMdCapability[]
  memory?: AgentsMdMemoryConfig
  security?: AgentsMdSecurityConfig
  rawContent: string
}
