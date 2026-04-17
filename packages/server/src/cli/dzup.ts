#!/usr/bin/env node
/**
 * dzup — DzupAgent unified CLI
 *
 * Entry point for the @dzupagent/server CLI binary.
 * Thin wrapper that delegates to the existing CLI command modules.
 */
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json')
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg: { version?: string } = JSON.parse(raw) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function createProgram(): Command {
  const program = new Command()
    .name('dzup')
    .description('DzupAgent CLI — manage and run AI agents')
    .version(getVersion())

  // ---- dev ----
  program
    .command('dev')
    .description('Start the DzupAgent development server')
    .option('-p, --port <number>', 'Port to listen on', '4000')
    .option('-v, --verbose', 'Enable verbose trace output', false)
    .action(async (opts: { port: string; verbose: boolean }) => {
      try {
        const { createDevCommand } = await import('./dev-command.js')
        const cmd = createDevCommand({
          port: parseInt(opts.port, 10),
          verbose: opts.verbose,
        })
        await cmd.start()
      } catch (err) {
        console.error(`[dzup] dev failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- list ----
  program
    .command('list')
    .description('List registered agents')
    .option('-f, --format <format>', 'Output format (json or table)', 'table')
    .action(async (opts: { format: string }) => {
      try {
        console.log(opts.format === 'json' ? '[]' : 'No agents registered. Use `dzup dev` to start the server and register agents via the API.')
      } catch (err) {
        console.error(`[dzup] list failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- run ----
  program
    .command('run')
    .description('Run an agent by ID')
    .argument('<agent-id>', 'Agent ID to run')
    .option('-i, --input <text>', 'Input text for the agent')
    .action(async (agentId: string, _opts: { input?: string }) => {
      try {
        console.log(`Agent: ${agentId}`)
        console.log('Use `dzup dev` to run agents via the REST API.')
      } catch (err) {
        console.error(`[dzup] run failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- doctor ----
  program
    .command('doctor')
    .description('Run system diagnostics')
    .option('--json', 'Output raw JSON report', false)
    .option('--fix', 'Attempt auto-fixes for common issues', false)
    .action(async (opts: { json: boolean; fix: boolean }) => {
      try {
        const { runDoctor, formatDoctorReport, formatDoctorReportJSON } = await import('./doctor.js')
        const report = await runDoctor({}, { json: opts.json, fix: opts.fix })
        console.log(opts.json ? formatDoctorReportJSON(report) : formatDoctorReport(report))
      } catch (err) {
        console.error(`[dzup] doctor failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- vectordb ----
  const vectordbCmd = program
    .command('vectordb')
    .description('Vector database management')

  vectordbCmd
    .command('status')
    .description('Check vector DB connectivity and report status')
    .action(async () => {
      try {
        console.log('Vector DB status requires a running server. Use `dzup dev` and call GET /api/health/ready.')
      } catch (err) {
        console.error(`[dzup] vectordb status failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- scorecard ----
  program
    .command('scorecard')
    .description('Generate an integration scorecard')
    .option('-a, --agent <id>', 'Agent ID to score')
    .option('-f, --format <format>', 'Output format (console, json, markdown)', 'console')
    .option('-o, --output <path>', 'Write output to a file')
    .action(async (opts: { agent?: string; format: string; output?: string }) => {
      try {
        console.log(`Scorecard generation requires a server config. Use \`dzup dev\` and call the scorecard API.`)
        if (opts.agent) {
          console.log(`Agent filter: ${opts.agent}`)
        }
      } catch (err) {
        console.error(`[dzup] scorecard failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- trace ----
  program
    .command('trace')
    .description('Print event traces for a run')
    .option('-r, --run <id>', 'Run ID to trace')
    .option('-v, --verbose', 'Include full event data', false)
    .action(async (opts: { run?: string; verbose: boolean }) => {
      try {
        console.log(`Trace printer requires a running event bus. Use \`dzup dev --verbose\` for live tracing.`)
        if (opts.run) {
          console.log(`Run filter: ${opts.run}`)
        }
      } catch (err) {
        console.error(`[dzup] trace failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- config ----
  const configCmd = program
    .command('config')
    .description('Manage DzupAgent configuration')

  configCmd
    .command('get')
    .description('Get a configuration value')
    .argument('<key>', 'Configuration key')
    .option('-c, --config <path>', 'Config file path', 'dzupagent.config.json')
    .action(async (key: string, opts: { config: string }) => {
      try {
        const { configShow } = await import('./config-command.js')
        const config = configShow(opts.config)
        const value = config[key]
        if (value === undefined) {
          console.log(`Key "${key}" is not set.`)
        } else {
          console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value))
        }
      } catch (err) {
        console.error(`[dzup] config get failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  configCmd
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Configuration key')
    .argument('<value>', 'Configuration value')
    .option('-c, --config <path>', 'Config file path', 'dzupagent.config.json')
    .action(async (key: string, value: string, _opts: { config: string }) => {
      try {
        console.log(`Setting ${key} = ${value} (config file write not yet implemented)`)
      } catch (err) {
        console.error(`[dzup] config set failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  configCmd
    .command('validate')
    .description('Validate a configuration file')
    .option('-c, --config <path>', 'Config file path', 'dzupagent.config.json')
    .action(async (opts: { config: string }) => {
      try {
        const { configValidate } = await import('./config-command.js')
        const result = configValidate(opts.config)
        if (result.valid) {
          console.log('Configuration is valid.')
        } else {
          console.error('Configuration errors:')
          for (const error of result.errors) {
            console.error(`  - ${error}`)
          }
          process.exit(1)
        }
      } catch (err) {
        console.error(`[dzup] config validate failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- mcp ----
  const mcpCmd = program
    .command('mcp')
    .description('Manage MCP servers')

  mcpCmd
    .command('list')
    .description('List registered MCP servers')
    .action(async () => {
      try {
        console.log('MCP server management requires a running server. Use `dzup dev` and call the MCP API.')
      } catch (err) {
        console.error(`[dzup] mcp list failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- plugins ----
  const pluginsCmd = program
    .command('plugins')
    .description('Manage plugins')

  pluginsCmd
    .command('list')
    .description('List registered plugins')
    .option('-c, --config <path>', 'Config file path', 'dzupagent.config.json')
    .action(async (opts: { config: string }) => {
      try {
        const { listPlugins } = await import('./plugins-command.js')
        const plugins = listPlugins(opts.config)
        if (plugins.length === 0) {
          console.log('No plugins registered.')
        } else {
          for (const p of plugins) {
            console.log(`  ${p.name}@${p.version}  [${p.status}]`)
          }
        }
      } catch (err) {
        console.error(`[dzup] plugins list failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  pluginsCmd
    .command('add')
    .description('Add a plugin to the config')
    .argument('<name>', 'Plugin name')
    .option('-c, --config <path>', 'Config file path', 'dzupagent.config.json')
    .action(async (name: string, opts: { config: string }) => {
      try {
        const { addPlugin } = await import('./plugins-command.js')
        const result = addPlugin(name, opts.config)
        if (result.success) {
          console.log(`Plugin "${name}" added.`)
        } else {
          console.error(`Failed: ${result.error}`)
          process.exit(1)
        }
      } catch (err) {
        console.error(`[dzup] plugins add failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  pluginsCmd
    .command('remove')
    .description('Remove a plugin from the config')
    .argument('<name>', 'Plugin name')
    .option('-c, --config <path>', 'Config file path', 'dzupagent.config.json')
    .action(async (name: string, opts: { config: string }) => {
      try {
        const { removePlugin } = await import('./plugins-command.js')
        const result = removePlugin(name, opts.config)
        if (result.success) {
          console.log(`Plugin "${name}" removed.`)
        } else {
          console.error(`Failed: ${result.error}`)
          process.exit(1)
        }
      } catch (err) {
        console.error(`[dzup] plugins remove failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- marketplace ----
  program
    .command('marketplace')
    .description('Search the plugin marketplace')
    .option('-s, --search <query>', 'Search query')
    .option('-c, --category <category>', 'Filter by category')
    .action(async (opts: { search?: string; category?: string }) => {
      try {
        const { createSampleRegistry, searchMarketplace, filterByCategory, formatPluginTable } = await import('./marketplace-command.js')
        const registry = createSampleRegistry()
        let plugins = registry.plugins
        if (opts.search) {
          plugins = searchMarketplace(registry, opts.search)
        } else if (opts.category) {
          plugins = filterByCategory(registry, opts.category)
        }
        console.log(formatPluginTable(plugins))
      } catch (err) {
        console.error(`[dzup] marketplace failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // ---- memory ----
  program
    .command('memory')
    .description('Browse and search agent memory')
    .option('-n, --namespace <ns>', 'Memory namespace', 'lessons')
    .option('-s, --search <query>', 'Search query')
    .option('-l, --limit <number>', 'Result limit', '20')
    .action(async (_opts: { namespace: string; search?: string; limit: string }) => {
      try {
        console.log('Memory browsing requires a running memory service. Use `dzup dev` and call the memory API.')
      } catch (err) {
        console.error(`[dzup] memory failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  return program
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram()
  await program.parseAsync(argv)
}

// Auto-run when invoked directly
const invokedPath = process.argv[1]
if (invokedPath) {
  const { pathToFileURL } = await import('node:url')
  if (import.meta.url === pathToFileURL(invokedPath).href) {
    void runCli()
  }
}
