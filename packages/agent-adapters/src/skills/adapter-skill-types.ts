/**
 * Adapter skill bundle types for compiling canonical skill definitions
 * into provider-specific runtime formats.
 */

import type { AdapterProviderId } from '../types.js'

/** Canonical adapter-ready skill bundle that can be compiled for any provider. */
export interface AdapterSkillBundle {
  bundleId: string
  skillSetId: string
  skillSetVersion: string
  personaId?: string
  constraints: {
    maxBudgetUsd?: number
    approvalMode?: 'auto' | 'required' | 'conditional'
    networkPolicy?: 'off' | 'restricted' | 'on'
    toolPolicy?: 'strict' | 'balanced' | 'open'
  }
  promptSections: Array<{
    id: string
    purpose: 'persona' | 'style' | 'safety' | 'task' | 'review' | 'output'
    content: string
    priority: number // lower = higher priority
  }>
  toolBindings: Array<{
    toolName: string
    mode: 'required' | 'optional' | 'blocked'
  }>
  metadata: {
    owner: string
    reviewedBy?: string
    createdAt: string
    updatedAt: string
  }
}

/** The output of compiling an AdapterSkillBundle for a specific provider. */
export interface CompiledAdapterSkill {
  providerId: AdapterProviderId
  projectionVersion: string
  runtimeConfig: Record<string, unknown>
  hash: string // stable hash of bundle content + providerId
}

/** Compiler that transforms a bundle into a provider-specific compiled skill. */
export interface AdapterSkillCompiler {
  providerId: AdapterProviderId
  compile(bundle: AdapterSkillBundle): CompiledAdapterSkill
  validate(compiled: CompiledAdapterSkill): { ok: boolean; errors?: string[] }
}

/** Record of a projection being used at runtime. */
export interface ProjectionUsageRecord {
  runId: string
  bundleId: string
  providerId: AdapterProviderId
  projectionHash: string
  projectionVersion: string
  success: boolean
  timestamp: string
}
