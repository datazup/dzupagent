#!/usr/bin/env node

/**
 * create-dzupagent CLI entry point.
 *
 * Usage:
 *   create-dzupagent [project-name] [options]
 *   create-dzupagent                          # starts interactive wizard
 *   create-dzupagent my-app --template full-stack --features auth,billing
 *   create-dzupagent my-app --preset starter
 *   create-dzupagent --list
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command, Option } from 'commander'
import { colors, Spinner } from './logger.js'
import type {
  TemplateType,
  PackageManagerType,
  ProjectConfig,
  DatabaseProvider,
  AuthProvider,
} from './types.js'
import { listTemplates, templateRegistry } from './templates/index.js'
import { listPresets, getPreset } from './presets.js'
import { listFeatures } from './features.js'
import { generateProject } from './generator.js'
import { runWizard } from './wizard.js'
import { validateProjectName, getInstallCommand, getDevCommand } from './utils.js'
import { runSyncCommand, VALID_SYNC_TARGETS } from './sync.js'

const VALID_TEMPLATES = new Set(Object.keys(templateRegistry))

export interface CLIOptions {
  template?: string
  features?: string
  preset?: string
  git: boolean
  install: boolean
  wire: boolean
  packageManager?: string
  list?: boolean
  listPresets?: boolean
  listFeatures?: boolean
}

export function createProgram(): Command {
  const program = new Command()
  program
    .name('create-dzupagent')
    .description('Scaffold a new DzupAgent project from a template')
    .version('0.2.0')
    .argument('[project-name]', 'Name of the project directory to create')
    .option('-t, --template <type>', 'Template to use (default: minimal)')
    .option('-f, --features <list>', 'Comma-separated feature list (e.g. auth,billing,teams)')
    .option('-p, --preset <name>', 'Use a built-in preset (minimal, starter, full, api-only, research)')
    .option('--no-git', 'Skip git initialization')
    .option('--no-install', 'Skip dependency installation')
    .option('--wire', 'Wire scaffolded project into agent-adapters runtime', false)
    .option('--package-manager <pm>', 'Package manager: npm, yarn, or pnpm')
    .option('--list', 'List all available templates')
    .option('--list-presets', 'List all available presets')
    .option('--list-features', 'List all available features')
    .action(async (projectName: string | undefined, options: CLIOptions) => {
      try {
        await run(projectName, options)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(colors.red(`\nError: ${message}`))
        process.exit(1)
      }
    })

  program
    .command('sync <target>')
    .description(
      `Sync .dzupagent/ definitions into native agent files. Targets: ${VALID_SYNC_TARGETS.join(', ')}`,
    )
    .option('--execute', 'Apply the sync plan (default: plan-only preview)', false)
    .option('--force', 'Overwrite diverged files instead of skipping them', false)
    .option(
      '--dry-run',
      'Show the plan and diffs without writing any files (companion to --force)',
      false,
    )
    .addOption(
      new Option(
        '--dry-run-format <format>',
        'Output format for --dry-run diagnostics: console (default) or json',
      )
        .choices(['console', 'json'])
        .default('console'),
    )
    .option('--cwd <path>', 'Project root to sync (default: current working directory)')
    .action(
      async (
        target: string,
        options: {
          execute?: boolean
          force?: boolean
          dryRun?: boolean
          dryRunFormat?: 'console' | 'json'
          cwd?: string
        },
      ) => {
        try {
          await runSyncCommand(target, {
            execute: options.execute === true,
            force: options.force === true,
            dryRun: options.dryRun === true,
            ...(options.dryRunFormat !== undefined ? { dryRunFormat: options.dryRunFormat } : {}),
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(colors.red(`\nError: ${message}`))
          process.exit(1)
        }
      },
    )

  return program
}

export async function run(projectName: string | undefined, options: CLIOptions): Promise<void> {
  // --list: show templates
  if (options.list) {
    showTemplateList()
    return
  }

  // --list-presets: show presets
  if (options.listPresets) {
    showPresetList()
    return
  }

  // --list-features: show features
  if (options.listFeatures) {
    showFeatureList()
    return
  }

  // No project name and no other flags = interactive wizard
  if (!projectName && !options.template && !options.preset) {
    const config = await runWizard()
    await executeGeneration(config, options.wire)
    return
  }

  // CLI args mode — validate and build config
  if (!projectName) {
    console.error(colors.red('Error: Missing project name.'))
    console.error('Run create-dzupagent --help for usage.')
    process.exit(1)
  }

  const nameError = validateProjectName(projectName)
  if (nameError) {
    console.error(colors.red(`Error: ${nameError}`))
    process.exit(1)
  }

  // Resolve template
  let template: TemplateType = 'minimal'
  if (options.template) {
    if (!VALID_TEMPLATES.has(options.template)) {
      console.error(colors.red(`Error: Unknown template "${options.template}".`))
      console.error(`Valid templates: ${[...VALID_TEMPLATES].join(', ')}`)
      process.exit(1)
    }
    template = options.template as TemplateType
  }

  // Resolve features
  const features = options.features
    ? options.features.split(',').map((f) => f.trim()).filter(Boolean)
    : []

  // Resolve preset (overrides template + features)
  let database: DatabaseProvider = 'none'
  let authProvider: AuthProvider = 'none'

  if (options.preset) {
    const preset = getPreset(options.preset)
    if (!preset) {
      console.error(colors.red(`Error: Unknown preset "${options.preset}".`))
      console.error(`Valid presets: ${listPresets().map((p) => p.name).join(', ')}`)
      process.exit(1)
    }
    template = preset.template
    if (features.length === 0) {
      features.push(...preset.features)
    }
    database = preset.database
    authProvider = preset.auth
  }

  // Resolve package manager
  let packageManager: PackageManagerType = 'npm'
  if (options.packageManager) {
    if (!['npm', 'yarn', 'pnpm'].includes(options.packageManager)) {
      console.error(colors.red(`Error: Invalid package manager "${options.packageManager}".`))
      console.error('Valid options: npm, yarn, pnpm')
      process.exit(1)
    }
    packageManager = options.packageManager as PackageManagerType
  }

  const config: ProjectConfig = {
    projectName,
    template,
    features,
    database,
    authProvider,
    packageManager,
    initGit: options.git,
    installDeps: options.install,
  }

  await executeGeneration(config, options.wire)
}

async function executeGeneration(config: ProjectConfig, wire = false): Promise<void> {
  const outputDir = resolve(process.cwd())
  const spinner = new Spinner()

  console.log('')
  console.log(colors.bold(`Creating ${colors.cyan(config.projectName)} with template ${colors.cyan(config.template)}...`))
  if (config.features.length > 0) {
    console.log(colors.dim(`  Features: ${config.features.join(', ')}`))
  }
  console.log('')

  const result = await generateProject(config, outputDir, {
    onStep: (step) => {
      spinner.start(step)
    },
  }, { wire })

  spinner.succeed('Project created!')
  console.log('')

  console.log(colors.bold('Files created:'))
  for (const file of result.filesCreated) {
    console.log(colors.dim(`  ${file}`))
  }
  console.log('')

  if (result.gitInitialized) {
    console.log(colors.green('  Git repository initialized'))
  }
  if (result.depsInstalled) {
    console.log(colors.green('  Dependencies installed'))
  }
  if (result.wired) {
    console.log(colors.green('  Wired into agent-adapters runtime'))
  }

  console.log('')
  console.log(colors.bold('Next steps:'))
  console.log(`  ${colors.cyan(`cd ${config.projectName}`)}`)
  if (!result.depsInstalled) {
    console.log(`  ${colors.cyan(getInstallCommand(config.packageManager))}`)
  }
  console.log(`  ${colors.cyan('cp .env.example .env')}  ${colors.dim('# configure environment')}`)
  console.log(`  ${colors.cyan(getDevCommand(config.packageManager))}`)
  console.log('')
}

function showTemplateList(): void {
  const templates = listTemplates()
  console.log('')
  console.log(colors.bold('Available templates:'))
  console.log('')
  for (const t of templates) {
    console.log(`  ${colors.cyan(t.id.padEnd(28))} ${t.description}`)
  }
  console.log('')
}

function showPresetList(): void {
  const presetList = listPresets()
  console.log('')
  console.log(colors.bold('Available presets:'))
  console.log('')
  for (const p of presetList) {
    console.log(`  ${colors.cyan(p.name.padEnd(12))} ${p.description}`)
    console.log(`  ${' '.repeat(12)} Template: ${p.template}, Features: ${p.features.length > 0 ? p.features.join(', ') : 'none'}`)
  }
  console.log('')
}

function showFeatureList(): void {
  const featureList = listFeatures()
  console.log('')
  console.log(colors.bold('Available features:'))
  console.log('')
  for (const f of featureList) {
    console.log(`  ${colors.cyan(f.slug.padEnd(12))} ${f.description}`)
  }
  console.log('')
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram()
  await program.parseAsync(argv)
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void runCli()
}
