/**
 * Zod request schemas for AdapterHttpHandler endpoints.
 *
 * Provides strict validation with size limits and type constraints
 * for all HTTP request bodies.
 */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { z } from 'zod'

import { HTTP_ROUTABLE_PROVIDER_IDS } from '../provider-catalog.js'
import type { AdapterProviderId } from '../types.js'

const HttpRoutableProviderIds = HTTP_ROUTABLE_PROVIDER_IDS as [
  AdapterProviderId,
  ...AdapterProviderId[],
]

export const AdapterProviderIdSchema = z.enum(HttpRoutableProviderIds)
export const PolicyConformanceModeSchema = z.enum(['strict', 'warn-only'])

/**
 * Tool names are forwarded to external agent CLIs as **variadic** argv values
 * (`--allowedTools a b c`), so any value starting with `-` would be parsed by
 * the CLI as a new flag (e.g. `--dangerously-skip-permissions`). Restricting
 * the character class rejects that class of argument injection outright.
 */
const ToolNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]+$/)
  // The character class above permits `-`, which is legitimate *inside* a tool
  // name (`web-search`) but is exactly the smuggling vector when it leads
  // (`--dangerously-skip-permissions`). Reject a leading `-` explicitly.
  .refine((value) => !value.startsWith('-'), {
    message: 'Tool name must not start with "-"',
  })
const ToolListSchema = z.array(ToolNameSchema).max(200)

export const SandboxModeSchema = z.enum([
  'read-only',
  'workspace-write',
  'full-access',
])
export const ReasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/**
 * SEC-C-01: the HTTP `options` bag used to be `z.record(z.string(),
 * z.unknown())` — an untyped channel forwarded verbatim into `AgentInput`,
 * which is exactly where sandbox-tier downgrades (SEC-H-11) and tool-list
 * argument injection (SEC-H-10) are consumed. It is now an explicit,
 * `.strict()` allowlist: unknown keys are rejected rather than forwarded.
 */
export const RunOptionsSchema = z
  .object({
    sandboxMode: SandboxModeSchema.optional(),
    allowedTools: ToolListSchema.optional(),
    blockedTools: ToolListSchema.optional(),
    model: z.string().max(200).optional(),
    reasoning: ReasoningEffortSchema.optional(),
  })
  .strict()

export const RunRequestSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  tags: z.array(z.string().max(100)).max(50).optional(),
  preferredProvider: AdapterProviderIdSchema.optional(),
  stream: z.boolean().optional(),
  systemPrompt: z.string().max(100_000).optional(),
  workingDirectory: z.string().max(4096).optional(),
  maxTurns: z.number().int().positive().max(1000).optional(),
  maxBudgetUsd: z.number().positive().max(100).optional(),
  policyConformanceMode: PolicyConformanceModeSchema.optional(),
  options: RunOptionsSchema.optional(),
})

/**
 * `workingDirectory` becomes the spawned CLI's cwd (and Claude's `--add-dir`),
 * so the schema's length check is not enough: the requested directory is
 * realpath'd (following symlinks) and must sit inside one of the allowed roots,
 * themselves realpath'd. With no roots configured the process cwd is the only
 * root. Returns the resolved path to hand to the adapter, or `undefined` when
 * the directory is missing or escapes every root.
 */
export async function resolveAllowedWorkingDirectory(
  requested: string,
  allowedRoots: readonly string[] | undefined,
): Promise<string | undefined> {
  const roots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : [process.cwd()]
  let target: string
  try {
    target = await realpath(resolve(requested))
    if (!(await stat(target)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = await realpath(resolve(root))
    } catch {
      continue
    }
    const rel = relative(realRoot, target)
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return target
  }
  return undefined
}

export const SupervisorRequestSchema = z.object({
  goal: z.string().min(1).max(100_000),
  maxConcurrency: z.number().int().positive().max(50).optional(),
  maxConcurrentDelegations: z.number().int().positive().max(50).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  preferredProviders: z.array(AdapterProviderIdSchema).optional(),
  stream: z.boolean().optional(),
})

export const ParallelRequestSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  providers: z.array(AdapterProviderIdSchema).min(1).max(10),
  strategy: z.enum(['first-wins', 'all', 'best-of-n']).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  stream: z.boolean().optional(),
})

export const BidRequestSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  criteria: z.enum(['best-bid', 'lowest-cost', 'highest-confidence']).optional(),
})

export const ApproveRequestSchema = z.object({
  approved: z.boolean(),
  approvedBy: z.string().max(1000).optional(),
  reason: z.string().max(10_000).optional(),
})

export type RunOptions = z.infer<typeof RunOptionsSchema>
export type RunRequest = z.infer<typeof RunRequestSchema>
export type SupervisorRequest = z.infer<typeof SupervisorRequestSchema>
export type ParallelRequest = z.infer<typeof ParallelRequestSchema>
export type BidRequest = z.infer<typeof BidRequestSchema>
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>
