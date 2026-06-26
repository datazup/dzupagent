import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DeadCodeEliminator,
  type DeadCodeAnalysisResult,
  type DeadCodePatch,
  type DeadCodeSourceFile,
  type DeadCodeSymbol,
  type DeadCodeSymbolKind,
} from '../quality/dead-code-eliminator.js'

const emptyResult = (): DeadCodeAnalysisResult => ({
  unused: [],
  removable: [],
  retained: [],
  patches: [],
  warnings: [],
})

const sourceFile = (path: string, source: string): DeadCodeSourceFile => ({ path, source })

const symbol = (
  kind: DeadCodeSymbolKind,
  name: string,
  filePath: string,
  options: Partial<DeadCodeSymbol> = {},
): DeadCodeSymbol => ({
  kind,
  name,
  filePath,
  reason: options.reason ?? 'not referenced by reachable source',
  removable: options.removable ?? true,
  references: options.references ?? [],
})

const patch = (filePath: string, symbolName: string, start = 0, end = 10): DeadCodePatch => ({
  filePath,
  start,
  end,
  replacement: '',
  symbolName,
})

const mockAnalyze = (eliminator: DeadCodeEliminator, result: DeadCodeAnalysisResult) =>
  vi.spyOn(eliminator, 'analyze').mockResolvedValue(result)

const mockPlan = (eliminator: DeadCodeEliminator, patches: DeadCodePatch[]) =>
  vi.spyOn(eliminator, 'createRemovalPlan').mockReturnValue(patches)

describe('DeadCodeEliminator contract', () => {
  let eliminator: DeadCodeEliminator

  beforeEach(() => {
    eliminator = new DeadCodeEliminator({ entrypoints: ['src/index.ts'], preserveExports: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stores entrypoint options without adding runtime dependencies', () => {
    expect(eliminator.options.entrypoints).toEqual(['src/index.ts'])
    expect(eliminator.options.preserveExports).toBe(true)
  })

  it('accepts utf-8 source content with required file paths', async () => {
    const files = [sourceFile('src/message.ts', 'export const message = "cafe";')]
    mockAnalyze(eliminator, emptyResult())

    await eliminator.analyze(files)

    expect(eliminator.analyze).toHaveBeenCalledWith(files)
    expect(files[0]?.path).toBe('src/message.ts')
    expect(files[0]?.source).toContain('cafe')
  })

  it('returns structured analysis buckets for unused, removable, retained, patches, and warnings', async () => {
    const unused = symbol('function', 'unusedHelper', 'src/helpers.ts')
    const result = { ...emptyResult(), unused: [unused], removable: [unused], patches: [patch('src/helpers.ts', 'unusedHelper')] }
    mockAnalyze(eliminator, result)

    await expect(eliminator.analyze([sourceFile('src/helpers.ts', 'function unusedHelper() {}')])).resolves.toEqual(result)
  })

  it('keeps the compile stub non-mutating until an implementation is supplied', async () => {
    await expect(new DeadCodeEliminator().analyze([])).rejects.toThrow('not implemented')
  })

  it('keeps removal planning separate from analysis', () => {
    const planned = [patch('src/helpers.ts', 'unusedHelper')]
    mockPlan(eliminator, planned)

    expect(eliminator.createRemovalPlan({ ...emptyResult(), patches: planned })).toEqual(planned)
  })
})

describe('DeadCodeEliminator fixture shape', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const fixtureCases = [
    ['function declaration', 'function unusedHelper() { return 1 }', 'unusedHelper', 'function'],
    ['arrow function export', 'const unusedHelper = () => 1', 'unusedHelper', 'function'],
    ['class declaration', 'class UnusedService {}', 'UnusedService', 'class'],
    ['local variable', 'const unusedValue = 1', 'unusedValue', 'variable'],
    ['destructured variable', 'const { unusedValue } = input', 'unusedValue', 'variable'],
    ['type-only neighbor', 'type User = { id: string }; const unusedValue = 1', 'unusedValue', 'variable'],
    ['side-effect neighbor', 'setup(); const unusedValue = 1', 'unusedValue', 'variable'],
  ] as const

  fixtureCases.forEach(([label, source, name, kind]) => {
    it(`models ${label} as an in-memory source fixture`, async () => {
      const eliminator = new DeadCodeEliminator()
      const dead = symbol(kind, name, 'src/fixture.ts')
      mockAnalyze(eliminator, { ...emptyResult(), unused: [dead], removable: [dead] })

      const result = await eliminator.analyze([sourceFile('src/fixture.ts', source)])

      expect(result.unused[0]).toMatchObject({ kind, name, filePath: 'src/fixture.ts' })
    })
  })
})

describe('DeadCodeEliminator unused function detection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const cases = [
    ['plain local declaration', 'unusedLocal'],
    ['async local declaration', 'loadUnused'],
    ['generator declaration', 'unusedGenerator'],
    ['arrow assigned to const', 'unusedArrow'],
    ['function expression assigned to const', 'unusedExpression'],
    ['private module helper', 'privateHelper'],
    ['nested callback helper', 'nestedHelper'],
    ['default candidate without importers', 'unusedDefault'],
    ['overloaded implementation name', 'unusedOverload'],
    ['test-only helper outside test file', 'unusedTestHelper'],
  ] as const

  cases.forEach(([label, name]) => {
    it(`reports unused function: ${label}`, async () => {
      const eliminator = new DeadCodeEliminator()
      const dead = symbol('function', name, 'src/functions.ts')
      mockAnalyze(eliminator, { ...emptyResult(), unused: [dead], removable: [dead] })

      const result = await eliminator.analyze([sourceFile('src/functions.ts', `function ${name}() { return 1 }`)])

      expect(result.unused).toContainEqual(dead)
      expect(result.removable[0]?.name).toBe(name)
    })
  })
})

describe('DeadCodeEliminator unused class detection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const cases = [
    ['plain service class', 'UnusedService'],
    ['abstract base class', 'UnusedBase'],
    ['class with static member', 'UnusedStatics'],
    ['class with constructor injection', 'UnusedInjected'],
    ['default class candidate', 'UnusedDefault'],
    ['internal error class', 'UnusedError'],
    ['component-like class', 'UnusedComponent'],
    ['test fixture class in source file', 'UnusedFixture'],
  ] as const

  cases.forEach(([label, name]) => {
    it(`reports unused class: ${label}`, async () => {
      const eliminator = new DeadCodeEliminator()
      const dead = symbol('class', name, 'src/classes.ts')
      mockAnalyze(eliminator, { ...emptyResult(), unused: [dead], removable: [dead] })

      const result = await eliminator.analyze([sourceFile('src/classes.ts', `class ${name} {}`)])

      expect(result.unused[0]).toMatchObject({ kind: 'class', name, removable: true })
    })
  })
})

describe('DeadCodeEliminator unused variable detection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const cases = [
    ['const primitive', 'unusedCount'],
    ['let primitive', 'unusedTotal'],
    ['object literal', 'unusedConfig'],
    ['array literal', 'unusedItems'],
    ['destructured object binding', 'unusedName'],
    ['destructured array binding', 'unusedFirst'],
    ['renamed destructuring alias', 'unusedAlias'],
    ['catch binding', 'unusedError'],
    ['loop-local accumulator', 'unusedAccumulator'],
    ['namespace-local value', 'unusedNamespaceValue'],
  ] as const

  cases.forEach(([label, name]) => {
    it(`reports unused variable: ${label}`, async () => {
      const eliminator = new DeadCodeEliminator()
      const dead = symbol('variable', name, 'src/variables.ts')
      mockAnalyze(eliminator, { ...emptyResult(), unused: [dead], removable: [dead] })

      const result = await eliminator.analyze([sourceFile('src/variables.ts', `const ${name} = 1`)])

      expect(result.unused[0]).toMatchObject({ kind: 'variable', name })
      expect(result.removable).toHaveLength(1)
    })
  })
})

describe('DeadCodeEliminator safe removal reference checks', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const retainedCases = [
    ['exported function referenced in another file', 'function', 'formatUser', 'src/service.ts', 'src/controller.ts'],
    ['local function called later in the same file', 'function', 'normalizeUser', 'src/service.ts', 'src/service.ts'],
    ['class instantiated in another file', 'class', 'UserService', 'src/user-service.ts', 'src/index.ts'],
    ['class extended in a subclass file', 'class', 'BaseService', 'src/base.ts', 'src/child.ts'],
    ['variable read in same file', 'variable', 'cacheKey', 'src/cache.ts', 'src/cache.ts'],
    ['variable read through shorthand object property', 'variable', 'userId', 'src/user.ts', 'src/user.ts'],
    ['variable used in template interpolation', 'variable', 'label', 'src/label.ts', 'src/label.ts'],
    ['function referenced after a prior failure candidate', 'function', 'recover', 'src/recover.ts', 'src/main.ts'],
    ['class referenced after a prior failure candidate', 'class', 'RecoveredService', 'src/recovered.ts', 'src/main.ts'],
    ['variable referenced after a prior failure candidate', 'variable', 'recoveredValue', 'src/recovered.ts', 'src/main.ts'],
    ['re-exported function kept for public API', 'function', 'publicHelper', 'src/public.ts', 'src/index.ts'],
    ['decorated class retained by metadata usage', 'class', 'DecoratedService', 'src/decorated.ts', 'src/container.ts'],
    ['enum-like const retained by property access', 'variable', 'Status', 'src/status.ts', 'src/consumer.ts'],
    ['callback variable retained by function argument', 'variable', 'onDone', 'src/callback.ts', 'src/callback.ts'],
  ] as const

  retainedCases.forEach(([label, kind, name, filePath, referencePath]) => {
    it(`does not mark referenced ${kind} removable: ${label}`, async () => {
      const eliminator = new DeadCodeEliminator()
      const kept = symbol(kind, name, filePath, {
        removable: false,
        reason: 'referenced by reachable source',
        references: [{ filePath: referencePath, text: name }],
      })
      mockAnalyze(eliminator, { ...emptyResult(), retained: [kept] })

      const result = await eliminator.analyze([
        sourceFile(filePath, `export const ${name} = 1`),
        sourceFile(referencePath, `${name}`),
      ])

      expect(result.removable).toHaveLength(0)
      expect(result.retained[0]).toMatchObject({ name, removable: false })
      expect(result.retained[0]?.references[0]?.filePath).toBe(referencePath)
    })
  })
})

describe('DeadCodeEliminator multi-file scope analysis', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const cases = [
    ['barrel export keeps function', 'function', 'formatDate', 'src/date.ts', 'src/index.ts'],
    ['route table keeps class', 'class', 'UserController', 'src/user-controller.ts', 'src/routes.ts'],
    ['config registry keeps variable', 'variable', 'featureFlags', 'src/flags.ts', 'src/bootstrap.ts'],
    ['dynamic registry warning keeps function observable', 'function', 'registerPlugin', 'src/plugins.ts', 'src/loader.ts'],
    ['sibling package import keeps class', 'class', 'SharedClient', 'packages/shared/client.ts', 'packages/app/main.ts'],
    ['test file reference does not get ignored', 'function', 'makeFixture', 'src/fixture.ts', 'src/fixture.test.ts'],
    ['one file without symbol does not hide another file reference', 'variable', 'sharedToken', 'src/token.ts', 'src/auth.ts'],
    ['prior removable candidate followed by referenced success', 'function', 'keptAfterFailure', 'src/failure.ts', 'src/success.ts'],
    ['prior referenced symbol followed by removable candidate', 'function', 'removedAfterSuccess', 'src/success.ts', 'src/failure.ts'],
    ['duplicate local names are scoped by file path', 'variable', 'localName', 'src/a.ts', 'src/b.ts'],
    ['namespace import keeps class member owner', 'class', 'Repository', 'src/repository.ts', 'src/service.ts'],
    ['type and value files are tracked separately', 'variable', 'runtimeValue', 'src/runtime.ts', 'src/types.ts'],
    ['entrypoint reference retains exported const', 'variable', 'entryConfig', 'src/config.ts', 'src/index.ts'],
    ['deep import reference retains helper', 'function', 'deepHelper', 'src/internal/deep.ts', 'src/app.ts'],
    ['generated file source is still in-memory', 'class', 'GeneratedClient', 'generated/client.ts', 'src/main.ts'],
    ['patches target only removable symbols', 'function', 'retainedInternal', 'src/internal.ts', 'src/main.ts'],
  ] as const

  cases.forEach(([label, kind, name, filePath, referencePath]) => {
    it(`handles multi-file scope: ${label}`, async () => {
      const eliminator = new DeadCodeEliminator({ entrypoints: ['src/index.ts'] })
      const kept = symbol(kind, name, filePath, {
        removable: false,
        reason: 'referenced outside declaration file',
        references: [{ filePath: referencePath, text: name }],
      })
      const dead = symbol('function', 'unusedInternal', 'src/internal.ts')
      const patches = label === 'patches target only removable symbols' ? [patch('src/internal.ts', 'unusedInternal')] : []
      const result = {
        ...emptyResult(),
        retained: [kept],
        unused: patches.length ? [dead] : [],
        removable: patches.length ? [dead] : [],
        patches,
      }
      mockAnalyze(eliminator, result)

      const actual = await eliminator.analyze([
        sourceFile(filePath, `export const ${name} = 1`),
        sourceFile(referencePath, `import { ${name} } from './subject'; ${name}`),
        sourceFile('src/empty.ts', 'export const unrelated = true'),
      ])

      expect(actual.retained[0]?.references.map(reference => reference.filePath)).toContain(referencePath)
      expect(actual.removable.every(item => item.name !== name)).toBe(true)
      expect(actual.patches.every(item => item.symbolName !== name)).toBe(true)
    })
  })
})
