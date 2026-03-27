import type { DatabaseProvider, PackageManagerType } from '../types.js'

export interface PackageJsonOptions {
  projectName: string
  database: DatabaseProvider
  features: string[]
  packageManager: PackageManagerType
  /** Additional dependencies from the template manifest */
  templateDependencies?: Record<string, string>
  /** Additional dev dependencies from the template manifest */
  templateDevDependencies?: Record<string, string>
}

/**
 * Generate a package.json string for the scaffolded project.
 */
export function generatePackageJson(options: PackageJsonOptions): string {
  const scripts: Record<string, string> = {
    build: 'tsup',
    start: 'node dist/index.js',
    dev: 'tsx watch src/index.ts',
    typecheck: 'tsc --noEmit',
    lint: 'eslint src/',
    test: 'vitest run',
  }

  if (options.database === 'postgres') {
    scripts['db:push'] = 'drizzle-kit push'
    scripts['db:generate'] = 'drizzle-kit generate'
  }

  const dependencies: Record<string, string> = {
    '@forgeagent/core': '^0.1.0',
    '@forgeagent/agent': '^0.1.0',
    ...buildFeatureDependencies(options.features, options.database),
    ...(options.templateDependencies ?? {}),
  }

  const devDependencies: Record<string, string> = {
    typescript: '^5.4.0',
    tsup: '^8.0.0',
    tsx: '^4.0.0',
    vitest: '^2.0.0',
    ...(options.templateDevDependencies ?? {}),
  }

  if (options.database === 'postgres') {
    devDependencies['drizzle-kit'] = '^0.28.0'
  }

  const pkg = {
    name: options.projectName,
    version: '0.1.0',
    type: 'module',
    scripts,
    dependencies: sortObject(dependencies),
    devDependencies: sortObject(devDependencies),
  }

  return JSON.stringify(pkg, null, 2) + '\n'
}

function buildFeatureDependencies(
  features: string[],
  database: DatabaseProvider,
): Record<string, string> {
  const deps: Record<string, string> = {}

  if (features.includes('auth') || features.includes('dashboard') || features.includes('ai')) {
    deps['@forgeagent/server'] = '^0.1.0'
  }

  if (features.includes('ai')) {
    deps['@forgeagent/memory'] = '^0.1.0'
    deps['@forgeagent/context'] = '^0.1.0'
  }

  if (database === 'postgres') {
    deps['drizzle-orm'] = '^0.36.0'
  }

  if (features.includes('billing')) {
    deps['stripe'] = '^17.0.0'
  }

  if (features.includes('ai') || features.includes('billing')) {
    deps['bullmq'] = '^5.0.0'
    deps['ioredis'] = '^5.4.0'
  }

  return deps
}

function sortObject(obj: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key]!
  }
  return sorted
}
