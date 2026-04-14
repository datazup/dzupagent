/**
 * MCP Registry domain types and Zod schemas.
 *
 * Defines persistent MCP server definitions and profiles used by the
 * McpManager lifecycle API. These types extend the existing MCPServerConfig
 * with governance fields (risk level, secret refs, tags) and lifecycle
 * metadata (createdAt, updatedAt, enabled).
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const McpTransportSchema = z.enum(['http', 'sse', 'stdio'])

export const McpRiskLevelSchema = z.enum(['low', 'medium', 'high'])

export const McpServerDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  transport: McpTransportSchema,
  endpoint: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxEagerTools: z.number().int().positive().optional(),
  enabled: z.boolean(),
  tags: z.array(z.string()).optional(),
  riskLevel: McpRiskLevelSchema.optional(),
  headerRef: z.string().optional(),
  envRef: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const McpProfileSchema = z.object({
  id: z.string().min(1),
  serverIds: z.array(z.string()),
  toolSelectors: z.array(z.string()).optional(),
  enabled: z.boolean(),
})

// ---------------------------------------------------------------------------
// Derived TypeScript types
// ---------------------------------------------------------------------------

/** Persistent definition for an MCP server registered in the manager. */
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>

/** Profile that maps a set of MCP servers and tool selectors to an agent. */
export type McpProfile = z.infer<typeof McpProfileSchema>

/** Input for adding a new server (timestamps generated automatically). */
export type McpServerInput = Omit<McpServerDefinition, 'createdAt' | 'updatedAt'>

/** Partial update patch for an existing server definition. */
export type McpServerPatch = Partial<Omit<McpServerDefinition, 'id' | 'createdAt' | 'updatedAt'>>

/** Result of testing connectivity to an MCP server. */
export interface McpTestResult {
  ok: boolean
  error?: string | undefined
  toolCount?: number | undefined
}
