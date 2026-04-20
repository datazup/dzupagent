/**
 * Integration tests for `dzupagent status` CLI action.
 *
 * Verifies the round-trip behaviour: WorkspaceResolver → loaders → console
 * output, plus state.json present / absent branches.
 *
 * All external I/O is mocked at the module level so the suite runs offline
 * without touching the real filesystem or @dzupagent/agent-adapters build.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------
// Vitest hoists vi.mock() factories before any other code. To share spy
// references between the factory and the test body we use a single mutable
// "spies" object declared with `const` — object identity is stable across
// the hoist boundary, so properties assigned inside the factory are visible
// to test code that reads them later.
// ---------------------------------------------------------------------------

const spies = {
  resolve: vi.fn(),
  loadSkills: vi.fn(),
  loadAgents: vi.fn(),
  loadEntries: vi.fn(),
  readFile: vi.fn(),
}

vi.mock('@dzupagent/agent-adapters', () => {
  // Assign fresh vi.fn() instances into the shared container.
  spies.resolve = vi.fn().mockResolvedValue({ projectDir: '/fake/project' })
  spies.loadSkills = vi.fn().mockResolvedValue([{}, {}])
  spies.loadAgents = vi.fn().mockResolvedValue([{}])
  spies.loadEntries = vi.fn().mockResolvedValue([{}, {}, {}])

  return {
    WorkspaceResolver: vi.fn().mockImplementation(() => ({
      resolve: spies.resolve,
    })),
    DzupAgentFileLoader: vi.fn().mockImplementation(() => ({
      loadSkills: spies.loadSkills,
    })),
    DzupAgentAgentLoader: vi.fn().mockImplementation(() => ({
      loadAgents: spies.loadAgents,
    })),
    DzupAgentMemoryLoader: vi.fn().mockImplementation(() => ({
      loadEntries: spies.loadEntries,
    })),
    AdapterSkillRegistry: vi.fn().mockImplementation(() => ({})),
  }
})

vi.mock('node:fs/promises', () => {
  spies.readFile = vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory'))
  return {
    readFile: spies.readFile,
  }
})

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------
import { createProgram } from '../dzup.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the first-argument string from each console.log call so far. */
function logLines(): string[] {
  return (console.log as ReturnType<typeof vi.spyOn>).mock.calls.map(
    (args: unknown[]) => String(args[0] ?? ''),
  )
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('dzupagent status — action behaviour', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // Clear call history and restore default return values for each test.
    // NOTE: we use mockClear() (preserves implementation) rather than
    // mockReset() (wipes implementation), because the latter would clear the
    // constructor implementations on the class mocks defined above.
    spies.resolve.mockClear()
    spies.resolve.mockResolvedValue({ projectDir: '/fake/project' })

    spies.loadSkills.mockClear()
    spies.loadSkills.mockResolvedValue([{}, {}])

    spies.loadAgents.mockClear()
    spies.loadAgents.mockResolvedValue([{}])

    spies.loadEntries.mockClear()
    spies.loadEntries.mockResolvedValue([{}, {}, {}])

    spies.readFile.mockClear()
    spies.readFile.mockRejectedValue(new Error('ENOENT: no such file or directory'))
  })

  afterEach(() => {
    // Only restore the console spies — do NOT call vi.restoreAllMocks() because
    // it also clears implementations on vi.fn() module mocks, breaking later tests.
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  // 1. WorkspaceResolver.resolve is called with the project root
  it('invokes WorkspaceResolver.resolve with the project root', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    expect(spies.resolve).toHaveBeenCalledTimes(1)
    // default --project-root is process.cwd()
    expect(spies.resolve).toHaveBeenCalledWith(process.cwd())
  })

  // 2. fileLoader.loadSkills() is called
  it('calls fileLoader.loadSkills()', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    expect(spies.loadSkills).toHaveBeenCalledTimes(1)
  })

  // 3. agentLoader.loadAgents() is called
  it('calls agentLoader.loadAgents()', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    expect(spies.loadAgents).toHaveBeenCalledTimes(1)
  })

  // 4. memoryLoader.loadEntries() is called
  it('calls memoryLoader.loadEntries()', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    expect(spies.loadEntries).toHaveBeenCalledTimes(1)
  })

  // 5. Header line contains project dir
  it('logs the status header line with project dir', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    const lines = logLines()
    expect(
      lines.some((l) => l.includes('.dzupagent/ status') && l.includes('/fake/project')),
    ).toBe(true)
  })

  // 6. Skills count
  it('logs correct skills count', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    const lines = logLines()
    expect(lines.some((l) => /Skills:\s*2/.test(l))).toBe(true)
  })

  // 7. Agents count
  it('logs correct agents count', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    const lines = logLines()
    expect(lines.some((l) => /Agents:\s*1/.test(l))).toBe(true)
  })

  // 8. Memory entries count
  it('logs correct memory entries count', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    const lines = logLines()
    expect(lines.some((l) => /Memory:\s*3 entries/.test(l))).toBe(true)
  })

  // 9. No state.json found when readFile rejects
  it('logs "no state.json found" when state.json does not exist', async () => {
    // spies.readFile already rejects by default via beforeEach
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    const lines = logLines()
    expect(lines.some((l) => l.includes('no state.json found'))).toBe(true)
  })

  // 10. state.json content logged when it exists
  it('logs state.json content when it exists', async () => {
    spies.readFile.mockResolvedValue('{"version":1}')

    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status'], { from: 'user' })

    const lines = logLines()
    // The CLI does JSON.stringify(parsed, null, 2); output should contain "version"
    const stateLines = lines.filter((l) => l.includes('state.json'))
    expect(stateLines.length).toBeGreaterThan(0)
    expect(stateLines.some((l) => l.includes('"version"') || l.includes('version'))).toBe(true)
    // Must NOT fall back to the "no state.json found" message
    expect(lines.some((l) => l.includes('no state.json found'))).toBe(false)
  })

  // 11. Custom --project-root is forwarded to WorkspaceResolver
  it('passes custom --project-root to WorkspaceResolver', async () => {
    spies.resolve.mockResolvedValue({ projectDir: '/custom/root' })

    const program = createProgram()
    await program.parseAsync(['dzupagent', 'status', '--project-root', '/custom/root'], {
      from: 'user',
    })

    expect(spies.resolve).toHaveBeenCalledWith('/custom/root')

    const lines = logLines()
    expect(lines.some((l) => l.includes('/custom/root'))).toBe(true)
  })

  // 12. process.exit is not called on success
  it('does not call process.exit on success', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit called with code ${String(_code)}`)
    })

    try {
      const program = createProgram()
      await program.parseAsync(['dzupagent', 'status'], { from: 'user' })
    } finally {
      exitSpy.mockRestore()
    }

    expect(exitSpy).not.toHaveBeenCalled()
  })
})
