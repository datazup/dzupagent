import type { PresetName, TemplateType } from './types.js'

/**
 * A preset bundles a template + feature set + database/auth defaults
 * for common project archetypes.
 */
export interface PresetConfig {
  name: PresetName
  label: string
  description: string
  template: TemplateType
  features: string[]
  database: 'postgres' | 'sqlite' | 'none'
  auth: 'api-key' | 'jwt' | 'none'
}

export const presets: Record<PresetName, PresetConfig> = {
  minimal: {
    name: 'minimal',
    label: 'Minimal',
    description: 'Bare-bones single-agent setup with no extras',
    template: 'minimal',
    features: [],
    database: 'none',
    auth: 'none',
  },
  starter: {
    name: 'starter',
    label: 'Starter',
    description: 'Base template with auth and Dashboard API routes',
    template: 'full-stack',
    features: ['auth', 'dashboard'],
    database: 'postgres',
    auth: 'api-key',
  },
  full: {
    name: 'full',
    label: 'Full',
    description: 'Full stack with auth, Dashboard API routes, billing, teams, and AI',
    template: 'production-saas-agent',
    features: ['auth', 'dashboard', 'billing', 'teams', 'ai'],
    database: 'postgres',
    auth: 'jwt',
  },
  'api-only': {
    name: 'api-only',
    label: 'API Only',
    description: 'Backend-only server with no frontend',
    template: 'server',
    features: ['auth'],
    database: 'postgres',
    auth: 'api-key',
  },
  research: {
    name: 'research',
    label: 'Research',
    description: 'Research agent with web search, RAG, and report synthesis',
    template: 'research',
    features: [],
    database: 'none',
    auth: 'none',
  },
}

export const PRESET_NAMES: readonly PresetName[] = [
  'minimal',
  'starter',
  'full',
  'api-only',
  'research',
] as const

/**
 * Get a preset by name, or undefined if not found.
 */
export function getPreset(name: string): PresetConfig | undefined {
  return presets[name as PresetName]
}

/**
 * List all available presets.
 */
export function listPresets(): PresetConfig[] {
  return PRESET_NAMES.map((n) => presets[n])
}
