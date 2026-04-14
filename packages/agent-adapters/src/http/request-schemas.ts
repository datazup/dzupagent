/**
 * Zod request schemas for AdapterHttpHandler endpoints.
 *
 * Provides strict validation with size limits and type constraints
 * for all HTTP request bodies.
 */

import { z } from 'zod'

const AdapterProviderIdSchema = z.enum(['claude', 'codex', 'gemini', 'qwen', 'crush', 'goose', 'openrouter'])

export const RunRequestSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  tags: z.array(z.string().max(100)).max(50).optional(),
  preferredProvider: AdapterProviderIdSchema.optional(),
  stream: z.boolean().optional(),
  systemPrompt: z.string().max(100_000).optional(),
  workingDirectory: z.string().max(4096).optional(),
  maxTurns: z.number().int().positive().max(1000).optional(),
  maxBudgetUsd: z.number().positive().max(100).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
})

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

export type RunRequest = z.infer<typeof RunRequestSchema>
export type SupervisorRequest = z.infer<typeof SupervisorRequestSchema>
export type ParallelRequest = z.infer<typeof ParallelRequestSchema>
export type BidRequest = z.infer<typeof BidRequestSchema>
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>
