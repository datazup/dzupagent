/**
 * Plugin marketplace — search, filter, and display plugins from a registry.
 */

/**
 * A plugin available in the marketplace.
 */
export interface MarketplacePlugin {
  name: string
  version: string
  description: string
  author: string
  category: string
  tags: string[]
  verified: boolean
  downloads?: number
  repository?: string
}

/**
 * The full marketplace registry containing plugins and metadata.
 */
export interface MarketplaceRegistry {
  plugins: MarketplacePlugin[]
  categories: string[]
  lastUpdated: string
}

/**
 * Search the marketplace for plugins matching a query string.
 *
 * Matches against plugin name, description, and tags (case-insensitive).
 */
export function searchMarketplace(
  registry: MarketplaceRegistry,
  query: string,
): MarketplacePlugin[] {
  const lower = query.toLowerCase()
  return registry.plugins.filter((plugin) => {
    if (plugin.name.toLowerCase().includes(lower)) return true
    if (plugin.description.toLowerCase().includes(lower)) return true
    if (plugin.tags.some((tag) => tag.toLowerCase().includes(lower))) return true
    return false
  })
}

/**
 * Filter plugins by category (case-insensitive match).
 */
export function filterByCategory(
  registry: MarketplaceRegistry,
  category: string,
): MarketplacePlugin[] {
  const lower = category.toLowerCase()
  return registry.plugins.filter(
    (plugin) => plugin.category.toLowerCase() === lower,
  )
}

/**
 * Format a list of plugins as a terminal-friendly table string.
 */
export function formatPluginTable(plugins: MarketplacePlugin[]): string {
  if (plugins.length === 0) {
    return 'No plugins found.'
  }

  const header = {
    name: 'Name',
    version: 'Version',
    category: 'Category',
    author: 'Author',
    verified: 'Verified',
    downloads: 'Downloads',
  }

  // Compute column widths
  const colWidths = {
    name: Math.max(header.name.length, ...plugins.map((p) => p.name.length)),
    version: Math.max(header.version.length, ...plugins.map((p) => p.version.length)),
    category: Math.max(header.category.length, ...plugins.map((p) => p.category.length)),
    author: Math.max(header.author.length, ...plugins.map((p) => p.author.length)),
    verified: header.verified.length,
    downloads: Math.max(
      header.downloads.length,
      ...plugins.map((p) => String(p.downloads ?? '-').length),
    ),
  }

  function pad(value: string, width: number): string {
    return value.padEnd(width)
  }

  function formatRow(
    name: string,
    version: string,
    category: string,
    author: string,
    verified: string,
    downloads: string,
  ): string {
    return [
      pad(name, colWidths.name),
      pad(version, colWidths.version),
      pad(category, colWidths.category),
      pad(author, colWidths.author),
      pad(verified, colWidths.verified),
      pad(downloads, colWidths.downloads),
    ].join(' | ')
  }

  const headerRow = formatRow(
    header.name,
    header.version,
    header.category,
    header.author,
    header.verified,
    header.downloads,
  )

  const separator = [
    '-'.repeat(colWidths.name),
    '-'.repeat(colWidths.version),
    '-'.repeat(colWidths.category),
    '-'.repeat(colWidths.author),
    '-'.repeat(colWidths.verified),
    '-'.repeat(colWidths.downloads),
  ].join('-+-')

  const rows = plugins.map((plugin) =>
    formatRow(
      plugin.name,
      plugin.version,
      plugin.category,
      plugin.author,
      plugin.verified ? '[v]' : '[ ]',
      String(plugin.downloads ?? '-'),
    ),
  )

  return [headerRow, separator, ...rows].join('\n')
}

/**
 * Create a sample marketplace registry with 12 plugins across 6 categories.
 */
export function createSampleRegistry(): MarketplaceRegistry {
  const plugins: MarketplacePlugin[] = [
    {
      name: '@forge/otel-tracer',
      version: '1.2.0',
      description: 'OpenTelemetry tracing for DzipAgent runs and tool calls',
      author: 'ForgeTeam',
      category: 'observability',
      tags: ['tracing', 'opentelemetry', 'spans', 'metrics'],
      verified: true,
      downloads: 12450,
      repository: 'https://github.com/dzipagent/otel-tracer',
    },
    {
      name: '@forge/prom-metrics',
      version: '0.9.1',
      description: 'Prometheus metrics exporter for agent performance monitoring',
      author: 'ForgeTeam',
      category: 'observability',
      tags: ['prometheus', 'metrics', 'monitoring', 'grafana'],
      verified: true,
      downloads: 8320,
      repository: 'https://github.com/dzipagent/prom-metrics',
    },
    {
      name: '@forge/redis-memory',
      version: '2.0.0',
      description: 'Redis-backed memory store with TTL and pub/sub support',
      author: 'CacheWorks',
      category: 'memory',
      tags: ['redis', 'cache', 'memory', 'persistence'],
      verified: true,
      downloads: 15780,
      repository: 'https://github.com/cacheworks/forge-redis-memory',
    },
    {
      name: '@forge/qdrant-memory',
      version: '1.1.0',
      description: 'Qdrant vector store integration for semantic memory retrieval',
      author: 'VectorLabs',
      category: 'memory',
      tags: ['qdrant', 'vector', 'semantic', 'embeddings'],
      verified: true,
      downloads: 6240,
    },
    {
      name: '@forge/vault-secrets',
      version: '0.5.0',
      description: 'HashiCorp Vault integration for secure credential management',
      author: 'SecOps',
      category: 'security',
      tags: ['vault', 'secrets', 'credentials', 'encryption'],
      verified: true,
      downloads: 4100,
    },
    {
      name: '@forge/rbac-policies',
      version: '1.0.3',
      description: 'Fine-grained RBAC policy engine for agent authorization',
      author: 'SecOps',
      category: 'security',
      tags: ['rbac', 'authorization', 'policies', 'access-control'],
      verified: false,
      downloads: 2890,
    },
    {
      name: '@forge/ts-codegen',
      version: '3.1.0',
      description: 'TypeScript code generation with AST manipulation and formatting',
      author: 'CodeSmith',
      category: 'codegen',
      tags: ['typescript', 'codegen', 'ast', 'prettier'],
      verified: true,
      downloads: 21300,
      repository: 'https://github.com/codesmith/forge-ts-codegen',
    },
    {
      name: '@forge/prisma-gen',
      version: '1.4.2',
      description: 'Generate Prisma schemas and migrations from natural language',
      author: 'CodeSmith',
      category: 'codegen',
      tags: ['prisma', 'database', 'schema', 'migration'],
      verified: false,
      downloads: 3450,
    },
    {
      name: '@forge/slack-notifier',
      version: '2.0.1',
      description: 'Slack webhook notifications for agent events and approvals',
      author: 'IntegrationHub',
      category: 'integration',
      tags: ['slack', 'webhooks', 'notifications', 'chat'],
      verified: true,
      downloads: 9870,
    },
    {
      name: '@forge/github-actions',
      version: '1.3.0',
      description: 'GitHub Actions integration for CI/CD pipeline triggers',
      author: 'IntegrationHub',
      category: 'integration',
      tags: ['github', 'ci-cd', 'actions', 'automation'],
      verified: true,
      downloads: 7650,
    },
    {
      name: '@forge/snapshot-tests',
      version: '0.8.0',
      description: 'Snapshot testing for agent outputs with diff-based assertions',
      author: 'QualityFirst',
      category: 'testing',
      tags: ['testing', 'snapshots', 'assertions', 'diff'],
      verified: false,
      downloads: 1920,
    },
    {
      name: '@forge/eval-harness',
      version: '1.0.0',
      description: 'Evaluation harness for benchmarking agent accuracy and performance',
      author: 'QualityFirst',
      category: 'testing',
      tags: ['testing', 'evaluation', 'benchmarks', 'accuracy'],
      verified: true,
      downloads: 5340,
      repository: 'https://github.com/qualityfirst/forge-eval-harness',
    },
  ]

  const categories = [
    'observability',
    'memory',
    'security',
    'codegen',
    'integration',
    'testing',
  ]

  return {
    plugins,
    categories,
    lastUpdated: new Date().toISOString(),
  }
}
