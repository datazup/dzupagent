/**
 * Layering Rule — enforces package dependency direction.
 *
 * Prevents lower-level packages from importing higher-level ones.
 * For example, @dzipagent/core must not import from @dzipagent/agent.
 */

import type { GuardrailRule, GuardrailContext, GuardrailResult, GuardrailViolation } from '../guardrail-types.js'

/** Default dependency layers: lower index = lower level. */
const DEFAULT_LAYERS: string[][] = [
  ['@dzipagent/core'],
  ['@dzipagent/memory', '@dzipagent/context', '@dzipagent/codegen'],
  ['@dzipagent/agent'],
  ['@dzipagent/server'],
]

function resolvePackageFromPath(
  filePath: string,
  packages: Map<string, { name: string; dir: string }>,
): string | undefined {
  for (const [, info] of packages) {
    if (filePath.startsWith(info.dir)) {
      return info.name
    }
  }
  return undefined
}

function getLayerIndex(packageName: string, layers: string[][]): number {
  for (let i = 0; i < layers.length; i++) {
    if (layers[i]!.includes(packageName)) return i
  }
  return -1
}

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|[^;'"]*)\s+from\s+['"]([^'"]+)['"]/

export function createLayeringRule(customLayers?: string[][]): GuardrailRule {
  const layers = customLayers ?? DEFAULT_LAYERS

  return {
    id: 'layering',
    name: 'LayeringRule',
    description: 'Enforces dependency direction between packages (core -> agent -> server)',
    severity: 'error',
    category: 'layering',
    check(context: GuardrailContext): GuardrailResult {
      const violations: GuardrailViolation[] = []

      for (const file of context.files) {
        const sourcePackage = resolvePackageFromPath(file.path, context.projectStructure.packages)
        if (!sourcePackage) continue

        const sourceLayer = getLayerIndex(sourcePackage, layers)
        if (sourceLayer < 0) continue

        const lines = file.content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          const match = IMPORT_RE.exec(line)
          if (!match) continue

          const importPath = match[1]!
          // Only check scoped package imports
          if (!importPath.startsWith('@')) continue

          const targetLayer = getLayerIndex(importPath, layers)
          if (targetLayer < 0) continue

          if (targetLayer > sourceLayer) {
            violations.push({
              ruleId: 'layering',
              file: file.path,
              line: i + 1,
              message: `Package "${sourcePackage}" (layer ${sourceLayer}) imports "${importPath}" (layer ${targetLayer}). Higher-layer packages must not be imported by lower-layer packages.`,
              severity: 'error',
              suggestion: `Move the shared code to a lower-level package or invert the dependency with an interface.`,
              autoFixable: false,
            })
          }
        }
      }

      return { passed: violations.length === 0, violations }
    },
  }
}
