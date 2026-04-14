/**
 * Tests for the interactive wizard (runWizard).
 *
 * All @inquirer/prompts calls are mocked so tests run non-interactively.
 * Internal utility modules are also mocked with stable return values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock @inquirer/prompts before importing wizard
// ---------------------------------------------------------------------------

const mockInput = vi.fn()
const mockSelect = vi.fn()
const mockCheckbox = vi.fn()
const mockConfirm = vi.fn()

vi.mock('@inquirer/prompts', () => ({
  input: mockInput,
  select: mockSelect,
  checkbox: mockCheckbox,
  confirm: mockConfirm,
}))

// ---------------------------------------------------------------------------
// Mock internal modules
// ---------------------------------------------------------------------------

vi.mock('../utils.js', () => ({
  validateProjectName: vi.fn(() => undefined), // undefined = valid
  detectPackageManager: vi.fn(() => 'npm'),
}))

vi.mock('../templates/index.js', () => ({
  listTemplates: vi.fn(() => [
    { id: 'minimal', name: 'Minimal', description: 'Bare-bones agent' },
    { id: 'full-stack', name: 'Full Stack', description: 'Full stack agent' },
  ]),
}))

vi.mock('../features.js', () => ({
  listFeatures: vi.fn(() => [
    { slug: 'auth', name: 'Auth', description: 'Authentication' },
    { slug: 'memory', name: 'Memory', description: 'Memory store' },
    { slug: 'dashboard', name: 'Dashboard', description: 'Admin dashboard' },
  ]),
}))

vi.mock('../presets.js', () => ({
  listPresets: vi.fn(() => [
    {
      name: 'minimal',
      label: 'Minimal',
      description: 'Bare-bones single-agent setup',
      template: 'minimal',
      features: [],
      database: 'none',
      auth: 'none',
    },
    {
      name: 'starter',
      label: 'Starter',
      description: 'Base template with auth and dashboard',
      template: 'full-stack',
      features: ['auth', 'dashboard'],
      database: 'postgres',
      auth: 'api-key',
    },
  ]),
}))

// ---------------------------------------------------------------------------
// Import wizard AFTER mocks are set up
// ---------------------------------------------------------------------------

const { runWizard } = await import('../wizard.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spy on process.exit so it throws instead of terminating the process. */
function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit invoked')
  }) as never)
}

// ---------------------------------------------------------------------------
// Tests — Preset flow
// ---------------------------------------------------------------------------

describe('runWizard — preset flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Suppress console.log output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns correct config when selecting a preset', async () => {
    mockInput.mockResolvedValueOnce('my-project')
    mockSelect
      .mockResolvedValueOnce('minimal')      // preset selection
      .mockResolvedValueOnce('yarn')          // package manager
    mockConfirm
      .mockResolvedValueOnce(true)            // init git
      .mockResolvedValueOnce(true)            // install deps
      .mockResolvedValueOnce(true)            // Create project?

    const result = await runWizard()

    expect(result.projectName).toBe('my-project')
    expect(result.template).toBe('minimal')
    expect(result.features).toEqual([])
    expect(result.database).toBe('none')
    expect(result.authProvider).toBe('none')
    expect(result.preset).toBe('minimal')
    expect(result.packageManager).toBe('yarn')
    expect(result.initGit).toBe(true)
    expect(result.installDeps).toBe(true)
  })

  it('uses preset config values for template and features', async () => {
    mockInput.mockResolvedValueOnce('starter-project')
    mockSelect
      .mockResolvedValueOnce('starter')       // preset selection
      .mockResolvedValueOnce('npm')            // package manager
    mockConfirm
      .mockResolvedValueOnce(false)            // init git
      .mockResolvedValueOnce(false)            // install deps
      .mockResolvedValueOnce(true)             // Create project?

    const result = await runWizard()

    expect(result.template).toBe('full-stack')
    expect(result.features).toEqual(['auth', 'dashboard'])
    expect(result.database).toBe('postgres')
    expect(result.authProvider).toBe('api-key')
    expect(result.initGit).toBe(false)
    expect(result.installDeps).toBe(false)
  })

  it('calls process.exit(0) when user aborts from preset confirm', async () => {
    const exitSpy = mockProcessExit()
    mockInput.mockResolvedValueOnce('my-project')
    mockSelect
      .mockResolvedValueOnce('minimal')       // preset selection
      .mockResolvedValueOnce('npm')            // package manager
    mockConfirm
      .mockResolvedValueOnce(true)             // init git
      .mockResolvedValueOnce(true)             // install deps
      .mockResolvedValueOnce(false)            // Create project? → abort

    await expect(runWizard()).rejects.toThrow('process.exit invoked')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('passes detected package manager as default to select', async () => {
    const { detectPackageManager } = await import('../utils.js')
    vi.mocked(detectPackageManager).mockReturnValueOnce('pnpm')

    mockInput.mockResolvedValueOnce('my-project')
    // We need to capture the args passed to select for pm
    let pmSelectArgs: unknown
    mockSelect
      .mockResolvedValueOnce('minimal')       // preset selection
      .mockImplementationOnce((args: unknown) => {
        pmSelectArgs = args
        return Promise.resolve('pnpm')
      })
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    await runWizard()

    expect((pmSelectArgs as { default?: string }).default).toBe('pnpm')
  })
})

// ---------------------------------------------------------------------------
// Tests — Custom flow
// ---------------------------------------------------------------------------

describe('runWizard — custom flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns correct config for custom path', async () => {
    mockInput.mockResolvedValueOnce('custom-project')
    mockSelect
      .mockResolvedValueOnce('custom')        // preset/custom selection
      .mockResolvedValueOnce('full-stack')    // template
      .mockResolvedValueOnce('sqlite')        // database
      .mockResolvedValueOnce('jwt')           // auth
      .mockResolvedValueOnce('pnpm')          // package manager
    mockCheckbox.mockResolvedValueOnce(['auth', 'memory'])
    mockConfirm
      .mockResolvedValueOnce(true)            // init git
      .mockResolvedValueOnce(false)           // install deps
      .mockResolvedValueOnce(true)            // Create project?

    const result = await runWizard()

    expect(result.projectName).toBe('custom-project')
    expect(result.template).toBe('full-stack')
    expect(result.features).toEqual(['auth', 'memory'])
    expect(result.database).toBe('sqlite')
    expect(result.authProvider).toBe('jwt')
    expect(result.packageManager).toBe('pnpm')
    expect(result.initGit).toBe(true)
    expect(result.installDeps).toBe(false)
    // Custom path does not set preset
    expect(result.preset).toBeUndefined()
  })

  it('handles empty feature selection (checkbox returns [])', async () => {
    mockInput.mockResolvedValueOnce('empty-features')
    mockSelect
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('minimal')
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('npm')
    mockCheckbox.mockResolvedValueOnce([])
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    const result = await runWizard()

    expect(result.features).toEqual([])
  })

  it('calls process.exit(0) when user aborts from custom confirm', async () => {
    const exitSpy = mockProcessExit()
    mockInput.mockResolvedValueOnce('custom-project')
    mockSelect
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('minimal')
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('npm')
    mockCheckbox.mockResolvedValueOnce([])
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)           // Create project? → abort

    await expect(runWizard()).rejects.toThrow('process.exit invoked')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('passes validate function to project name input', async () => {
    const { validateProjectName } = await import('../utils.js')
    vi.mocked(validateProjectName).mockReturnValue('Name must be lowercase')

    let capturedValidate: ((v: string) => unknown) | undefined
    mockInput.mockImplementationOnce((args: { validate?: (v: string) => unknown }) => {
      capturedValidate = args.validate
      return Promise.resolve('my-project')
    })
    mockSelect
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('minimal')
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('npm')
    mockCheckbox.mockResolvedValueOnce([])
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)

    await runWizard()

    expect(capturedValidate).toBeDefined()
    // validateProjectName returns an error string → validate returns error string
    expect(capturedValidate!('Invalid Name')).toBe('Name must be lowercase')
    // validateProjectName returns undefined → validate returns true
    vi.mocked(validateProjectName).mockReturnValue(undefined)
    expect(capturedValidate!('valid-name')).toBe(true)
  })
})
