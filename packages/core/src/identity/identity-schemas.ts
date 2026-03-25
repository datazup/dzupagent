/**
 * Zod validation schemas for ForgeAgent identity types.
 *
 * All exported schemas use PascalCase (per S3 convention).
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Capability name regex (C2: allow hyphens)
// ---------------------------------------------------------------------------

/**
 * Capability names are dot-separated segments.
 * Each segment starts with a lowercase letter and may contain lowercase letters,
 * digits, and hyphens.
 *
 * Valid: `code.review`, `code-gen.typescript`, `a`
 * Invalid: `Code.review`, `.foo`, `foo.`, `foo..bar`
 */
const CAPABILITY_NAME_REGEX = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ForgeCapabilitySchema = z.object({
  name: z.string().regex(CAPABILITY_NAME_REGEX, {
    message:
      'Capability name must be dot-separated lowercase segments (letters, digits, hyphens). ' +
      'Example: code.review.security',
  }),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, {
    message: 'Version must be semver (e.g. 1.0.0)',
  }),
  description: z.string().min(1, { message: 'Description is required for registry discoverability' }),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  sla: z
    .object({
      maxLatencyMs: z.number().positive().optional(),
      maxCostCents: z.number().nonnegative().optional(),
    })
    .optional(),
})

export const ForgeCredentialSchema = z.object({
  type: z.enum(['api-key', 'oauth2', 'did-vc', 'mtls', 'delegation', 'custom']),
  issuedAt: z.date(),
  expiresAt: z.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const ForgeIdentitySchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  organization: z.string().min(1),
  capabilities: z.array(ForgeCapabilitySchema),
  credentials: z.array(ForgeCredentialSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const ForgeIdentityRefSchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  displayName: z.string().min(1),
})
