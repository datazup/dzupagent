import { basename } from 'node:path'
import type {
  ProjectConfig,
  TemplateType,
  DatabaseProvider,
  AuthProvider,
  PackageManagerType,
} from './types.js'
import { listTemplates } from './templates/index.js'
import { listFeatures } from './features.js'
import { listPresets } from './presets.js'
import { validateProjectName, detectPackageManager } from './utils.js'

/**
 * Run the interactive wizard to gather project configuration.
 *
 * Uses @inquirer/prompts for interactive terminal prompts.
 * Falls back gracefully if the terminal is non-interactive.
 */
export async function runWizard(): Promise<ProjectConfig> {
  // Dynamic import so the CLI binary works without @inquirer/prompts
  // when used in non-interactive (args-only) mode.
  const { input, select, checkbox, confirm } = await import('@inquirer/prompts')

  console.log('')
  console.log('  Welcome to create-forgeagent!')
  console.log('  Let\'s set up your new ForgeAgent project.')
  console.log('')

  // Step 1: Project name
  const defaultName = basename(process.cwd())
  const projectName = await input({
    message: 'Project name:',
    default: defaultName,
    validate: (value: string) => {
      const error = validateProjectName(value)
      return error ?? true
    },
  })

  // Step 1.5: Use a preset or customize?
  const presetConfigs = listPresets()
  const usePreset = await select<string>({
    message: 'Start from a preset or customize?',
    choices: [
      ...presetConfigs.map((p) => ({
        name: `${p.label} — ${p.description}`,
        value: p.name,
      })),
      { name: 'Custom — choose template and features manually', value: 'custom' },
    ],
  })

  if (usePreset !== 'custom') {
    const preset = presetConfigs.find((p) => p.name === usePreset)!
    const pm = detectPackageManager()

    const packageManager = await select<PackageManagerType>({
      message: 'Package manager:',
      choices: [
        { name: 'npm', value: 'npm' as const },
        { name: 'yarn', value: 'yarn' as const },
        { name: 'pnpm', value: 'pnpm' as const },
      ],
      default: pm,
    })

    const initGit = await confirm({ message: 'Initialize git repository?', default: true })
    const installDeps = await confirm({ message: 'Install dependencies now?', default: true })

    // Confirm
    console.log('')
    console.log(`  Project:    ${projectName}`)
    console.log(`  Preset:     ${preset.label}`)
    console.log(`  Template:   ${preset.template}`)
    console.log(`  Features:   ${preset.features.length > 0 ? preset.features.join(', ') : 'none'}`)
    console.log(`  Database:   ${preset.database}`)
    console.log(`  Auth:       ${preset.auth}`)
    console.log(`  Package Mgr: ${packageManager}`)
    console.log('')

    const proceed = await confirm({ message: 'Create project?', default: true })
    if (!proceed) {
      console.log('Aborted.')
      process.exit(0)
    }

    return {
      projectName,
      template: preset.template,
      features: preset.features,
      preset: preset.name,
      database: preset.database,
      authProvider: preset.auth,
      packageManager,
      initGit,
      installDeps,
    }
  }

  // Step 2: Template selection
  const templates = listTemplates()
  const template = await select<TemplateType>({
    message: 'Select a template:',
    choices: templates.map((t) => ({
      name: `${t.name} — ${t.description}`,
      value: t.id,
    })),
  })

  // Step 3: Feature selection
  const availableFeatures = listFeatures()
  const features = await checkbox<string>({
    message: 'Select features to include:',
    choices: availableFeatures.map((f) => ({
      name: `${f.name} — ${f.description}`,
      value: f.slug,
    })),
  })

  // Step 4: Configuration
  const database = await select<DatabaseProvider>({
    message: 'Database provider:',
    choices: [
      { name: 'PostgreSQL', value: 'postgres' as const },
      { name: 'SQLite', value: 'sqlite' as const },
      { name: 'None', value: 'none' as const },
    ],
  })

  const authProvider = await select<AuthProvider>({
    message: 'Authentication method:',
    choices: [
      { name: 'API Key', value: 'api-key' as const },
      { name: 'JWT', value: 'jwt' as const },
      { name: 'None', value: 'none' as const },
    ],
  })

  const detectedPm = detectPackageManager()
  const packageManager = await select<PackageManagerType>({
    message: 'Package manager:',
    choices: [
      { name: 'npm', value: 'npm' as const },
      { name: 'yarn', value: 'yarn' as const },
      { name: 'pnpm', value: 'pnpm' as const },
    ],
    default: detectedPm,
  })

  const initGit = await confirm({ message: 'Initialize git repository?', default: true })
  const installDeps = await confirm({ message: 'Install dependencies now?', default: true })

  // Step 5: Confirm
  console.log('')
  console.log(`  Project:    ${projectName}`)
  console.log(`  Template:   ${template}`)
  console.log(`  Features:   ${features.length > 0 ? features.join(', ') : 'none'}`)
  console.log(`  Database:   ${database}`)
  console.log(`  Auth:       ${authProvider}`)
  console.log(`  Package Mgr: ${packageManager}`)
  console.log('')

  const proceed = await confirm({ message: 'Create project?', default: true })
  if (!proceed) {
    console.log('Aborted.')
    process.exit(0)
  }

  return {
    projectName,
    template,
    features,
    database,
    authProvider,
    packageManager,
    initGit,
    installDeps,
  }
}
