/**
 * A2A-compliant Agent Card v2 types and validation.
 *
 * Implements the Agent-to-Agent protocol Agent Card specification
 * with Zod schema validation.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Content mode
// ---------------------------------------------------------------------------

export type ContentMode = 'text' | 'image' | 'audio' | 'video' | 'file'

const ContentModeSchema = z.enum(['text', 'image', 'audio', 'video', 'file'])

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

export interface AgentCardCapability {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

export interface AgentCardSkill {
  id: string
  name: string
  description: string
  tags?: string[]
}

export interface AgentAuthScheme {
  type: 'apiKey' | 'bearer' | 'oauth2' | 'none'
  in?: 'header' | 'query'
  name?: string
}

export interface AgentCardAuthentication {
  schemes: AgentAuthScheme[]
}

export interface AgentCardSLA {
  maxLatencyMs?: number
  maxCostCents?: number
  uptimeRatio?: number
}

export interface AgentCardProvider {
  organization: string
  url?: string
}

// ---------------------------------------------------------------------------
// Agent Card V2
// ---------------------------------------------------------------------------

export interface AgentCardV2 {
  name: string
  description: string
  url: string
  version?: string
  provider?: AgentCardProvider
  capabilities?: AgentCardCapability[]
  skills?: AgentCardSkill[]
  authentication?: AgentCardAuthentication
  defaultInputModes?: ContentMode[]
  defaultOutputModes?: ContentMode[]
  sla?: AgentCardSLA
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const AgentCardCapabilitySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
})

const AgentCardSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).optional(),
})

const AgentAuthSchemeSchema = z.object({
  type: z.enum(['apiKey', 'bearer', 'oauth2', 'none']),
  in: z.enum(['header', 'query']).optional(),
  name: z.string().optional(),
})

const AgentCardAuthenticationSchema = z.object({
  schemes: z.array(AgentAuthSchemeSchema).min(1),
})

const AgentCardSLASchema = z.object({
  maxLatencyMs: z.number().positive().optional(),
  maxCostCents: z.number().nonnegative().optional(),
  uptimeRatio: z.number().min(0).max(1).optional(),
})

const AgentCardProviderSchema = z.object({
  organization: z.string().min(1),
  url: z.string().url().optional(),
})

export const AgentCardV2Schema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.string().url(),
  version: z.string().optional(),
  provider: AgentCardProviderSchema.optional(),
  capabilities: z.array(AgentCardCapabilitySchema).optional(),
  skills: z.array(AgentCardSkillSchema).optional(),
  authentication: AgentCardAuthenticationSchema.optional(),
  defaultInputModes: z.array(ContentModeSchema).optional(),
  defaultOutputModes: z.array(ContentModeSchema).optional(),
  sla: AgentCardSLASchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface AgentCardValidationResult {
  valid: boolean
  card?: AgentCardV2
  errors?: string[]
}

/**
 * Validate unknown data against the AgentCardV2 schema.
 * Returns a typed result with either the parsed card or error messages.
 */
export function validateAgentCard(data: unknown): AgentCardValidationResult {
  const result = AgentCardV2Schema.safeParse(data)

  if (result.success) {
    return { valid: true, card: result.data as AgentCardV2 }
  }

  const errors = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  )
  return { valid: false, errors }
}
