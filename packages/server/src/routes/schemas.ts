/**
 * Shared Zod request-body schemas for high-risk route handlers.
 *
 * These schemas are consumed by {@link validateBody} at route boundaries to
 * guarantee runtime validation on top of TypeScript's compile-time types. Any
 * malformed payload yields a structured 400 response before the handler runs.
 */
import type { Context } from 'hono'
import { z, type ZodType } from 'zod'

// ---------------------------------------------------------------------------
// /api/runs — create run
// ---------------------------------------------------------------------------

/**
 * POST /api/runs body.
 *
 * `input` is intentionally typed as `unknown` — the shape depends on the
 * target agent. `metadata` is validated as a generic record; additional
 * payload-size guards are applied inside the handler.
 */
export const RunCreateSchema = z.object({
  agentId: z.string().min(1),
  input: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type RunCreateBody = z.infer<typeof RunCreateSchema>

// ---------------------------------------------------------------------------
// /api/agent-definitions — create agent definition
// ---------------------------------------------------------------------------

/**
 * POST /api/agent-definitions body.
 *
 * Matches {@link AgentDefinitionService.create}'s input shape. `id` is
 * optional — the service will generate one when omitted.
 */
export const AgentCreateSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  instructions: z.string().min(1),
  modelTier: z.string().min(1),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  guardrails: z.record(z.string(), z.unknown()).optional(),
  approval: z.enum(['auto', 'required', 'conditional']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict()

export type AgentCreateBody = z.infer<typeof AgentCreateSchema>

export const AgentUpdateSchema = AgentCreateSchema.partial().strict().transform((body) => {
  const update = { ...body }
  delete update.id
  return update
})

export type AgentUpdateBody = z.infer<typeof AgentUpdateSchema>

// ---------------------------------------------------------------------------
// Tenant-scoped CRUD surfaces
// ---------------------------------------------------------------------------

const MetadataSchema = z.record(z.string(), z.unknown())

export const TriggerCreateSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.enum(['cron', 'webhook', 'chain']),
  agentId: z.string().min(1),
  schedule: z.string().min(1).optional(),
  webhookSecret: z.string().min(1).optional(),
  afterAgentId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  metadata: MetadataSchema.optional(),
}).strict()

export type TriggerCreateBody = z.infer<typeof TriggerCreateSchema>

export const TriggerEnableSchema = z.object({
  enabled: z.boolean(),
}).strict()

export type TriggerEnableBody = z.infer<typeof TriggerEnableSchema>

export const ScheduleCreateSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  cronExpression: z.string().min(1),
  workflowText: z.string().min(1),
  enabled: z.boolean().optional(),
  metadata: MetadataSchema.optional(),
}).strict()

export type ScheduleCreateBody = z.infer<typeof ScheduleCreateSchema>

export const ScheduleUpdateSchema = ScheduleCreateSchema.omit({ id: true }).partial().strict()

export type ScheduleUpdateBody = z.infer<typeof ScheduleUpdateSchema>

export const PersonaCreateSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  instructions: z.string().min(1),
  modelId: z.string().min(1).optional(),
  temperature: z.number().optional(),
  metadata: MetadataSchema.optional(),
}).strict()

export type PersonaCreateBody = z.infer<typeof PersonaCreateSchema>

export const PersonaUpdateSchema = PersonaCreateSchema.omit({ id: true }).partial().strict()

export type PersonaUpdateBody = z.infer<typeof PersonaUpdateSchema>

export const PromptCreateSchema = z.object({
  id: z.string().min(1).optional(),
  promptId: z.string().min(1).optional(),
  name: z.string().min(1),
  type: z.string().min(1),
  category: z.string().min(1).optional(),
  content: z.string().min(1),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  ownerId: z.string().min(1).optional(),
  ownerType: z.enum(['agent', 'persona']).optional(),
  metadata: MetadataSchema.optional(),
}).strict()

export type PromptCreateBody = z.infer<typeof PromptCreateSchema>

export const PromptUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  ownerType: z.enum(['agent', 'persona']).optional(),
  metadata: MetadataSchema.optional(),
}).strict()

export type PromptUpdateBody = z.infer<typeof PromptUpdateSchema>

export const PromptRollbackSchema = z.object({
  targetId: z.string().min(1),
}).strict()

export type PromptRollbackBody = z.infer<typeof PromptRollbackSchema>

export const MarketplaceCatalogCreateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  version: z.string().min(1),
  tags: z.array(z.string()).optional(),
  author: z.string().nullable().optional(),
  readme: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  isPublic: z.boolean().optional(),
}).strict()

export type MarketplaceCatalogCreateBody = z.infer<typeof MarketplaceCatalogCreateSchema>

export const MarketplaceCatalogUpdateSchema = MarketplaceCatalogCreateSchema.partial().strict()

export type MarketplaceCatalogUpdateBody = z.infer<typeof MarketplaceCatalogUpdateSchema>

export const ClusterCreateSchema = z.object({
  clusterId: z.string().min(1).optional(),
  workspaceType: z.string().min(1).optional(),
  workspaceOptions: MetadataSchema.optional(),
}).strict()

export type ClusterCreateBody = z.infer<typeof ClusterCreateSchema>

export const ClusterRoleCreateSchema = z.object({
  roleId: z.string().min(1),
  agentId: z.string().min(1),
  capabilities: z.array(z.string()).optional(),
}).strict()

export type ClusterRoleCreateBody = z.infer<typeof ClusterRoleCreateSchema>

export const ClusterMailSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  message: z.object({
    subject: z.string().min(1),
    body: MetadataSchema,
    ttl: z.number().optional(),
  }).strict(),
}).strict()

export type ClusterMailBody = z.infer<typeof ClusterMailSchema>

// ---------------------------------------------------------------------------
// /api/mcp/servers — register MCP server
// ---------------------------------------------------------------------------

/**
 * POST /api/mcp/servers body.
 *
 * Aligns with {@link McpServerInput} from `@dzupagent/core` — `endpoint`
 * carries the URL for `http`/`sse` transports and the command for `stdio`.
 * Stdio commands are additionally gated by the `mcpAllowedExecutables`
 * allowlist (see RF-S03).
 */
export const McpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  transport: z.enum(['http', 'sse', 'stdio']),
  endpoint: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxEagerTools: z.number().int().positive().optional(),
  enabled: z.boolean(),
  tags: z.array(z.string()).optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  headerRef: z.string().optional(),
  envRef: z.string().optional(),
})

export type McpServerBody = z.infer<typeof McpServerSchema>

// ---------------------------------------------------------------------------
// Query param helpers
// ---------------------------------------------------------------------------

/**
 * Validate a request body against a Zod schema, returning either the parsed
 * value or a legacy-shape 400 response (`{ error: { code, message } }`).
 *
 * The built-in {@link validateBody} helper in `../validation/route-validator`
 * emits a flatter `{ error: 'VALIDATION_ERROR', issues }` envelope that its
 * own unit tests depend on. Existing route-handler tests — and therefore the
 * public HTTP contract — expect the older nested shape, so this wrapper
 * converts on the way out. The Zod-derived `issues` array is preserved as a
 * sibling field for callers that want structured error detail.
 */
export async function validateBodyCompat<T>(
  c: Context,
  schema: ZodType<T>,
): Promise<T | Response> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body is not valid JSON',
        },
      },
      400,
    )
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path?.map((seg) => String(seg)).join('.') ?? ''
    const message = path
      ? `${path}: ${issue?.message ?? 'Invalid value'}`
      : issue?.message ?? 'Invalid request body'
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message,
          issues: result.error.issues.map((i) => ({
            code: String(i.code),
            path: i.path.map((seg) => (typeof seg === 'symbol' ? String(seg) : seg)),
            message: i.message,
          })),
        },
      },
      400,
    )
  }

  return result.data
}

/**
 * Parse an integer string with default + bounds clamping.
 *
 * Used for `limit`/`offset` query params on list endpoints where we want
 * malformed input to degrade to the default rather than returning 400.
 * Bounds prevent rogue clients from requesting absurd page sizes or
 * deeply paginated scans.
 */
export function parseIntBounded(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return defaultValue
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.max(min, Math.min(max, parsed))
}
