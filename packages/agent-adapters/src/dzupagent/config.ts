/**
 * DzupAgent configuration loader.
 *
 * Loads and merges config from:
 *   1. ~/.dzupagent/config.json  (global user defaults)
 *   2. <project>/.dzupagent/config.json  (project overrides)
 *
 * Project values take precedence over global values.
 * Missing files are silently ignored (treated as empty config).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DzupAgentConfig, DzupAgentPaths } from '../types.js'

async function tryReadJson(filePath: string): Promise<DzupAgentConfig> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as DzupAgentConfig
  } catch {
    return {}
  }
}

function mergeConfigs(base: DzupAgentConfig, override: DzupAgentConfig): DzupAgentConfig {
  return {
    codex:
      base.codex !== undefined || override.codex !== undefined
        ? { ...base.codex, ...override.codex }
        : undefined,
    memory:
      base.memory !== undefined || override.memory !== undefined
        ? { ...base.memory, ...override.memory }
        : undefined,
    sync:
      base.sync !== undefined || override.sync !== undefined
        ? { ...base.sync, ...override.sync }
        : undefined,
  }
}

/**
 * Load and merge DzupAgent config from global and project locations.
 * Never throws — missing or malformed files return an empty config.
 */
export async function loadDzupAgentConfig(paths: DzupAgentPaths): Promise<DzupAgentConfig> {
  const globalConfigPath = join(paths.globalDir, 'config.json')
  const [globalConfig, projectConfig] = await Promise.all([
    tryReadJson(globalConfigPath),
    tryReadJson(paths.projectConfig),
  ])
  return mergeConfigs(globalConfig, projectConfig)
}

/**
 * Get the effective Codex memory strategy from a resolved config.
 * Falls back to 'inject-on-new-thread' when not configured.
 */
export function getCodexMemoryStrategy(
  config: DzupAgentConfig,
): NonNullable<NonNullable<DzupAgentConfig['codex']>['memoryStrategy']> {
  return config.codex?.memoryStrategy ?? 'inject-on-new-thread'
}

/**
 * Get the effective max memory token budget from a resolved config.
 * Falls back to 2000 tokens when not configured.
 */
export function getMaxMemoryTokens(config: DzupAgentConfig): number {
  return config.memory?.maxTokens ?? 2000
}
