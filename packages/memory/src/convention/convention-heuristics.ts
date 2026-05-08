/**
 * Heuristic rules for convention detection without an LLM.
 *
 * Each rule defines a regex pattern plus a `test` function that decides
 * whether the rule applies to a given content snapshot. Rules are used by
 * `analyzeWithHeuristics` to surface common patterns (camelCase variables,
 * named imports, etc.) when no LLM is configured.
 */
import type { ConventionCategory } from './types.js'

export interface HeuristicRule {
  id: string
  name: string
  category: ConventionCategory
  description: string
  pattern: string
  test: (content: string) => boolean
}

export const HEURISTIC_RULES: HeuristicRule[] = [
  {
    id: 'naming-camelcase-vars',
    name: 'camelCase variables',
    category: 'naming',
    description: 'Use camelCase for local variable declarations',
    pattern: '\\b(const|let|var)\\s+[a-z][a-zA-Z0-9]*\\b',
    test: (content) => {
      const matches = content.match(/\b(?:const|let|var)\s+[a-z][a-zA-Z0-9]*\b/g)
      return (matches?.length ?? 0) >= 2
    },
  },
  {
    id: 'naming-pascalcase-classes',
    name: 'PascalCase classes',
    category: 'naming',
    description: 'Use PascalCase for class and interface names',
    pattern: '\\b(class|interface|type)\\s+[A-Z][a-zA-Z0-9]*\\b',
    test: (content) => {
      const matches = content.match(/\b(?:class|interface|type)\s+[A-Z][a-zA-Z0-9]*\b/g)
      return (matches?.length ?? 0) >= 1
    },
  },
  {
    id: 'imports-named',
    name: 'Named imports over default',
    category: 'imports',
    description: 'Prefer named imports over default imports',
    pattern: "import\\s+\\{[^}]+\\}\\s+from",
    test: (content) => {
      const named = content.match(/import\s+\{[^}]+\}\s+from/g)?.length ?? 0
      const defaultImport = content.match(/import\s+[A-Z]\w+\s+from/g)?.length ?? 0
      return named > 0 && named >= defaultImport
    },
  },
  {
    id: 'imports-esm-extension',
    name: 'ESM .js extension in imports',
    category: 'imports',
    description: 'Include .js extension in relative import paths',
    pattern: "from\\s+['\"]\\./.*\\.js['\"]",
    test: (content) => {
      const withExt = content.match(/from\s+['"]\.\/.*\.js['"]/g)?.length ?? 0
      return withExt >= 1
    },
  },
  {
    id: 'typing-no-any',
    name: 'No explicit any',
    category: 'typing',
    description: 'Avoid explicit use of `any` type annotations',
    pattern: ':\\s*any\\b',
    test: (content) => {
      const anyUsages = content.match(/:\s*any\b/g)?.length ?? 0
      return anyUsages === 0 && content.length > 50
    },
  },
  {
    id: 'error-handling-try-catch',
    name: 'Try-catch for async operations',
    category: 'error-handling',
    description: 'Wrap async operations in try-catch blocks',
    pattern: 'try\\s*\\{[\\s\\S]*?await[\\s\\S]*?\\}\\s*catch',
    test: (content) => {
      const tryCatchAsync = content.match(/try\s*\{[\s\S]*?await[\s\S]*?\}\s*catch/g)
      return (tryCatchAsync?.length ?? 0) >= 1
    },
  },
  {
    id: 'typing-explicit-return',
    name: 'Explicit return types',
    category: 'typing',
    description: 'Functions have explicit return type annotations',
    pattern: '\\)\\s*:\\s*\\w+',
    test: (content) => {
      const withReturn = content.match(/\)\s*:\s*(?:Promise<|void|string|number|boolean|\w+(?:\[\])?)\s*[{]/g)
      return (withReturn?.length ?? 0) >= 2
    },
  },
  {
    id: 'structure-export-const',
    name: 'Export const for functions',
    category: 'structure',
    description: 'Use export const for stateless functions',
    pattern: 'export\\s+const\\s+\\w+\\s*=',
    test: (content) => {
      const matches = content.match(/export\s+const\s+\w+\s*=/g)
      return (matches?.length ?? 0) >= 1
    },
  },
]
