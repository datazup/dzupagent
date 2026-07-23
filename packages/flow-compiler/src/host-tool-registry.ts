import type {
  HostToolRegistryEntry,
  ResolvedTool,
  ToolResolver,
  ToolsetCatalogEntry,
  ToolsetResolver,
} from '@dzupagent/flow-ast'
import { validateFlowToolSecurityPolicy } from '@dzupagent/flow-ast'

import type { CompilationDiagnostic } from './types.js'

export interface HostToolRegistryValidationResult {
  valid: boolean
  diagnostics: CompilationDiagnostic[]
}

export interface ToolSecurityReadinessResult {
  ready: boolean
  diagnostics: CompilationDiagnostic[]
}

export function validateHostToolRegistry(
  entries: readonly HostToolRegistryEntry[],
): HostToolRegistryValidationResult {
  const diagnostics: CompilationDiagnostic[] = []
  const seen = new Set<string>()

  entries.forEach((entry, index) => {
    const nodePath = `toolRegistry[${index}]`
    if (typeof entry.ref !== 'string' || entry.ref.length === 0) {
      diagnostics.push({
        stage: 3,
        code: 'INVALID_TOOL_REGISTRY_ENTRY',
        category: 'registry',
        message: 'Host tool registry entries require a non-empty ref.',
        nodePath: `${nodePath}.ref`,
      })
    } else if (seen.has(entry.ref)) {
      diagnostics.push({
        stage: 3,
        code: 'DUPLICATE_TOOL_REGISTRY_REF',
        category: 'registry',
        message: `Duplicate host tool registry ref: "${entry.ref}".`,
        nodePath: `${nodePath}.ref`,
      })
    } else {
      seen.add(entry.ref)
    }

    if (!['mcp-tool', 'skill', 'workflow', 'agent'].includes(entry.kind)) {
      diagnostics.push({
        stage: 3,
        code: 'INVALID_TOOL_REGISTRY_ENTRY',
        category: 'registry',
        message: `Invalid host tool registry kind for "${entry.ref}".`,
        nodePath: `${nodePath}.kind`,
      })
    }

    if (entry.securityPolicy !== undefined) {
      for (const issue of validateFlowToolSecurityPolicy(entry.securityPolicy)) {
        diagnostics.push({
          stage: 3,
          code: 'INVALID_TOOL_SECURITY_POLICY',
          category: 'policy',
          message: `Invalid security policy for "${entry.ref}": ${issue}.`,
          nodePath: `${nodePath}.securityPolicy`,
        })
      }
    }
  })

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  }
}

/**
 * Explain whether every published tool has a closed, valid security policy.
 * This does not mutate or activate a registry.
 */
export function resolveToolSecurityReadiness(
  entries: readonly HostToolRegistryEntry[],
): ToolSecurityReadinessResult {
  const diagnostics: CompilationDiagnostic[] = []
  entries.forEach((entry, index) => {
    const nodePath = `toolRegistry[${index}].securityPolicy`
    if (entry.securityPolicy === undefined) {
      diagnostics.push({
        stage: 3,
        code: 'TOOL_SECURITY_POLICY_MISSING',
        category: 'policy',
        message: `Tool "${entry.ref}" has no reviewed classification, credential, effect, output, and evidence policy.`,
        nodePath,
      })
      return
    }
    for (const issue of validateFlowToolSecurityPolicy(entry.securityPolicy)) {
      diagnostics.push({
        stage: 3,
        code: 'INVALID_TOOL_SECURITY_POLICY',
        category: 'policy',
        message: `Invalid security policy for "${entry.ref}": ${issue}.`,
        nodePath,
      })
    }
  })
  return { ready: diagnostics.length === 0, diagnostics }
}

export function createToolResolverFromRegistry(
  entries: readonly HostToolRegistryEntry[],
): ToolResolver {
  const byRef = new Map<string, ResolvedTool>()
  const aliasToRef = new Map<string, string>()

  for (const entry of entries) {
    if (typeof entry.ref !== 'string' || entry.ref.length === 0) continue
    const resolved: ResolvedTool = {
      ref: entry.ref,
      kind: entry.kind,
      inputSchema: entry.inputSchema,
      ...(entry.outputSchema !== undefined ? { outputSchema: entry.outputSchema } : {}),
      handle: entry.handle ?? { ref: entry.ref, kind: entry.kind },
      ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
      ...(entry.securityPolicy !== undefined ? { securityPolicy: entry.securityPolicy } : {}),
    }
    byRef.set(entry.ref, resolved)
    for (const alias of entry.aliases ?? []) {
      if (typeof alias === 'string' && alias.length > 0) {
        aliasToRef.set(alias, entry.ref)
      }
    }
  }

  return {
    resolve(ref: string) {
      const canonicalRef = aliasToRef.get(ref) ?? ref
      return byRef.get(canonicalRef) ?? null
    },
    listAvailable() {
      return [...byRef.keys(), ...aliasToRef.keys()].sort()
    },
  }
}

export interface ToolsetCatalogValidationResult {
  valid: boolean
  diagnostics: CompilationDiagnostic[]
}

/**
 * Lints a toolset catalogue for the most common authoring mistakes before
 * passing it to {@link createToolsetResolverFromCatalog}. Mirrors the shape
 * of {@link validateHostToolRegistry}.
 *
 * Currently checks:
 *   • non-empty `name`
 *   • duplicate names
 *   • `tools` is an array of non-empty strings
 *
 * Cross-validating that every expanded tool ref resolves through the host
 * tool registry is a deliberate non-goal here — the toolset catalogue is
 * authored independently of the tool registry, and Stage 3 already raises
 * UNRESOLVED_TOOL_REF for stray tools that survive expansion when the
 * action node references them.
 */
export function validateToolsetCatalog(
  entries: readonly ToolsetCatalogEntry[],
): ToolsetCatalogValidationResult {
  const diagnostics: CompilationDiagnostic[] = []
  const seen = new Set<string>()

  entries.forEach((entry, index) => {
    const nodePath = `toolsetCatalog[${index}]`
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      diagnostics.push({
        stage: 3,
        code: 'INVALID_TOOLSET_CATALOG_ENTRY',
        category: 'registry',
        message: 'Toolset catalogue entries require a non-empty name.',
        nodePath: `${nodePath}.name`,
      })
    } else if (seen.has(entry.name)) {
      diagnostics.push({
        stage: 3,
        code: 'DUPLICATE_TOOLSET_CATALOG_NAME',
        category: 'registry',
        message: `Duplicate toolset catalogue name: "${entry.name}".`,
        nodePath: `${nodePath}.name`,
      })
    } else {
      seen.add(entry.name)
    }

    if (!Array.isArray(entry.tools)) {
      diagnostics.push({
        stage: 3,
        code: 'INVALID_TOOLSET_CATALOG_ENTRY',
        category: 'registry',
        message: `Toolset "${entry.name}" must declare a tools array.`,
        nodePath: `${nodePath}.tools`,
      })
    } else {
      for (let i = 0; i < entry.tools.length; i++) {
        const tool = entry.tools[i]
        if (typeof tool !== 'string' || tool.length === 0) {
          diagnostics.push({
            stage: 3,
            code: 'INVALID_TOOLSET_CATALOG_ENTRY',
            category: 'registry',
            message: `Toolset "${entry.name}".tools[${i}] must be a non-empty string.`,
            nodePath: `${nodePath}.tools[${i}]`,
          })
        }
      }
    }
  })

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  }
}

/**
 * Build a {@link ToolsetResolver} backed by a static catalogue. Most callers
 * (tests, in-memory fixtures, codev-app's seed registry) should construct
 * their resolver via this helper rather than implementing the interface by
 * hand. Async-backed registries (DB, remote) should implement
 * {@link AsyncToolsetResolver} directly.
 */
export function createToolsetResolverFromCatalog(
  entries: readonly ToolsetCatalogEntry[],
): ToolsetResolver {
  const byName = new Map<string, readonly string[]>()
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || entry.name.length === 0) continue
    if (!Array.isArray(entry.tools)) continue
    byName.set(entry.name, [...entry.tools])
  }
  return {
    resolve(ref: string) {
      return byName.get(ref) ?? null
    },
    listAvailable() {
      return [...byName.keys()].sort()
    },
  }
}
