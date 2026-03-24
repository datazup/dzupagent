/**
 * Multi-language code generation support with language-specific configurations.
 *
 * Provides detection, prompt fragments, and toolchain commands for each
 * supported language so the generation pipeline can adapt accordingly.
 */

export type SupportedLanguage = 'typescript' | 'python' | 'go' | 'rust' | 'java' | 'kotlin'

export interface LanguageConfig {
  language: SupportedLanguage
  /** File extensions for this language (including the dot) */
  extensions: string[]
  /** Prompt fragment with language-specific coding conventions */
  promptFragment: string
  /** Lint/check command */
  lintCommand: string
  /** Build command (if applicable) */
  buildCommand?: string
  /** Test command */
  testCommand: string
  /** Package manager */
  packageManager?: string
  /** Docker base image for sandbox */
  sandboxImage: string
  /** File detection patterns (e.g., package.json -> typescript) */
  detectionFiles: string[]
}

export const LANGUAGE_CONFIGS: Record<SupportedLanguage, LanguageConfig> = {
  typescript: {
    language: 'typescript',
    extensions: ['.ts', '.tsx'],
    promptFragment: [
      'Use TypeScript strict mode with no `any` types.',
      'Prefer `interface` for object shapes, `type` for unions/intersections.',
      'Use ESM imports (`import`/`export`), not CommonJS.',
      'Annotate return types on exported functions.',
      'Prefer `readonly` for immutable properties.',
    ].join('\n'),
    lintCommand: 'npx tsc --noEmit && npx eslint .',
    buildCommand: 'npx tsc',
    testCommand: 'npx vitest run',
    packageManager: 'npm',
    sandboxImage: 'node:20-slim',
    detectionFiles: ['package.json', 'tsconfig.json'],
  },

  python: {
    language: 'python',
    extensions: ['.py'],
    promptFragment: [
      'Use Python 3.12+ with type hints on all function signatures.',
      'Follow PEP 8 style; use `snake_case` for functions and variables.',
      'Prefer dataclasses or Pydantic models for structured data.',
      'Use `pathlib.Path` instead of `os.path` for file operations.',
      'Include docstrings on all public functions and classes.',
    ].join('\n'),
    lintCommand: 'python -m mypy . && python -m ruff check .',
    buildCommand: undefined,
    testCommand: 'python -m pytest',
    packageManager: 'pip',
    sandboxImage: 'python:3.12-slim',
    detectionFiles: ['requirements.txt', 'pyproject.toml', 'setup.py'],
  },

  go: {
    language: 'go',
    extensions: ['.go'],
    promptFragment: [
      'Follow effective Go idioms; handle errors explicitly, do not ignore them.',
      'Use short variable names in small scopes, descriptive names in larger ones.',
      'Return `error` as the last return value; use `fmt.Errorf` with `%w` for wrapping.',
      'Prefer composition over inheritance; embed structs for shared behavior.',
      'Document exported symbols with `// FuncName ...` style comments.',
    ].join('\n'),
    lintCommand: 'go vet ./... && golangci-lint run',
    buildCommand: 'go build ./...',
    testCommand: 'go test ./...',
    packageManager: 'go',
    sandboxImage: 'golang:1.22-alpine',
    detectionFiles: ['go.mod', 'go.sum'],
  },

  rust: {
    language: 'rust',
    extensions: ['.rs'],
    promptFragment: [
      'Use idiomatic Rust; prefer `Result<T, E>` over panics for recoverable errors.',
      'Derive `Debug`, `Clone`, and other common traits where appropriate.',
      'Use `impl` blocks for methods; keep public API surface minimal.',
      'Prefer `&str` over `String` in function parameters for flexibility.',
      'Write `/// doc` comments on public items; use `#[must_use]` where relevant.',
    ].join('\n'),
    lintCommand: 'cargo clippy -- -D warnings',
    buildCommand: 'cargo build',
    testCommand: 'cargo test',
    packageManager: 'cargo',
    sandboxImage: 'rust:1.77-slim',
    detectionFiles: ['Cargo.toml'],
  },

  java: {
    language: 'java',
    extensions: ['.java'],
    promptFragment: [
      'Target Java 21; use records for immutable data, sealed interfaces for ADTs.',
      'Follow standard Java naming: `PascalCase` classes, `camelCase` methods.',
      'Prefer `Optional<T>` over null returns for nullable values.',
      'Use `var` for local variables when the type is obvious from the right-hand side.',
      'Add Javadoc comments on all public classes and methods.',
    ].join('\n'),
    lintCommand: './gradlew check',
    buildCommand: './gradlew build',
    testCommand: './gradlew test',
    packageManager: 'gradle',
    sandboxImage: 'eclipse-temurin:21-jdk',
    detectionFiles: ['pom.xml', 'build.gradle'],
  },

  kotlin: {
    language: 'kotlin',
    extensions: ['.kt', '.kts'],
    promptFragment: [
      'Use idiomatic Kotlin; prefer `data class` for DTOs, `sealed class` for ADTs.',
      'Use null safety (`?`, `?.`, `?:`) instead of nullable platform types.',
      'Prefer extension functions for utility methods on existing types.',
      'Use `when` expressions instead of `if-else` chains for exhaustive checks.',
      'Follow Kotlin coding conventions: `camelCase` functions, `PascalCase` classes.',
    ].join('\n'),
    lintCommand: './gradlew ktlintCheck',
    buildCommand: './gradlew build',
    testCommand: './gradlew test',
    packageManager: 'gradle',
    sandboxImage: 'eclipse-temurin:21-jdk',
    detectionFiles: ['build.gradle.kts'],
  },
}

/**
 * Detect project language from a list of filenames present in the project root.
 * Returns the first language whose detection files match, or `null` if none match.
 * Priority order: typescript, python, go, rust, kotlin (before java), java.
 */
export function detectLanguageFromFiles(filenames: string[]): SupportedLanguage | null {
  const nameSet = new Set(filenames.map((f) => {
    const idx = f.lastIndexOf('/')
    return idx === -1 ? f : f.slice(idx + 1)
  }))

  // Kotlin must be checked before Java because build.gradle.kts is more specific
  const priority: SupportedLanguage[] = ['typescript', 'python', 'go', 'rust', 'kotlin', 'java']

  for (const lang of priority) {
    const config = LANGUAGE_CONFIGS[lang]
    const matched = config.detectionFiles.some((df) => nameSet.has(df))
    if (matched) return lang
  }

  return null
}

/**
 * Get the prompt fragment containing coding conventions for a language.
 */
export function getLanguagePrompt(language: SupportedLanguage): string {
  return LANGUAGE_CONFIGS[language].promptFragment
}
