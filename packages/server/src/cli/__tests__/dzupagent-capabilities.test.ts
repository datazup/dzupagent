/**
 * Integration tests for `dzupagent capabilities` CLI action.
 *
 * Verifies: WorkspaceResolver → DzupAgentFileLoader → AdapterSkillRegistry
 * → SkillCapabilityMatrixBuilder pipeline, table output format, --skill /
 * --project-root flag forwarding, and error-exit branches.
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
  register: vi.fn(),
  registerBundle: vi.fn(),
  buildForSkill: vi.fn(),
}

/** Minimal AdapterSkillBundle fixture with one tool binding and all constraints set. */
const FAKE_BUNDLE = {
  bundleId: 'test-skill',
  skillSetId: 'TestSkill',
  toolBindings: [{ name: 'bash' }],
  constraints: {
    approvalMode: 'auto',
    networkPolicy: 'allow',
    maxBudgetUsd: 5,
  },
}

/** Minimal SkillCapabilityMatrix fixture matching what the CLI consumes. */
const FAKE_MATRIX = {
  skillId: 'test-skill',
  skillName: 'TestSkill',
  providers: {
    claude: {
      systemPrompt: 'active',
      toolBindings: 'active',
      approvalMode: 'active',
      networkPolicy: 'active',
      budgetLimit: 'active',
      warnings: [],
    },
    codex: {
      systemPrompt: 'active',
      toolBindings: 'active',
      approvalMode: 'active',
      networkPolicy: 'active',
      budgetLimit: 'dropped',
      warnings: [],
    },
    gemini: {
      systemPrompt: 'active',
      toolBindings: 'dropped',
      approvalMode: 'dropped',
      networkPolicy: 'dropped',
      budgetLimit: 'dropped',
      warnings: ["Provider 'gemini' does not support toolBindings — capability dropped"],
    },
  },
}

vi.mock('@dzupagent/agent-adapters', () => {
  // Assign fresh vi.fn() instances into the shared container.
  spies.resolve = vi.fn().mockResolvedValue({ projectDir: '/fake/project' })
  spies.loadSkills = vi.fn().mockResolvedValue([FAKE_BUNDLE])
  spies.register = vi.fn()
  spies.registerBundle = vi.fn()
  spies.buildForSkill = vi.fn().mockReturnValue(FAKE_MATRIX)

  return {
    WorkspaceResolver: vi.fn().mockImplementation(() => ({
      resolve: spies.resolve,
    })),
    DzupAgentFileLoader: vi.fn().mockImplementation(() => ({
      loadSkills: spies.loadSkills,
    })),
    AdapterSkillRegistry: vi.fn().mockImplementation(() => ({
      register: spies.register,
      registerBundle: spies.registerBundle,
    })),
    SkillCapabilityMatrixBuilder: vi.fn().mockImplementation(() => ({
      buildForSkill: spies.buildForSkill,
    })),
    ClaudeSkillCompiler: vi.fn().mockImplementation(() => ({})),
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

/** Returns the first-argument string from each console.error call so far. */
function errorLines(): string[] {
  return (console.error as ReturnType<typeof vi.spyOn>).mock.calls.map(
    (args: unknown[]) => String(args[0] ?? ''),
  )
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('dzupagent capabilities — action behaviour', () => {
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
    spies.loadSkills.mockResolvedValue([FAKE_BUNDLE])

    spies.register.mockClear()
    spies.registerBundle.mockClear()

    spies.buildForSkill.mockClear()
    spies.buildForSkill.mockReturnValue(FAKE_MATRIX)
  })

  afterEach(() => {
    // Only restore the console spies — do NOT call vi.restoreAllMocks() because
    // it also clears implementations on vi.fn() module mocks, breaking later tests.
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  // ---------------------------------------------------------------------------
  // Helper: invoke the capabilities sub-subcommand.
  //
  // Commander's { from: 'user' } mode treats the array as user-typed tokens
  // and routes from the root program. The root command is 'dzup', so the
  // two-level sub-command path is: ['dzupagent', 'capabilities', <skillId>].
  // (The pattern mirrors how dzupagent-status.test.ts calls ['dzupagent', 'status'].)
  // ---------------------------------------------------------------------------

  // 1. WorkspaceResolver.resolve is called with the project root
  it('invokes WorkspaceResolver.resolve with the default project root', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    expect(spies.resolve).toHaveBeenCalledTimes(1)
    expect(spies.resolve).toHaveBeenCalledWith(process.cwd())
  })

  // 2. DzupAgentFileLoader.loadSkills is called
  it('calls fileLoader.loadSkills() to retrieve the skill list', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    expect(spies.loadSkills).toHaveBeenCalledTimes(1)
  })

  // 3. AdapterSkillRegistry.register is called (ClaudeSkillCompiler registered)
  it('registers a ClaudeSkillCompiler instance with the skill registry', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    expect(spies.register).toHaveBeenCalledTimes(1)
  })

  // 4. AdapterSkillRegistry.registerBundle is called with the matching bundle
  it('registers the resolved bundle with the skill registry', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    expect(spies.registerBundle).toHaveBeenCalledTimes(1)
    expect(spies.registerBundle).toHaveBeenCalledWith(FAKE_BUNDLE)
  })

  // 5. SkillCapabilityMatrixBuilder.buildForSkill is called with the bundle
  it('calls builder.buildForSkill() with the resolved bundle', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    expect(spies.buildForSkill).toHaveBeenCalledTimes(1)
    expect(spies.buildForSkill).toHaveBeenCalledWith(FAKE_BUNDLE)
  })

  // 6. Table header is output — "Provider" + all five capability column labels
  it('outputs a table header with Provider and all capability column names', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    const lines = logLines()
    const headerLine = lines.find((l) => l.startsWith('Provider'))
    expect(headerLine).toBeDefined()

    const expectedColumns = ['System Prompt', 'Tool Bindings', 'Approval Mode', 'Network Policy', 'Budget Limit']
    for (const col of expectedColumns) {
      expect(headerLine).toContain(col)
    }
  })

  // 7. Table header is followed by a separator line made of dashes
  it('outputs a separator line of dashes after the header row', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    const lines = logLines()
    const headerIdx = lines.findIndex((l) => l.startsWith('Provider'))
    expect(headerIdx).toBeGreaterThanOrEqual(0)

    const separatorLine = lines[headerIdx + 1]
    expect(separatorLine).toMatch(/^-+$/)
  })

  // 8. Capability matrix title line includes the skillId
  it('outputs a title line that contains the skillId', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    const lines = logLines()
    expect(lines.some((l) => l.includes('test-skill') && l.includes('Capability Matrix'))).toBe(true)
  })

  // 9. Each provider in the matrix produces a data row
  it('outputs one data row per provider in the capability matrix', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    const lines = logLines()
    expect(lines.some((l) => l.startsWith('claude'.padEnd(16)))).toBe(true)
    expect(lines.some((l) => l.startsWith('codex'.padEnd(16)))).toBe(true)
    expect(lines.some((l) => l.startsWith('gemini'.padEnd(16)))).toBe(true)
  })

  // 10. Provider row values reflect the matrix fields (status strings are present)
  it('provider data rows contain capability status values', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    const lines = logLines()
    const claudeLine = lines.find((l) => l.startsWith('claude'.padEnd(16)))
    expect(claudeLine).toBeDefined()
    expect(claudeLine).toContain('active')

    const geminiLine = lines.find((l) => l.startsWith('gemini'.padEnd(16)))
    expect(geminiLine).toBeDefined()
    expect(geminiLine).toContain('dropped')
  })

  // 11. Warnings section is rendered when providers report warnings
  it('outputs a Warnings section when the matrix includes provider warnings', async () => {
    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    const lines = logLines()
    expect(lines.some((l) => l === 'Warnings:')).toBe(true)
    expect(
      lines.some((l) => l.includes('[gemini]') && l.includes('toolBindings')),
    ).toBe(true)
  })

  // 12. No Warnings section when all providers have empty warning arrays
  it('omits the Warnings section when no provider reports warnings', async () => {
    const matrixNoWarnings = {
      ...FAKE_MATRIX,
      providers: {
        claude: { ...FAKE_MATRIX.providers.claude, warnings: [] },
        codex: { ...FAKE_MATRIX.providers.codex, warnings: [] },
      },
    }
    spies.buildForSkill.mockReturnValue(matrixNoWarnings)

    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    const lines = logLines()
    expect(lines.some((l) => l === 'Warnings:')).toBe(false)
  })

  // 13. Skill not found: logs error to console.error
  //
  // Note: process.exit(1) is called by the action but Commander's async
  // promise chain may swallow the thrown error from a spy. We therefore
  // verify the observable side-effect (console.error with the skill name)
  // rather than a process.exit assertion, which mirrors the pattern used
  // throughout the existing dzupagent-status test suite.
  it('logs an error message containing the skill ID when the skill is not found', async () => {
    spies.loadSkills.mockResolvedValue([]) // no bundles — bundle lookup returns undefined

    const program = createProgram()
    // parseAsync may or may not throw depending on Commander's error propagation
    try {
      await program.parseAsync(['dzupagent', 'capabilities', 'missing-skill'], { from: 'user' })
    } catch {
      // swallow — we only care about console.error below
    }

    expect(errorLines().some((l) => l.includes('missing-skill'))).toBe(true)
  })

  // 14. process.exit is not called when the skill is found successfully
  it('does not call process.exit on success', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit called with code ${String(_code)}`)
    })

    try {
      const program = createProgram()
      await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })
    } finally {
      exitSpy.mockRestore()
    }

    expect(exitSpy).not.toHaveBeenCalled()
  })

  // 15. --project-root flag is forwarded to WorkspaceResolver.resolve
  it('passes custom --project-root to WorkspaceResolver.resolve', async () => {
    spies.resolve.mockResolvedValue({ projectDir: '/custom/root' })

    const program = createProgram()
    await program.parseAsync(
      ['dzupagent', 'capabilities', 'test-skill', '--project-root', '/custom/root'],
      { from: 'user' },
    )

    expect(spies.resolve).toHaveBeenCalledWith('/custom/root')
  })

  // 16. WorkspaceResolver failure triggers error log
  //
  // We assert on console.error content, which is the reliable observable.
  // The action's process.exit(1) call occurs after the error is logged; Commander's
  // async promise propagation may or may not surface the thrown exit-spy error
  // depending on version behaviour, so we don't assert on it here.
  it('logs a capabilities-failed message when WorkspaceResolver throws', async () => {
    spies.resolve.mockRejectedValue(new Error('workspace not found'))

    const program = createProgram()
    try {
      await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })
    } catch {
      // swallow
    }

    expect(
      errorLines().some((l) => l.includes('capabilities failed') && l.includes('workspace not found')),
    ).toBe(true)
  })

  // 17. loadSkills failure triggers error log
  it('logs a capabilities-failed message when loadSkills throws', async () => {
    spies.loadSkills.mockRejectedValue(new Error('disk read error'))

    const program = createProgram()
    try {
      await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })
    } catch {
      // swallow
    }

    expect(
      errorLines().some((l) => l.includes('capabilities failed') && l.includes('disk read error')),
    ).toBe(true)
  })

  // 18. Multiple bundles — only the matching bundle is used for buildForSkill
  it('selects the correct bundle by bundleId when multiple skills are loaded', async () => {
    const otherBundle = { ...FAKE_BUNDLE, bundleId: 'other-skill', skillSetId: 'OtherSkill' }
    spies.loadSkills.mockResolvedValue([otherBundle, FAKE_BUNDLE])

    const program = createProgram()
    await program.parseAsync(['dzupagent', 'capabilities', 'test-skill'], { from: 'user' })

    expect(spies.buildForSkill).toHaveBeenCalledWith(FAKE_BUNDLE)
    expect(spies.buildForSkill).not.toHaveBeenCalledWith(otherBundle)
  })
})
