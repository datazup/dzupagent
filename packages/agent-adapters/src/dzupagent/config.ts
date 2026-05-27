/**
 * DzupAgent configuration loader.
 *
 * Loads and deep-merges `.dzupagent/config.json` from three tiers — the same
 * `global < workspace < project` precedence model used by the skill loader
 * (`file-loader.ts`):
 *
 *   1. ~/.dzupagent/config.json              (global user defaults)
 *   2. <workspace>/.dzupagent/config.json    (git-root level, when it differs)
 *   3. <project>/.dzupagent/config.json       (project overrides)
 *
 * The config exposes eight optional namespaces:
 *   $schema, provider, mcp, monitor, rules, privacy, codex, memory, sync
 *
 * Each namespace is shallow-merged across tiers (higher tier wins per key).
 * `$schema` is a scalar and is taken from the highest tier that defines it.
 * Existing `codex` / `memory` / `sync` callers keep working unchanged.
 *
 * Missing or malformed files are silently ignored (treated as empty config).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DzupAgentConfig, DzupAgentPaths } from '../types.js'
import { WorkspaceResolver } from './workspace-resolver.js'

/** Object namespaces that are shallow-merged across tiers. */
const OBJECT_NAMESPACES = [
  'provider',
  'mcp',
  'monitor',
  'rules',
  'privacy',
  'codex',
  'memory',
  'sync',
] as const

type ObjectNamespace = (typeof OBJECT_NAMESPACES)[number]

async function tryReadJson(filePath: string): Promise<DzupAgentConfig> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    // Guard against arrays / primitives masquerading as a config object.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return parsed as DzupAgentConfig
  } catch {
    return {}
  }
}

function mergeNamespace(
  base: DzupAgentConfig,
  override: DzupAgentConfig,
  ns: ObjectNamespace,
): Record<string, unknown> | undefined {
  const baseVal = base[ns] as Record<string, unknown> | undefined
  const overrideVal = override[ns] as Record<string, unknown> | undefined
  if (baseVal === undefined && overrideVal === undefined) return undefined
  return { ...baseVal, ...overrideVal }
}

/**
 * Deep-merge two configs with `override` taking precedence. Object namespaces
 * are shallow-merged per key; the scalar `$schema` is taken from `override`
 * when present, otherwise inherited from `base`.
 */
function mergeConfigs(base: DzupAgentConfig, override: DzupAgentConfig): DzupAgentConfig {
  const result: DzupAgentConfig = {}

  const schema = override.$schema ?? base.$schema
  if (schema !== undefined) result.$schema = schema

  for (const ns of OBJECT_NAMESPACES) {
    const merged = mergeNamespace(base, override, ns)
    if (merged !== undefined) {
      // Each namespace has a distinct value shape; the cast is safe because
      // mergeNamespace only ever combines values read from that same key.
      ;(result as Record<string, unknown>)[ns] = merged
    }
  }

  return result
}

/**
 * Load and merge DzupAgent config across global, workspace, and project tiers.
 *
 * The workspace tier is only applied when `paths.workspaceDir` is defined and
 * differs from the project directory — identical to the skill loader's tier
 * gate. Never throws — missing or malformed files contribute an empty config.
 */
export async function loadDzupAgentConfig(paths: DzupAgentPaths): Promise<DzupAgentConfig> {
  const globalConfigPath = join(paths.globalDir, 'config.json')

  // Workspace tier only when a distinct git-root .dzupagent/ exists.
  const wsDir = paths.workspaceDir
  const workspaceConfigPath =
    wsDir !== undefined && wsDir !== paths.projectDir
      ? join(wsDir, 'config.json')
      : undefined

  const [globalConfig, workspaceConfig, projectConfig] = await Promise.all([
    tryReadJson(globalConfigPath),
    workspaceConfigPath !== undefined ? tryReadJson(workspaceConfigPath) : Promise.resolve({}),
    tryReadJson(paths.projectConfig),
  ])

  // global < workspace < project
  return mergeConfigs(mergeConfigs(globalConfig, workspaceConfig), projectConfig)
}

/**
 * Convenience loader that resolves tier paths from a project directory.
 *
 * When `workspaceDir` is omitted, the workspace tier is derived via
 * {@link WorkspaceResolver} (git-root discovery). Pass `workspaceDir`
 * explicitly to override discovery, or pass the same value as `projectDir`
 * to skip the workspace tier entirely.
 *
 * Backward-compatible: callers that only know a project directory get the
 * full global < workspace < project merge with no extra wiring.
 */
export async function loadConfig(
  projectDir: string,
  workspaceDir?: string,
): Promise<DzupAgentConfig> {
  const resolver = new WorkspaceResolver()
  const paths = await resolver.resolve(projectDir)

  // Allow an explicit workspace override (e.g. monorepo roots that are not the
  // git root). When provided, build a paths record that points the workspace
  // tier at <workspaceDir>/.dzupagent/.
  if (workspaceDir !== undefined) {
    const overridden: DzupAgentPaths = {
      ...paths,
      workspaceDir: join(workspaceDir, '.dzupagent'),
    }
    return loadDzupAgentConfig(overridden)
  }

  return loadDzupAgentConfig(paths)
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
