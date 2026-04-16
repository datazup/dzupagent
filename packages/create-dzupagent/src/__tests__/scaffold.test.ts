import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ScaffoldEngine } from '../scaffold-engine.js'
import { renderTemplate } from '../template-renderer.js'
import {
  templateRegistry,
  minimalTemplate,
  fullStackTemplate,
  codegenTemplate,
  multiAgentTemplate,
  serverTemplate,
  productionSaasAgentTemplate,
  secureInternalAssistantTemplate,
  costConstrainedWorkerTemplate,
  researchTemplate,
  getTemplate,
  listTemplates,
} from '../templates/index.js'
import type { TemplateType } from '../types.js'

describe('renderTemplate', () => {
  it('replaces {{variable}} placeholders with values', () => {
    const result = renderTemplate('Hello {{name}}, welcome to {{place}}!', {
      name: 'Alice',
      place: 'Wonderland',
    })
    expect(result).toBe('Hello Alice, welcome to Wonderland!')
  })

  it('leaves unknown variables as-is', () => {
    const result = renderTemplate('Hello {{name}}, {{unknown}} here.', {
      name: 'Bob',
    })
    expect(result).toBe('Hello Bob, {{unknown}} here.')
  })

  it('handles empty variables map', () => {
    const result = renderTemplate('No {{vars}} replaced.', {})
    expect(result).toBe('No {{vars}} replaced.')
  })

  it('handles content with no placeholders', () => {
    const result = renderTemplate('plain text', { name: 'ignored' })
    expect(result).toBe('plain text')
  })

  it('replaces multiple occurrences of the same variable', () => {
    const result = renderTemplate('{{x}} and {{x}} again', { x: 'hi' })
    expect(result).toBe('hi and hi again')
  })
})

describe('Template Manifests', () => {
  const templateTypes: TemplateType[] = ['minimal', 'full-stack', 'codegen', 'multi-agent', 'server', 'production-saas-agent', 'secure-internal-assistant', 'cost-constrained-worker', 'research']

  it('all 9 templates exist in the registry', () => {
    expect(Object.keys(templateRegistry)).toHaveLength(9)
    for (const t of templateTypes) {
      expect(templateRegistry[t]).toBeDefined()
    }
  })

  it('each template has required fields', () => {
    for (const t of templateTypes) {
      const manifest = templateRegistry[t]
      expect(manifest.id).toBe(t)
      expect(manifest.name).toBeTruthy()
      expect(manifest.description).toBeTruthy()
      expect(manifest.files.length).toBeGreaterThan(0)
      expect(Object.keys(manifest.dependencies).length).toBeGreaterThan(0)
    }
  })

  it('each template includes a package.json file', () => {
    for (const t of templateTypes) {
      const manifest = templateRegistry[t]
      const pkgFile = manifest.files.find((f) => f.path === 'package.json')
      expect(pkgFile).toBeDefined()
    }
  })

  it('each template includes a .gitignore file', () => {
    for (const t of templateTypes) {
      const manifest = templateRegistry[t]
      const gitignore = manifest.files.find((f) => f.path === '.gitignore')
      expect(gitignore).toBeDefined()
    }
  })

  it('getTemplate throws for unknown template', () => {
    expect(() => getTemplate('nonexistent' as TemplateType)).toThrow('Unknown template')
  })

  it('listTemplates returns all templates', () => {
    const all = listTemplates()
    expect(all).toHaveLength(9)
  })

  it('specific templates are correctly imported', () => {
    expect(minimalTemplate.id).toBe('minimal')
    expect(fullStackTemplate.id).toBe('full-stack')
    expect(codegenTemplate.id).toBe('codegen')
    expect(multiAgentTemplate.id).toBe('multi-agent')
    expect(serverTemplate.id).toBe('server')
    expect(productionSaasAgentTemplate.id).toBe('production-saas-agent')
    expect(secureInternalAssistantTemplate.id).toBe('secure-internal-assistant')
    expect(costConstrainedWorkerTemplate.id).toBe('cost-constrained-worker')
    expect(researchTemplate.id).toBe('research')
  })
})

describe('ScaffoldEngine', () => {
  let tempDir: string
  let engine: ScaffoldEngine

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-scaffold-'))
    engine = new ScaffoldEngine()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('generates a minimal template project', async () => {
    const result = await engine.generate({
      projectName: 'test-agent',
      template: 'minimal',
      outputDir: tempDir,
    })

    expect(result.template).toBe('minimal')
    expect(result.projectDir).toBe(join(tempDir, 'test-agent'))
    expect(result.filesCreated.length).toBeGreaterThan(0)
    expect(result.filesCreated).toContain('package.json')
    expect(result.filesCreated).toContain('src/index.ts')
  })

  it('creates files on disk with correct content', async () => {
    await engine.generate({
      projectName: 'my-bot',
      template: 'minimal',
      outputDir: tempDir,
    })

    const pkgContent = await readFile(join(tempDir, 'my-bot', 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgContent) as Record<string, unknown>
    expect(pkg['name']).toBe('my-bot')
  })

  it('performs variable interpolation in generated files', async () => {
    await engine.generate({
      projectName: 'cool-agent',
      template: 'minimal',
      outputDir: tempDir,
    })

    const indexContent = await readFile(
      join(tempDir, 'cool-agent', 'src', 'index.ts'),
      'utf-8',
    )
    expect(indexContent).toContain('cool-agent')
    expect(indexContent).not.toContain('{{projectName}}')
  })

  it('generates a full-stack template with server files', async () => {
    const result = await engine.generate({
      projectName: 'full-app',
      template: 'full-stack',
      outputDir: tempDir,
    })

    expect(result.template).toBe('full-stack')
    expect(result.filesCreated).toContain('.env.example')

    const envContent = await readFile(
      join(tempDir, 'full-app', '.env.example'),
      'utf-8',
    )
    expect(envContent).toContain('full-app')
  })

  it('generates a server template with Dockerfile', async () => {
    const result = await engine.generate({
      projectName: 'srv',
      template: 'server',
      outputDir: tempDir,
    })

    expect(result.filesCreated).toContain('Dockerfile')
    const dockerContent = await readFile(
      join(tempDir, 'srv', 'Dockerfile'),
      'utf-8',
    )
    expect(dockerContent).toContain('FROM node:')
    expect(dockerContent).toContain('appuser')
  })

  it('creates nested directories for file paths', async () => {
    const result = await engine.generate({
      projectName: 'nested-test',
      template: 'multi-agent',
      outputDir: tempDir,
    })

    expect(result.filesCreated).toContain('src/agents/planner.ts')
    const plannerContent = await readFile(
      join(tempDir, 'nested-test', 'src', 'agents', 'planner.ts'),
      'utf-8',
    )
    expect(plannerContent).toContain('nested-test')
  })
})

// ---------------------------------------------------------------------------
// Task 2: E2E scaffold — create temp dir, run scaffold, verify files on disk
// ---------------------------------------------------------------------------
describe('E2E scaffold', () => {
  let tempDir: string
  let engine: ScaffoldEngine

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-e2e-'))
    engine = new ScaffoldEngine()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('generates a minimal project with valid package.json, tsconfig, and source', async () => {
    const result = await engine.generate({
      projectName: 'e2e-agent',
      template: 'minimal',
      outputDir: tempDir,
    })

    const projectDir = result.projectDir

    // Key files exist on disk
    expect(result.filesCreated).toContain('package.json')
    expect(result.filesCreated).toContain('tsconfig.json')
    expect(result.filesCreated).toContain('src/index.ts')

    // package.json is valid JSON with the correct name
    const pkgRaw = await readFile(join(projectDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>
    expect(pkg['name']).toBe('e2e-agent')
    expect(pkg['type']).toBe('module')

    // tsconfig.json is valid JSON with strict mode
    const tsRaw = await readFile(join(projectDir, 'tsconfig.json'), 'utf-8')
    const tsconfig = JSON.parse(tsRaw) as Record<string, unknown>
    const compilerOptions = tsconfig['compilerOptions'] as Record<string, unknown> | undefined
    expect(compilerOptions).toBeDefined()
    expect(compilerOptions?.['strict']).toBe(true)

    // src/index.ts exists and contains interpolated project name
    const indexContent = await readFile(join(projectDir, 'src', 'index.ts'), 'utf-8')
    expect(indexContent).toContain('e2e-agent')
    expect(indexContent).not.toContain('{{projectName}}')

    // No leftover {{template}} variable in config
    const configRaw = await readFile(join(projectDir, 'dzupagent.config.json'), 'utf-8')
    expect(configRaw).not.toContain('{{template}}')
    expect(configRaw).toContain('"minimal"')
  })
})

// ---------------------------------------------------------------------------
// Task 3: Parameterized — every template produces required files
// ---------------------------------------------------------------------------
describe('All templates produce required files', () => {
  const allTemplates: TemplateType[] = ['minimal', 'full-stack', 'codegen', 'multi-agent', 'server', 'production-saas-agent', 'secure-internal-assistant', 'cost-constrained-worker', 'research']
  let tempDir: string
  let engine: ScaffoldEngine

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-param-'))
    engine = new ScaffoldEngine()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it.each(allTemplates)('template "%s" produces valid package.json, tsconfig.json, and src/*.ts', async (templateId) => {
    const result = await engine.generate({
      projectName: `test-${templateId}`,
      template: templateId,
      outputDir: tempDir,
    })

    const projectDir = result.projectDir

    // package.json is present and valid JSON
    const pkgRaw = await readFile(join(projectDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>
    expect(pkg['name']).toBe(`test-${templateId}`)

    // tsconfig.json is present and valid JSON
    const tsRaw = await readFile(join(projectDir, 'tsconfig.json'), 'utf-8')
    expect(() => JSON.parse(tsRaw)).not.toThrow()

    // At least one .ts file in src/
    const srcDir = join(projectDir, 'src')
    const srcStat = await stat(srcDir)
    expect(srcStat.isDirectory()).toBe(true)

    const srcEntries = await collectTsFiles(srcDir)
    expect(srcEntries.length).toBeGreaterThan(0)

    // No un-interpolated {{projectName}} in any generated file
    for (const filePath of result.filesCreated) {
      const content = await readFile(join(projectDir, filePath), 'utf-8')
      expect(content).not.toContain('{{projectName}}')
      expect(content).not.toContain('{{template}}')
    }
  })
})

/**
 * Recursively collect all .ts files under a directory.
 */
async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await collectTsFiles(fullPath)
      result.push(...nested)
    } else if (entry.name.endsWith('.ts')) {
      result.push(fullPath)
    }
  }
  return result
}
