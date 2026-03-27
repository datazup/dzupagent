import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateProject } from '../generator.js'
import type { ProjectConfig } from '../types.js'

describe('generateProject', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-gen-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function makeConfig(overrides?: Partial<ProjectConfig>): ProjectConfig {
    return {
      projectName: 'test-project',
      template: 'minimal',
      features: [],
      database: 'none',
      authProvider: 'none',
      packageManager: 'npm',
      initGit: false,
      installDeps: false,
      ...overrides,
    }
  }

  it('creates a project directory with template files', async () => {
    const result = await generateProject(makeConfig(), tempDir)

    expect(result.projectDir).toBe(join(tempDir, 'test-project'))
    expect(result.template).toBe('minimal')
    expect(result.filesCreated).toContain('package.json')
    expect(result.filesCreated).toContain('.env.example')
    expect(result.filesCreated).toContain('README.md')
  })

  it('generates a valid package.json with project name', async () => {
    const result = await generateProject(makeConfig(), tempDir)
    const pkgRaw = await readFile(join(result.projectDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>

    expect(pkg['name']).toBe('test-project')
    expect(pkg['type']).toBe('module')
    expect(pkg['scripts']).toBeDefined()
  })

  it('generates .env.example with project name', async () => {
    const result = await generateProject(makeConfig(), tempDir)
    const envContent = await readFile(join(result.projectDir, '.env.example'), 'utf-8')

    expect(envContent).toContain('test-project')
    expect(envContent).toContain('ANTHROPIC_API_KEY')
  })

  it('generates README.md with project name', async () => {
    const result = await generateProject(makeConfig(), tempDir)
    const readmeContent = await readFile(join(result.projectDir, 'README.md'), 'utf-8')

    expect(readmeContent).toContain('# test-project')
    expect(readmeContent).toContain('minimal')
  })

  it('generates docker-compose.yml when database is postgres', async () => {
    const result = await generateProject(
      makeConfig({ database: 'postgres' }),
      tempDir,
    )

    expect(result.filesCreated).toContain('docker-compose.yml')
    const dockerContent = await readFile(join(result.projectDir, 'docker-compose.yml'), 'utf-8')
    expect(dockerContent).toContain('postgres')
    expect(dockerContent).toContain('redis')
  })

  it('does not generate docker-compose.yml when database is none', async () => {
    const result = await generateProject(makeConfig(), tempDir)

    expect(result.filesCreated).not.toContain('docker-compose.yml')
  })

  it('applies feature overlays', async () => {
    const result = await generateProject(
      makeConfig({ features: ['auth'] }),
      tempDir,
    )

    expect(result.filesCreated).toContain('src/middleware/auth.ts')
    expect(result.features).toContain('auth')
  })

  it('applies multiple feature overlays', async () => {
    const result = await generateProject(
      makeConfig({ features: ['auth', 'billing', 'teams'] }),
      tempDir,
    )

    expect(result.filesCreated).toContain('src/middleware/auth.ts')
    expect(result.filesCreated).toContain('src/services/billing.ts')
    expect(result.filesCreated).toContain('src/services/teams.ts')
  })

  it('includes docker-compose with qdrant when ai feature is selected', async () => {
    const result = await generateProject(
      makeConfig({ features: ['ai'] }),
      tempDir,
    )

    expect(result.filesCreated).toContain('docker-compose.yml')
    const dockerContent = await readFile(join(result.projectDir, 'docker-compose.yml'), 'utf-8')
    expect(dockerContent).toContain('qdrant')
  })

  it('includes billing env vars when billing feature is selected', async () => {
    const result = await generateProject(
      makeConfig({ features: ['billing'] }),
      tempDir,
    )

    const envContent = await readFile(join(result.projectDir, '.env.example'), 'utf-8')
    expect(envContent).toContain('STRIPE_SECRET_KEY')
  })

  it('includes postgres env vars when database is postgres', async () => {
    const result = await generateProject(
      makeConfig({ database: 'postgres' }),
      tempDir,
    )

    const envContent = await readFile(join(result.projectDir, '.env.example'), 'utf-8')
    expect(envContent).toContain('DATABASE_URL')
    expect(envContent).toContain('postgresql')
  })

  it('uses full-stack template correctly', async () => {
    const result = await generateProject(
      makeConfig({ template: 'full-stack', database: 'postgres' }),
      tempDir,
    )

    expect(result.template).toBe('full-stack')
    expect(result.filesCreated).toContain('src/index.ts')
    expect(result.filesCreated).toContain('docker-compose.yml')
  })

  it('calls onStep callbacks', async () => {
    const steps: string[] = []
    await generateProject(makeConfig(), tempDir, {
      onStep: (step) => steps.push(step),
    })

    expect(steps.length).toBeGreaterThan(0)
    expect(steps.some((s) => s.includes('template'))).toBe(true)
    expect(steps.some((s) => s.includes('package.json'))).toBe(true)
  })

  it('reports gitInitialized=false when initGit=false', async () => {
    const result = await generateProject(makeConfig({ initGit: false }), tempDir)
    expect(result.gitInitialized).toBe(false)
  })

  it('reports depsInstalled=false when installDeps=false', async () => {
    const result = await generateProject(makeConfig({ installDeps: false }), tempDir)
    expect(result.depsInstalled).toBe(false)
  })

  it('interpolates projectName in template files', async () => {
    const result = await generateProject(
      makeConfig({ projectName: 'my-cool-agent' }),
      tempDir,
    )

    const indexContent = await readFile(join(result.projectDir, 'src', 'index.ts'), 'utf-8')
    expect(indexContent).toContain('my-cool-agent')
    expect(indexContent).not.toContain('{{projectName}}')
  })
})
