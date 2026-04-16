import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ProjectConfig, GenerationResult } from './types.js'
import { getTemplate } from './templates/index.js'
import { renderTemplate } from './template-renderer.js'
import { generateEnvExample } from './templates/env-example.js'
import { generateDockerCompose } from './templates/docker-compose.js'
import { generateReadme } from './templates/readme.js'
import { generatePackageJson } from './templates/package-json.js'
import { installDependencies, initGitRepo, applyOverlay } from './utils.js'
import { getFeatureOverlay } from './features.js'
import { wireProject } from './bridge.js'

export interface GenerateCallbacks {
  onStep?: (step: string) => void
  onFileCreated?: (filePath: string) => void
}

/**
 * Generate a complete project from a ProjectConfig.
 *
 * This orchestrates the full pipeline: create directory, render template,
 * apply feature overlays, generate config files, init git, install deps.
 */
export interface GenerateOptions {
  /** Wire the scaffolded project into the agent-adapters runtime (default: false). */
  wire?: boolean
}

export async function generateProject(
  config: ProjectConfig,
  outputDir: string,
  callbacks?: GenerateCallbacks,
  options?: GenerateOptions,
): Promise<GenerationResult> {
  const { onStep, onFileCreated } = callbacks ?? {}
  const projectDir = join(outputDir, config.projectName)
  const filesCreated: string[] = []

  // Step 1: Create project directory
  onStep?.('Creating project directory...')
  await mkdir(projectDir, { recursive: true })

  // Step 2: Render base template files
  onStep?.('Rendering template files...')
  const manifest = getTemplate(config.template)
  const variables: Record<string, string> = {
    projectName: config.projectName,
    template: config.template,
  }

  // Write template files (skip package.json, .env.example, README.md — we generate those)
  const skipFiles = new Set(['package.json', '.env.example', 'README.md', 'docker-compose.yml'])

  for (const file of manifest.files) {
    if (skipFiles.has(file.path)) {
      continue
    }
    const renderedContent = renderTemplate(file.templateContent, variables)
    const filePath = join(projectDir, file.path)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, renderedContent, 'utf-8')
    filesCreated.push(file.path)
    onFileCreated?.(file.path)
  }

  // Step 3: Apply feature overlays
  onStep?.('Applying feature overlays...')
  for (const feature of config.features) {
    const overlay = getFeatureOverlay(feature)
    if (overlay && overlay.files) {
      const renderedFiles = overlay.files.map((f) => ({
        path: f.path,
        content: renderTemplate(f.templateContent, variables),
      }))
      const overlayCreated = await applyOverlay(projectDir, renderedFiles)
      filesCreated.push(...overlayCreated)
      for (const f of overlayCreated) {
        onFileCreated?.(f)
      }
    }
  }

  // Step 4: Generate package.json
  onStep?.('Generating package.json...')
  const pkgContent = generatePackageJson({
    projectName: config.projectName,
    database: config.database,
    features: config.features,
    packageManager: config.packageManager,
    templateDependencies: manifest.dependencies,
    templateDevDependencies: manifest.devDependencies,
  })
  await writeFile(join(projectDir, 'package.json'), pkgContent, 'utf-8')
  filesCreated.push('package.json')
  onFileCreated?.('package.json')

  // Step 5: Generate .env.example
  onStep?.('Generating .env.example...')
  const envContent = generateEnvExample({
    projectName: config.projectName,
    database: config.database,
    auth: config.authProvider,
    features: config.features,
  })
  await writeFile(join(projectDir, '.env.example'), envContent, 'utf-8')
  filesCreated.push('.env.example')
  onFileCreated?.('.env.example')

  // Step 6: Generate docker-compose.yml (if database or features need it)
  if (config.database !== 'none' || config.features.includes('ai')) {
    onStep?.('Generating docker-compose.yml...')
    const dockerContent = generateDockerCompose({
      projectName: config.projectName,
      database: config.database,
      features: config.features,
      includeQdrant: config.features.includes('ai'),
    })
    await writeFile(join(projectDir, 'docker-compose.yml'), dockerContent, 'utf-8')
    filesCreated.push('docker-compose.yml')
    onFileCreated?.('docker-compose.yml')
  }

  // Step 7: Generate README.md
  onStep?.('Generating README.md...')
  const readmeContent = generateReadme({
    projectName: config.projectName,
    template: config.template,
    features: config.features,
    database: config.database,
    auth: config.authProvider,
    packageManager: config.packageManager,
  })
  await writeFile(join(projectDir, 'README.md'), readmeContent, 'utf-8')
  filesCreated.push('README.md')
  onFileCreated?.('README.md')

  // Step 8: Initialize git repo
  let gitInitialized = false
  if (config.initGit) {
    onStep?.('Initializing git repository...')
    try {
      await initGitRepo(projectDir)
      gitInitialized = true
    } catch {
      // Git might not be installed — non-fatal
      gitInitialized = false
    }
  }

  // Step 9: Install dependencies
  let depsInstalled = false
  if (config.installDeps) {
    onStep?.(`Installing dependencies with ${config.packageManager}...`)
    try {
      await installDependencies(projectDir, config.packageManager)
      depsInstalled = true
    } catch {
      // Install failure — non-fatal, user can retry
      depsInstalled = false
    }
  }

  // Step 10: Wire into agent-adapters runtime (opt-in)
  let wired = false
  if (options?.wire) {
    onStep?.('Wiring project into agent-adapters runtime...')
    try {
      const wireResult = await wireProject({ projectDir })
      wired = wireResult.success
      if (!wireResult.success && wireResult.error) {
        // Non-fatal — log but don't throw
        onStep?.(`Wire warning: ${wireResult.error}`)
      }
    } catch {
      // Wire failure is non-fatal
      wired = false
    }
  }

  return {
    projectDir,
    filesCreated,
    template: config.template,
    features: config.features,
    packageManager: config.packageManager,
    gitInitialized,
    depsInstalled,
    wired,
  }
}
