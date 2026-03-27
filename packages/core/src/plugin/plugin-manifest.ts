import type { PluginManifest } from './plugin-discovery.js'

/**
 * Create a minimal plugin manifest with sensible defaults.
 */
export function createManifest(opts: {
  name: string
  version: string
  description: string
  capabilities?: string[]
  author?: string
  dependencies?: string[]
  entryPoint?: string
}): PluginManifest {
  return {
    name: opts.name,
    version: opts.version,
    description: opts.description,
    author: opts.author,
    capabilities: opts.capabilities ?? [],
    dependencies: opts.dependencies,
    entryPoint: opts.entryPoint ?? './index.js',
  }
}

/**
 * Serialize a plugin manifest to a formatted JSON string.
 */
export function serializeManifest(manifest: PluginManifest): string {
  return JSON.stringify(manifest, null, 2)
}
