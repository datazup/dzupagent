import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * Information about a registered plugin.
 */
export interface PluginInfo {
  name: string
  version: string
  status: 'active' | 'inactive' | 'error'
  manifestValid: boolean
}

/**
 * Minimal plugin manifest shape that addPlugin validates against.
 */
interface PluginManifest {
  name: string
  version: string
  entryPoint?: string
}

/**
 * Shape of the forge config file's plugin section.
 */
interface ForgeConfig {
  plugins?: Array<{ name: string; version: string }>
  [key: string]: unknown
}

function readConfig(configPath: string): ForgeConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }
  const raw = readFileSync(configPath, 'utf-8')
  return JSON.parse(raw) as ForgeConfig
}

function writeConfig(configPath: string, config: ForgeConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

function isValidManifest(manifest: unknown): manifest is PluginManifest {
  if (typeof manifest !== 'object' || manifest === null) return false
  const obj = manifest as Record<string, unknown>
  return typeof obj['name'] === 'string' && typeof obj['version'] === 'string'
}

/**
 * List all plugins registered in the config file.
 *
 * Reads the config, iterates the plugins array, and validates
 * each entry has a valid manifest structure.
 */
export function listPlugins(configPath: string): PluginInfo[] {
  const config = readConfig(configPath)
  const plugins = config.plugins ?? []

  return plugins.map((entry) => {
    const valid = isValidManifest(entry)
    return {
      name: entry.name,
      version: entry.version,
      status: valid ? 'active' as const : 'error' as const,
      manifestValid: valid,
    }
  })
}

/**
 * Add a plugin to the config file.
 *
 * Validates the plugin name is a non-empty string, checks for
 * duplicates, and appends to the plugins array.
 */
export function addPlugin(
  pluginName: string,
  configPath: string,
): { success: boolean; error?: string } {
  try {
    if (!pluginName || typeof pluginName !== 'string') {
      return { success: false, error: 'Plugin name must be a non-empty string' }
    }

    const config = readConfig(configPath)
    const plugins = config.plugins ?? []

    const existing = plugins.find((p) => p.name === pluginName)
    if (existing) {
      return { success: false, error: `Plugin "${pluginName}" is already registered` }
    }

    const manifest: PluginManifest = { name: pluginName, version: '0.1.0' }
    if (!isValidManifest(manifest)) {
      return { success: false, error: `Invalid manifest for plugin "${pluginName}"` }
    }

    plugins.push({ name: manifest.name, version: manifest.version })
    config.plugins = plugins
    writeConfig(configPath, config)

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}

/**
 * Remove a plugin from the config file.
 *
 * Finds the plugin by name and removes it from the plugins array.
 */
export function removePlugin(
  pluginName: string,
  configPath: string,
): { success: boolean; error?: string } {
  try {
    const config = readConfig(configPath)
    const plugins = config.plugins ?? []

    const index = plugins.findIndex((p) => p.name === pluginName)
    if (index === -1) {
      return { success: false, error: `Plugin "${pluginName}" not found in config` }
    }

    plugins.splice(index, 1)
    config.plugins = plugins
    writeConfig(configPath, config)

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}
