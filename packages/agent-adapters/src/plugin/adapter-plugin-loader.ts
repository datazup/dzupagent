import { ForgeError } from '@dzupagent/core'
import type { AdapterProviderId } from '../types.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type { CostModelRegistry } from '../middleware/cost-models.js'
import type { AdapterPlugin } from './adapter-plugin-sdk.js'
import { isAdapterPlugin } from './adapter-plugin-sdk.js'

/**
 * Loads and registers adapter plugins from modules.
 *
 * Tracks plugin-to-adapter mapping so lifecycle operations (enable, disable,
 * unregister) do not need to recreate adapter instances.
 */
export class AdapterPluginLoader {
  private readonly loadedPlugins: AdapterPlugin[] = []
  /** Maps plugin id -> adapter providerId for lifecycle operations */
  private readonly pluginProviderMap = new Map<string, AdapterProviderId>()

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly costModels?: CostModelRegistry,
  ) {}

  /**
   * Load a plugin from a module path and register its adapter.
   * The module should export a default AdapterPlugin or an AdapterPlugin object.
   */
  async loadFromModule(modulePath: string, config?: Record<string, unknown>): Promise<AdapterPlugin> {
    let mod: Record<string, unknown>
    try {
      mod = await import(/* webpackIgnore: true */ modulePath) as Record<string, unknown>
    } catch (err) {
      throw new ForgeError({
        code: 'MISSING_DEPENDENCY',
        message: `Failed to load adapter plugin from "${modulePath}": ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      })
    }

    const plugin = (mod['default'] ?? mod) as unknown
    if (!isAdapterPlugin(plugin)) {
      throw new ForgeError({
        code: 'VALIDATION_FAILED',
        message: `Module "${modulePath}" does not export a valid adapter plugin. Use defineAdapterPlugin() to create one.`,
        recoverable: false,
      })
    }

    return this.registerPlugin(plugin, config)
  }

  /**
   * Register an already-loaded plugin.
   */
  registerPlugin(plugin: AdapterPlugin, config?: Record<string, unknown>): AdapterPlugin {
    const adapter = plugin.createAdapter(config)
    this.registry.register(adapter)

    if (plugin.costModel && this.costModels) {
      this.costModels.register(plugin.costModel)
    }

    this.pluginProviderMap.set(plugin.id, adapter.providerId)
    this.loadedPlugins.push(plugin)
    return plugin
  }

  /** List all loaded plugins */
  listPlugins(): AdapterPlugin[] {
    return [...this.loadedPlugins]
  }

  /** Get a loaded plugin by ID */
  getPlugin(id: string): AdapterPlugin | undefined {
    return this.loadedPlugins.find(p => p.id === id)
  }

  /**
   * Unregister a plugin by ID.
   * Calls the plugin's onUnload hook if defined, removes it from the loaded list,
   * and unregisters its adapter from the registry.
   * Returns false if the plugin was not found.
   */
  async unregisterPlugin(id: string): Promise<boolean> {
    const idx = this.loadedPlugins.findIndex(p => p.id === id)
    if (idx === -1) return false

    const plugin = this.loadedPlugins[idx] as AdapterPlugin

    // Call onUnload hook if defined
    if (plugin.onUnload) {
      await plugin.onUnload()
    }

    this.loadedPlugins.splice(idx, 1)

    const providerId = this.pluginProviderMap.get(id)
    if (providerId) {
      this.registry.unregister(providerId)
      this.pluginProviderMap.delete(id)
    }

    return true
  }

  /**
   * Disable a plugin's adapter in the registry.
   * The plugin remains loaded but its adapter will not be selected for execution.
   * Returns false if the plugin was not found.
   */
  disablePlugin(id: string): boolean {
    const providerId = this.pluginProviderMap.get(id)
    if (!providerId) return false
    return this.registry.disable(providerId)
  }

  /**
   * Enable a plugin's adapter in the registry.
   * Returns false if the plugin was not found.
   */
  enablePlugin(id: string): boolean {
    const providerId = this.pluginProviderMap.get(id)
    if (!providerId) return false
    return this.registry.enable(providerId)
  }

  /**
   * Check whether a plugin's adapter is currently enabled in the registry.
   * Returns false if the plugin is not found or is disabled.
   */
  isPluginEnabled(id: string): boolean {
    const providerId = this.pluginProviderMap.get(id)
    if (!providerId) return false
    return this.registry.isEnabled(providerId)
  }
}
