export type ToolProfile = 'default' | 'codegen' | 'git' | 'connectors' | 'full'

export interface ToolProfileConfig {
  enabledCategories: string[]
  enableMcp: boolean
  enableConnectors: boolean
  description: string
}

const TOOL_PROFILE_CONFIGS: Record<ToolProfile, ToolProfileConfig> = {
  default: {
    enabledCategories: ['git'],
    enableMcp: false,
    enableConnectors: false,
    description: 'Git tools only - no MCP, no connectors',
  },
  codegen: {
    enabledCategories: ['git', 'github'],
    enableMcp: false,
    enableConnectors: false,
    description: 'Git and GitHub tools for code generation workflows',
  },
  git: {
    enabledCategories: ['git', 'github'],
    enableMcp: false,
    enableConnectors: false,
    description: 'Git and GitHub tools only',
  },
  connectors: {
    enabledCategories: ['git', 'github', 'slack', 'http'],
    enableMcp: false,
    enableConnectors: true,
    description: 'Git plus all connectors - no MCP',
  },
  full: {
    enabledCategories: ['git', 'github', 'slack', 'http'],
    enableMcp: true,
    enableConnectors: true,
    description: 'All categories, MCP, and connectors enabled',
  },
}

export function getToolProfileConfig(profile: ToolProfile): ToolProfileConfig {
  return TOOL_PROFILE_CONFIGS[profile]
}

export function applyToolProfile(requested: Set<string>, profile: ToolProfile | undefined): void {
  if (!profile) return

  const profileConfig = getToolProfileConfig(profile)
  for (const category of profileConfig.enabledCategories) {
    requested.add(`${category}:*`)
  }
  if (profileConfig.enableMcp) {
    requested.add('mcp:*')
  }
}
