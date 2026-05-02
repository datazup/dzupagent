import type {
  HostToolRegistryEntry,
  ResolvedTool,
  ToolResolver,
} from '@dzupagent/flow-ast'

import type { CompilationDiagnostic } from './types.js'

export interface HostToolRegistryValidationResult {
  valid: boolean
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
  })

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  }
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
