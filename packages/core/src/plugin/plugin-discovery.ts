import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * Describes a plugin's capabilities, metadata, and entry point.
 */
export interface PluginManifest {
  name: string
  version: string
  description: string
  author?: string
  capabilities: string[]
  dependencies?: string[]
  entryPoint: string
}

/**
 * A plugin discovered from a directory scan or builtin registration.
 */
export interface DiscoveredPlugin {
  manifest: PluginManifest
  path: string
  source: 'local' | 'npm' | 'builtin'
}

/**
 * Configuration for plugin discovery scanning.
 */
export interface PluginDiscoveryConfig {
  /** Directories to scan for plugin manifests. Defaults to ~/.dzupagent/plugins and ./dzupagent-plugins */
  localDirs?: string[]
  /** Builtin plugin manifests to include without scanning */
  builtinPlugins?: PluginManifest[]
}

const MANIFEST_FILENAME = 'dzupagent-plugin.json'

const REQUIRED_FIELDS: (keyof PluginManifest)[] = ['name', 'version', 'description', 'capabilities', 'entryPoint']

const DEFAULT_DIRS = [
  join(homedir(), '.dzupagent', 'plugins'),
  resolve('dzupagent-plugins'),
]

/**
 * Validate a plugin manifest object.
 * Returns field-level errors for any missing or malformed fields.
 */
export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (manifest === null || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be a non-null object'] }
  }

  const obj = manifest as Record<string, unknown>

  for (const field of REQUIRED_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      errors.push(`Missing required field "${field}"`)
    }
  }

  if (typeof obj['name'] === 'string' && obj['name'].length === 0) {
    errors.push('"name" must be non-empty')
  }
  if (obj['name'] !== undefined && typeof obj['name'] !== 'string') {
    errors.push('"name" must be a string')
  }
  if (obj['version'] !== undefined && typeof obj['version'] !== 'string') {
    errors.push('"version" must be a string')
  }
  if (obj['description'] !== undefined && typeof obj['description'] !== 'string') {
    errors.push('"description" must be a string')
  }
  if (obj['entryPoint'] !== undefined && typeof obj['entryPoint'] !== 'string') {
    errors.push('"entryPoint" must be a string')
  }
  if (obj['capabilities'] !== undefined && !Array.isArray(obj['capabilities'])) {
    errors.push('"capabilities" must be an array')
  }
  if (obj['dependencies'] !== undefined && !Array.isArray(obj['dependencies'])) {
    errors.push('"dependencies" must be an array')
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Scan configured directories for plugin manifests (dzupagent-plugin.json files).
 * Also includes any builtin plugins from config.
 */
export async function discoverPlugins(config?: PluginDiscoveryConfig): Promise<DiscoveredPlugin[]> {
  const dirs = config?.localDirs ?? DEFAULT_DIRS
  const discovered: DiscoveredPlugin[] = []

  // Add builtin plugins first
  if (config?.builtinPlugins) {
    for (const manifest of config.builtinPlugins) {
      discovered.push({ manifest, path: '<builtin>', source: 'builtin' })
    }
  }

  // Scan each directory
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // Directory does not exist or is inaccessible — skip silently
      continue
    }

    for (const entry of entries) {
      const manifestPath = join(dir, entry, MANIFEST_FILENAME)
      try {
        const raw = await readFile(manifestPath, 'utf-8')
        const parsed: unknown = JSON.parse(raw)
        const validation = validateManifest(parsed)
        if (validation.valid) {
          discovered.push({
            manifest: parsed as PluginManifest,
            path: join(dir, entry),
            source: 'local',
          })
        }
      } catch {
        // No manifest or invalid JSON — skip this entry
        continue
      }
    }
  }

  return discovered
}

/**
 * Resolve plugin load order via topological sort on declared dependencies.
 * Plugins without dependencies come first. Throws on circular dependencies.
 */
export function resolvePluginOrder(plugins: DiscoveredPlugin[]): DiscoveredPlugin[] {
  const byName = new Map<string, DiscoveredPlugin>()
  for (const p of plugins) {
    byName.set(p.manifest.name, p)
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const sorted: DiscoveredPlugin[] = []

  function visit(name: string): void {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      throw new Error(`Circular plugin dependency detected involving "${name}"`)
    }

    const plugin = byName.get(name)
    if (!plugin) return // External dependency — not in our set

    visiting.add(name)
    for (const dep of plugin.manifest.dependencies ?? []) {
      visit(dep)
    }
    visiting.delete(name)
    visited.add(name)
    sorted.push(plugin)
  }

  for (const p of plugins) {
    visit(p.manifest.name)
  }

  return sorted
}
