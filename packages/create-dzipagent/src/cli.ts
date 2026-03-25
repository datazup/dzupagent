#!/usr/bin/env node

/**
 * create-forgeagent CLI entry point.
 *
 * Usage:
 *   create-forgeagent <project-name> [--template <type>]
 *   create-forgeagent --list
 *   create-forgeagent --help
 */

import { resolve } from 'node:path'
import { ScaffoldEngine } from './scaffold-engine.js'
import { listTemplates } from './templates/index.js'
import type { TemplateType } from './types.js'

const VALID_TEMPLATES: ReadonlySet<string> = new Set<TemplateType>([
  'minimal',
  'full-stack',
  'codegen',
  'multi-agent',
  'server',
])

const HELP_TEXT = `
Usage: create-forgeagent <project-name> [options]

Scaffold a new ForgeAgent project from a template.

Arguments:
  project-name          Name of the project directory to create

Options:
  --template <type>     Template to use (default: minimal)
  --list                List all available templates
  --help                Show this help message

Templates:
  minimal               Minimal single-agent setup
  full-stack            Full-stack agent with memory, context, and server
  codegen               Code generation agent with git tools
  multi-agent           Multi-agent orchestration with supervisor
  server                Standalone agent server with REST API

Examples:
  create-forgeagent my-agent
  create-forgeagent my-agent --template full-stack
  create-forgeagent --list
`.trim()

function parseArgs(argv: string[]): {
  command: 'help' | 'list' | 'generate'
  projectName?: string
  template: TemplateType
} {
  // Strip node binary and script path
  const args = argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { command: 'help', template: 'minimal' }
  }

  if (args.includes('--list')) {
    return { command: 'list', template: 'minimal' }
  }

  let projectName: string | undefined
  let template: TemplateType = 'minimal'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--template' || arg === '-t') {
      const next = args[i + 1]
      if (!next) {
        console.error('Error: --template requires a value.')
        console.error(`Valid templates: ${[...VALID_TEMPLATES].join(', ')}`)
        process.exit(1)
      }
      if (!VALID_TEMPLATES.has(next)) {
        console.error(`Error: Unknown template "${next}".`)
        console.error(`Valid templates: ${[...VALID_TEMPLATES].join(', ')}`)
        process.exit(1)
      }
      template = next as TemplateType
      i++ // skip next arg (the template value)
    } else if (arg?.startsWith('--')) {
      console.error(`Error: Unknown option "${arg}".`)
      console.error('Run create-forgeagent --help for usage.')
      process.exit(1)
    } else if (!projectName) {
      projectName = arg
    } else {
      console.error(`Error: Unexpected argument "${arg}".`)
      console.error('Run create-forgeagent --help for usage.')
      process.exit(1)
    }
  }

  if (!projectName) {
    console.error('Error: Missing project name.')
    console.error('Run create-forgeagent --help for usage.')
    process.exit(1)
  }

  return { command: 'generate', projectName, template }
}

function showList(): void {
  const templates = listTemplates()
  console.log('Available templates:\n')
  for (const t of templates) {
    console.log(`  ${t.id.padEnd(16)} ${t.description}`)
  }
  console.log('')
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv)

  if (parsed.command === 'help') {
    console.log(HELP_TEXT)
    return
  }

  if (parsed.command === 'list') {
    showList()
    return
  }

  const projectName = parsed.projectName!
  const outputDir = resolve(process.cwd())

  console.log(`\nScaffolding "${projectName}" with template "${parsed.template}"...\n`)

  const engine = new ScaffoldEngine()
  const result = await engine.generate({
    projectName,
    template: parsed.template,
    outputDir,
  })

  console.log(`Project created at ${result.projectDir}\n`)
  console.log('Files created:')
  for (const file of result.filesCreated) {
    console.log(`  ${file}`)
  }
  console.log('')
  console.log('Next steps:')
  console.log(`  cd ${projectName}`)
  console.log('  npm install')
  console.log('  npm run build')
  console.log('')
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`Error: ${message}`)
  process.exit(1)
})
