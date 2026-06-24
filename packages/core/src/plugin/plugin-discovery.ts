import { readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readTextFileOrDefault } from '../utils/file-utils.js'

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
  source?: 'local' | 'npm' | 'builtin'
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

export interface ResolvePluginOrderOptions {
  /** Default false. When true, later duplicates override earlier entries. */
  allowNameConflicts?: boolean
}

export interface PluginNameConflictDiagnostic {
  signal: 'plugin_registration_conflict_count'
  name: string
  source: DiscoveredPlugin['source']
  path: string
  previousSource: DiscoveredPlugin['source']
  previousPath: string
}

export class PluginNameConflictError extends Error {
  readonly diagnostic: PluginNameConflictDiagnostic

  constructor(diagnostic: PluginNameConflictDiagnostic) {
    super(
      `Duplicate plugin name "${diagnostic.name}" detected ` +
      `(new: ${diagnostic.source}:${diagnostic.path}; existing: ${diagnostic.previousSource}:${diagnostic.previousPath})`,
    )
    this.name = 'PluginNameConflictError'
    this.diagnostic = diagnostic
  }
}

const MANIFEST_FILENAME = 'dzupagent-plugin.json'

const REQUIRED_FIELDS: (keyof PluginManifest)[] = ['name', 'version', 'description', 'capabilities', 'entryPoint']

const DEFAULT_DIRS = [
  join(homedir(), '.dzupagent', 'plugins'),
  resolve('dzupagent-plugins'),
]

function isValidSemver(version: string): boolean {
  const parts = version.split('.')
  if (parts.length < 3) return false
  const [major, minor, patchAndRest] = parts
  if (!major || !minor || !patchAndRest) return false
  if (!/^\d+$/.test(major) || !/^\d+$/.test(minor)) return false
  const patch = patchAndRest.split('-')[0]?.split('+')[0] ?? ''
  return /^\d+$/.test(patch)
}
const ALLOWED_MANIFEST_SOURCES = new Set<NonNullable<PluginManifest['source']>>(['local', 'npm', 'builtin'])

function validateStringArray(
  value: unknown,
  fieldName: 'capabilities' | 'dependencies',
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`"${fieldName}" must be an array`)
    return
  }

  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`"${fieldName}[${i}]" must be a non-empty string`)
    }
  }
}

function validateEntryPoint(entryPoint: string, errors: string[]): void {
  const normalized = entryPoint.replace(/\\/g, '/')
  if (normalized.trim().length === 0) {
    errors.push('"entryPoint" must be non-empty')
    return
  }

  if (isAbsolute(normalized) || /^[A-Za-z]:[\\/]/.test(normalized)) {
    errors.push('"entryPoint" must be a relative path')
  }

  if (normalized.split('/').includes('..')) {
    errors.push('"entryPoint" must not contain parent-directory traversal ("..")')
  }
}

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

  if (typeof obj['name'] === 'string' && obj['name'].trim().length === 0) {
    errors.push('"name" must be non-empty')
  }
  if (obj['name'] !== undefined && typeof obj['name'] !== 'string') {
    errors.push('"name" must be a string')
  }

  if (typeof obj['version'] === 'string' && !isValidSemver(obj['version'])) {
    errors.push('"version" must be valid semver')
  }
  if (obj['version'] !== undefined && typeof obj['version'] !== 'string') {
    errors.push('"version" must be a string')
  }

  if (typeof obj['description'] === 'string' && obj['description'].trim().length === 0) {
    errors.push('"description" must be non-empty')
  }
  if (obj['description'] !== undefined && typeof obj['description'] !== 'string') {
    errors.push('"description" must be a string')
  }

  if (obj['author'] !== undefined && typeof obj['author'] !== 'string') {
    errors.push('"author" must be a string')
  }

  if (typeof obj['entryPoint'] === 'string') {
    validateEntryPoint(obj['entryPoint'], errors)
  } else if (obj['entryPoint'] !== undefined) {
    errors.push('"entryPoint" must be a string')
  }

  if (obj['capabilities'] !== undefined) {
    validateStringArray(obj['capabilities'], 'capabilities', errors)
  }
  if (obj['dependencies'] !== undefined) {
    validateStringArray(obj['dependencies'], 'dependencies', errors)
  }

  if (obj['source'] !== undefined) {
    if (typeof obj['source'] !== 'string' || !ALLOWED_MANIFEST_SOURCES.has(obj['source'] as NonNullable<PluginManifest['source']>)) {
      errors.push('"source" must be one of: local, npm, builtin')
    }
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
      // Missing manifest (ENOENT) is the common case for non-plugin dir
      // entries — skip it. Other IO errors (permission denied) propagate.
      const raw = await readTextFileOrDefault<null>(manifestPath, null)
      if (raw === null) continue
      try {
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
        // Invalid JSON — skip this entry
        continue
      }
    }
  }

  return discovered
}

function conflictDiagnostic(current: DiscoveredPlugin, previous: DiscoveredPlugin): PluginNameConflictDiagnostic {
  return {
    signal: 'plugin_registration_conflict_count',
    name: current.manifest.name,
    source: current.source,
    path: current.path,
    previousSource: previous.source,
    previousPath: previous.path,
  }
}

/**
 * Resolve plugin load order via topological sort on declared dependencies.
 * Plugins without dependencies come first. Throws on circular dependencies.
 */
export function resolvePluginOrder(
  plugins: DiscoveredPlugin[],
  options?: ResolvePluginOrderOptions,
): DiscoveredPlugin[] {
  const byName = new Map<string, DiscoveredPlugin>()
  const allowNameConflicts = options?.allowNameConflicts ?? false

  for (const p of plugins) {
    const existing = byName.get(p.manifest.name)
    if (existing && !allowNameConflicts) {
      throw new PluginNameConflictError(conflictDiagnostic(p, existing))
    }
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

