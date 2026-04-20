/**
 * Smoke tests for the dzup CLI entry point.
 *
 * Tests the commander program structure without spawning child processes.
 * All heavy command modules are mocked to avoid side effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Command } from 'commander'

// Mock heavy dependencies before import
vi.mock('../dev-command.js', () => ({
  createDevCommand: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}))

vi.mock('../doctor.js', () => ({
  runDoctor: vi.fn(async () => ({
    categories: [],
    summary: { passed: 0, warnings: 0, failures: 0, total: 0 },
    timestamp: '2026-01-01T00:00:00.000Z',
  })),
  formatDoctorReport: vi.fn(() => 'doctor report'),
  formatDoctorReportJSON: vi.fn(() => '{}'),
}))

vi.mock('../config-command.js', () => ({
  configValidate: vi.fn(() => ({ valid: true, errors: [] })),
  configShow: vi.fn(() => ({ port: 4000 })),
}))

vi.mock('../vectordb-command.js', () => ({
  vectordbStatus: vi.fn(async () => ({
    provider: 'in-memory',
    healthy: true,
    latencyMs: 1,
    collections: [],
  })),
  formatVectorDBStatus: vi.fn(() => 'vectordb status'),
}))

vi.mock('../scorecard-command.js', () => ({
  runScorecard: vi.fn(() => ({
    report: {},
    rendered: 'scorecard output',
  })),
  parseScorecardArgs: vi.fn(() => ({})),
}))

vi.mock('../trace-printer.js', () => ({
  TracePrinter: vi.fn(() => ({
    attach: vi.fn(),
    detach: vi.fn(),
    formatEvent: vi.fn(),
  })),
}))

vi.mock('../plugins-command.js', () => ({
  listPlugins: vi.fn(() => []),
  addPlugin: vi.fn(() => ({ success: true })),
  removePlugin: vi.fn(() => ({ success: true })),
}))

vi.mock('../marketplace-command.js', () => ({
  createSampleRegistry: vi.fn(() => ({
    plugins: [],
    categories: [],
    lastUpdated: '2026-01-01T00:00:00.000Z',
  })),
  searchMarketplace: vi.fn(() => []),
  filterByCategory: vi.fn(() => []),
  formatPluginTable: vi.fn(() => 'No plugins found.'),
}))

vi.mock('../memory-command.js', () => ({
  memoryBrowse: vi.fn(async () => []),
  memorySearch: vi.fn(async () => []),
}))

vi.mock('../mcp-command.js', () => ({
  mcpList: vi.fn(async () => ({ success: true, data: [] })),
  formatServerList: vi.fn(() => 'No MCP servers registered.'),
}))

// Import after mocks
import { createProgram } from '../dzup.js'

function findCommand(parent: Command, name: string): Command | undefined {
  return parent.commands.find((c) => c.name() === name)
}

function findOption(cmd: Command, long: string): boolean {
  return cmd.options.some((o) => o.long === long)
}

describe('dzup CLI', () => {
  let program: Command

  beforeEach(() => {
    program = createProgram()
  })

  // ---- Program structure ----

  it('has correct program name', () => {
    expect(program.name()).toBe('dzup')
  })

  it('has a description', () => {
    expect(program.description()).toContain('DzupAgent')
  })

  it('has a version string', () => {
    expect(program.version()).toBeDefined()
    expect(typeof program.version()).toBe('string')
    expect(program.version()!.length).toBeGreaterThan(0)
  })

  it('version matches semver pattern', () => {
    const version = program.version()!
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  // ---- dev command ----

  it('registers dev command', () => {
    const dev = findCommand(program, 'dev')
    expect(dev).toBeDefined()
  })

  it('dev command has a description', () => {
    const dev = findCommand(program, 'dev')!
    expect(dev.description()).toBeTruthy()
  })

  it('dev command has --port option', () => {
    const dev = findCommand(program, 'dev')!
    expect(findOption(dev, '--port')).toBe(true)
  })

  it('dev command has --verbose option', () => {
    const dev = findCommand(program, 'dev')!
    expect(findOption(dev, '--verbose')).toBe(true)
  })

  it('dev command default port is 4000', () => {
    const dev = findCommand(program, 'dev')!
    const portOpt = dev.options.find((o) => o.long === '--port')
    expect(portOpt?.defaultValue).toBe('4000')
  })

  it('dev command default verbose is false', () => {
    const dev = findCommand(program, 'dev')!
    const verboseOpt = dev.options.find((o) => o.long === '--verbose')
    expect(verboseOpt?.defaultValue).toBe(false)
  })

  // ---- list command ----

  it('registers list command', () => {
    const list = findCommand(program, 'list')
    expect(list).toBeDefined()
  })

  it('list command has a description', () => {
    const list = findCommand(program, 'list')!
    expect(list.description()).toBeTruthy()
  })

  it('list command has --format option', () => {
    const list = findCommand(program, 'list')!
    expect(findOption(list, '--format')).toBe(true)
  })

  it('list command default format is table', () => {
    const list = findCommand(program, 'list')!
    const formatOpt = list.options.find((o) => o.long === '--format')
    expect(formatOpt?.defaultValue).toBe('table')
  })

  // ---- run command ----

  it('registers run command', () => {
    const run = findCommand(program, 'run')
    expect(run).toBeDefined()
  })

  it('run command has a description', () => {
    const run = findCommand(program, 'run')!
    expect(run.description()).toBeTruthy()
  })

  it('run command has <agent-id> argument', () => {
    const run = findCommand(program, 'run')!
    const args = run.registeredArguments
    expect(args.length).toBeGreaterThanOrEqual(1)
    expect(args[0]!.name()).toBe('agent-id')
    expect(args[0]!.required).toBe(true)
  })

  it('run command has --input option', () => {
    const run = findCommand(program, 'run')!
    expect(findOption(run, '--input')).toBe(true)
  })

  // ---- doctor command ----

  it('registers doctor command', () => {
    const doctor = findCommand(program, 'doctor')
    expect(doctor).toBeDefined()
  })

  it('doctor command has a description', () => {
    const doctor = findCommand(program, 'doctor')!
    expect(doctor.description()).toBeTruthy()
  })

  it('doctor command has --json option', () => {
    const doctor = findCommand(program, 'doctor')!
    expect(findOption(doctor, '--json')).toBe(true)
  })

  it('doctor command has --fix option', () => {
    const doctor = findCommand(program, 'doctor')!
    expect(findOption(doctor, '--fix')).toBe(true)
  })

  // ---- vectordb command ----

  it('registers vectordb command', () => {
    const vectordb = findCommand(program, 'vectordb')
    expect(vectordb).toBeDefined()
  })

  it('vectordb has status sub-command', () => {
    const vectordb = findCommand(program, 'vectordb')!
    const status = findCommand(vectordb, 'status')
    expect(status).toBeDefined()
  })

  it('vectordb status has a description', () => {
    const vectordb = findCommand(program, 'vectordb')!
    const status = findCommand(vectordb, 'status')!
    expect(status.description()).toBeTruthy()
  })

  // ---- scorecard command ----

  it('registers scorecard command', () => {
    const scorecard = findCommand(program, 'scorecard')
    expect(scorecard).toBeDefined()
  })

  it('scorecard command has a description', () => {
    const scorecard = findCommand(program, 'scorecard')!
    expect(scorecard.description()).toBeTruthy()
  })

  it('scorecard command has --agent option', () => {
    const scorecard = findCommand(program, 'scorecard')!
    expect(findOption(scorecard, '--agent')).toBe(true)
  })

  it('scorecard command has --format option', () => {
    const scorecard = findCommand(program, 'scorecard')!
    expect(findOption(scorecard, '--format')).toBe(true)
  })

  it('scorecard command has --output option', () => {
    const scorecard = findCommand(program, 'scorecard')!
    expect(findOption(scorecard, '--output')).toBe(true)
  })

  // ---- trace command ----

  it('registers trace command', () => {
    const trace = findCommand(program, 'trace')
    expect(trace).toBeDefined()
  })

  it('trace command has a description', () => {
    const trace = findCommand(program, 'trace')!
    expect(trace.description()).toBeTruthy()
  })

  it('trace command has --run option', () => {
    const trace = findCommand(program, 'trace')!
    expect(findOption(trace, '--run')).toBe(true)
  })

  it('trace command has --verbose option', () => {
    const trace = findCommand(program, 'trace')!
    expect(findOption(trace, '--verbose')).toBe(true)
  })

  // ---- config command ----

  it('registers config command', () => {
    const config = findCommand(program, 'config')
    expect(config).toBeDefined()
  })

  it('config command has a description', () => {
    const config = findCommand(program, 'config')!
    expect(config.description()).toBeTruthy()
  })

  it('config has get sub-command', () => {
    const config = findCommand(program, 'config')!
    const get = findCommand(config, 'get')
    expect(get).toBeDefined()
  })

  it('config get has <key> argument', () => {
    const config = findCommand(program, 'config')!
    const get = findCommand(config, 'get')!
    const args = get.registeredArguments
    expect(args.length).toBeGreaterThanOrEqual(1)
    expect(args[0]!.name()).toBe('key')
  })

  it('config has set sub-command', () => {
    const config = findCommand(program, 'config')!
    const set = findCommand(config, 'set')
    expect(set).toBeDefined()
  })

  it('config set has <key> and <value> arguments', () => {
    const config = findCommand(program, 'config')!
    const set = findCommand(config, 'set')!
    const args = set.registeredArguments
    expect(args.length).toBeGreaterThanOrEqual(2)
    expect(args[0]!.name()).toBe('key')
    expect(args[1]!.name()).toBe('value')
  })

  it('config has validate sub-command', () => {
    const config = findCommand(program, 'config')!
    const validate = findCommand(config, 'validate')
    expect(validate).toBeDefined()
  })

  // ---- mcp command ----

  it('registers mcp command', () => {
    const mcp = findCommand(program, 'mcp')
    expect(mcp).toBeDefined()
  })

  it('mcp has list sub-command', () => {
    const mcp = findCommand(program, 'mcp')!
    const list = findCommand(mcp, 'list')
    expect(list).toBeDefined()
  })

  // ---- plugins command ----

  it('registers plugins command', () => {
    const plugins = findCommand(program, 'plugins')
    expect(plugins).toBeDefined()
  })

  it('plugins has list sub-command', () => {
    const plugins = findCommand(program, 'plugins')!
    const list = findCommand(plugins, 'list')
    expect(list).toBeDefined()
  })

  it('plugins has add sub-command', () => {
    const plugins = findCommand(program, 'plugins')!
    const add = findCommand(plugins, 'add')
    expect(add).toBeDefined()
  })

  it('plugins add has <name> argument', () => {
    const plugins = findCommand(program, 'plugins')!
    const add = findCommand(plugins, 'add')!
    const args = add.registeredArguments
    expect(args.length).toBeGreaterThanOrEqual(1)
    expect(args[0]!.name()).toBe('name')
  })

  it('plugins has remove sub-command', () => {
    const plugins = findCommand(program, 'plugins')!
    const remove = findCommand(plugins, 'remove')
    expect(remove).toBeDefined()
  })

  it('plugins remove has <name> argument', () => {
    const plugins = findCommand(program, 'plugins')!
    const remove = findCommand(plugins, 'remove')!
    const args = remove.registeredArguments
    expect(args.length).toBeGreaterThanOrEqual(1)
    expect(args[0]!.name()).toBe('name')
  })

  // ---- marketplace command ----

  it('registers marketplace command', () => {
    const marketplace = findCommand(program, 'marketplace')
    expect(marketplace).toBeDefined()
  })

  it('marketplace command has --search option', () => {
    const marketplace = findCommand(program, 'marketplace')!
    expect(findOption(marketplace, '--search')).toBe(true)
  })

  it('marketplace command has --category option', () => {
    const marketplace = findCommand(program, 'marketplace')!
    expect(findOption(marketplace, '--category')).toBe(true)
  })

  // ---- memory command ----

  it('registers memory command', () => {
    const memory = findCommand(program, 'memory')
    expect(memory).toBeDefined()
  })

  it('memory command has --namespace option', () => {
    const memory = findCommand(program, 'memory')!
    expect(findOption(memory, '--namespace')).toBe(true)
  })

  it('memory command has --search option', () => {
    const memory = findCommand(program, 'memory')!
    expect(findOption(memory, '--search')).toBe(true)
  })

  it('memory command has --limit option', () => {
    const memory = findCommand(program, 'memory')!
    expect(findOption(memory, '--limit')).toBe(true)
  })

  // ---- Total command count ----

  it('registers all top-level commands', () => {
    const names = program.commands.map((c) => c.name()).sort()
    expect(names).toEqual([
      'config',
      'dev',
      'doctor',
      'dzupagent',
      'list',
      'marketplace',
      'mcp',
      'memory',
      'plugins',
      'run',
      'scorecard',
      'trace',
      'vectordb',
    ])
  })

  // ---- Help output ----

  it('help output contains program name', () => {
    const help = program.helpInformation()
    expect(help).toContain('dzup')
  })

  it('help output contains description', () => {
    const help = program.helpInformation()
    expect(help).toContain('DzupAgent')
  })

  it('help output lists all commands', () => {
    const help = program.helpInformation()
    expect(help).toContain('dev')
    expect(help).toContain('doctor')
    expect(help).toContain('run')
    expect(help).toContain('config')
  })
})
