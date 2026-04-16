import { describe, it, expect } from 'vitest'
import {
  LANGUAGE_CONFIGS,
  detectLanguageFromFiles,
  getLanguagePrompt,
} from '../adaptation/languages/language-config.js'
import type { SupportedLanguage, LanguageConfig } from '../adaptation/languages/language-config.js'
import { PathMapper } from '../adaptation/path-mapper.js'
import { FrameworkAdapter } from '../adaptation/framework-adapter.js'

// ---------------------------------------------------------------------------
// LanguageConfig registry
// ---------------------------------------------------------------------------

describe('LANGUAGE_CONFIGS registry', () => {
  const allLanguages: SupportedLanguage[] = ['typescript', 'python', 'go', 'rust', 'java', 'kotlin']

  it('has entries for every SupportedLanguage', () => {
    for (const lang of allLanguages) {
      expect(LANGUAGE_CONFIGS[lang]).toBeDefined()
      expect(LANGUAGE_CONFIGS[lang].language).toBe(lang)
    }
  })

  it('every config has at least one extension starting with a dot', () => {
    for (const lang of allLanguages) {
      const cfg = LANGUAGE_CONFIGS[lang]
      expect(cfg.extensions.length).toBeGreaterThan(0)
      for (const ext of cfg.extensions) {
        expect(ext.startsWith('.')).toBe(true)
      }
    }
  })

  it('every config has a non-empty promptFragment', () => {
    for (const lang of allLanguages) {
      expect(LANGUAGE_CONFIGS[lang].promptFragment.length).toBeGreaterThan(0)
    }
  })

  it('every config has a sandboxImage', () => {
    for (const lang of allLanguages) {
      expect(LANGUAGE_CONFIGS[lang].sandboxImage.length).toBeGreaterThan(0)
    }
  })

  it('every config has a lintCommand and testCommand', () => {
    for (const lang of allLanguages) {
      const cfg = LANGUAGE_CONFIGS[lang]
      expect(cfg.lintCommand.length).toBeGreaterThan(0)
      expect(cfg.testCommand.length).toBeGreaterThan(0)
    }
  })

  it('every config has at least one detectionFile', () => {
    for (const lang of allLanguages) {
      expect(LANGUAGE_CONFIGS[lang].detectionFiles.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Extension lookup
// ---------------------------------------------------------------------------

describe('extension lookup', () => {
  function findLanguageByExtension(ext: string): SupportedLanguage | null {
    for (const [lang, cfg] of Object.entries(LANGUAGE_CONFIGS)) {
      if (cfg.extensions.includes(ext)) return lang as SupportedLanguage
    }
    return null
  }

  it('.ts maps to typescript', () => {
    expect(findLanguageByExtension('.ts')).toBe('typescript')
  })

  it('.tsx maps to typescript', () => {
    expect(findLanguageByExtension('.tsx')).toBe('typescript')
  })

  it('.py maps to python', () => {
    expect(findLanguageByExtension('.py')).toBe('python')
  })

  it('.go maps to go', () => {
    expect(findLanguageByExtension('.go')).toBe('go')
  })

  it('.rs maps to rust', () => {
    expect(findLanguageByExtension('.rs')).toBe('rust')
  })

  it('.java maps to java', () => {
    expect(findLanguageByExtension('.java')).toBe('java')
  })

  it('.kt maps to kotlin', () => {
    expect(findLanguageByExtension('.kt')).toBe('kotlin')
  })

  it('.kts maps to kotlin', () => {
    expect(findLanguageByExtension('.kts')).toBe('kotlin')
  })

  it('unknown extension returns null', () => {
    expect(findLanguageByExtension('.rb')).toBeNull()
    expect(findLanguageByExtension('.cs')).toBeNull()
    expect(findLanguageByExtension('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Comment syntax per language (embedded in promptFragment)
// ---------------------------------------------------------------------------

describe('comment syntax in promptFragment', () => {
  it('TypeScript prompt mentions ESM imports', () => {
    const prompt = LANGUAGE_CONFIGS.typescript.promptFragment
    expect(prompt).toContain('import')
  })

  it('Python prompt mentions type hints', () => {
    const prompt = LANGUAGE_CONFIGS.python.promptFragment
    expect(prompt).toContain('type hints')
  })

  it('Go prompt mentions error handling', () => {
    const prompt = LANGUAGE_CONFIGS.go.promptFragment
    expect(prompt).toContain('error')
  })

  it('Rust prompt mentions Result<T, E>', () => {
    const prompt = LANGUAGE_CONFIGS.rust.promptFragment
    expect(prompt).toContain('Result')
  })
})

// ---------------------------------------------------------------------------
// detectLanguageFromFiles
// ---------------------------------------------------------------------------

describe('detectLanguageFromFiles', () => {
  it('detects TypeScript from tsconfig.json', () => {
    expect(detectLanguageFromFiles(['tsconfig.json', 'src/index.ts'])).toBe('typescript')
  })

  it('detects TypeScript from package.json', () => {
    expect(detectLanguageFromFiles(['package.json'])).toBe('typescript')
  })

  it('detects Python from pyproject.toml', () => {
    expect(detectLanguageFromFiles(['pyproject.toml'])).toBe('python')
  })

  it('detects Python from requirements.txt', () => {
    expect(detectLanguageFromFiles(['requirements.txt'])).toBe('python')
  })

  it('detects Go from go.mod', () => {
    expect(detectLanguageFromFiles(['go.mod'])).toBe('go')
  })

  it('detects Rust from Cargo.toml', () => {
    expect(detectLanguageFromFiles(['Cargo.toml'])).toBe('rust')
  })

  it('detects Kotlin before Java when build.gradle.kts present', () => {
    expect(detectLanguageFromFiles(['build.gradle.kts'])).toBe('kotlin')
  })

  it('detects Java from build.gradle (not .kts)', () => {
    expect(detectLanguageFromFiles(['build.gradle'])).toBe('java')
  })

  it('detects Java from pom.xml', () => {
    expect(detectLanguageFromFiles(['pom.xml'])).toBe('java')
  })

  it('returns null for unknown project', () => {
    expect(detectLanguageFromFiles(['README.md', 'Makefile'])).toBeNull()
  })

  it('returns null for empty list', () => {
    expect(detectLanguageFromFiles([])).toBeNull()
  })

  it('strips directory prefix from filenames', () => {
    expect(detectLanguageFromFiles(['some/deep/path/tsconfig.json'])).toBe('typescript')
  })

  it('respects priority: TypeScript wins over Python when both present', () => {
    expect(detectLanguageFromFiles(['package.json', 'requirements.txt'])).toBe('typescript')
  })
})

// ---------------------------------------------------------------------------
// getLanguagePrompt
// ---------------------------------------------------------------------------

describe('getLanguagePrompt', () => {
  it('returns the prompt fragment for typescript', () => {
    const prompt = getLanguagePrompt('typescript')
    expect(prompt).toBe(LANGUAGE_CONFIGS.typescript.promptFragment)
  })

  it('returns the prompt fragment for python', () => {
    const prompt = getLanguagePrompt('python')
    expect(prompt).toBe(LANGUAGE_CONFIGS.python.promptFragment)
  })

  it('returns a non-empty string for every language', () => {
    const langs: SupportedLanguage[] = ['typescript', 'python', 'go', 'rust', 'java', 'kotlin']
    for (const lang of langs) {
      expect(getLanguagePrompt(lang).length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// PathMapper
// ---------------------------------------------------------------------------

describe('PathMapper', () => {
  it('maps a matching source path to target', () => {
    const mapper = new PathMapper()
    mapper.addMapping('routes/(.*)\\.routes\\.ts', 'app/api/$1/route.ts')
    expect(mapper.map('routes/users.routes.ts')).toBe('app/api/users/route.ts')
  })

  it('returns null for non-matching path', () => {
    const mapper = new PathMapper()
    mapper.addMapping('routes/(.*)\\.routes\\.ts', 'app/api/$1/route.ts')
    expect(mapper.map('services/users.service.ts')).toBeNull()
  })

  it('uses first matching rule', () => {
    const mapper = new PathMapper()
    mapper.addMapping('src/(.*)\\.ts', 'lib/$1.js')
    mapper.addMapping('src/(.*)\\.ts', 'dist/$1.js')
    expect(mapper.map('src/foo.ts')).toBe('lib/foo.js')
  })

  it('supports chaining with addMapping', () => {
    const mapper = new PathMapper()
    const result = mapper.addMapping('a', 'b').addMapping('c', 'd')
    expect(result).toBe(mapper)
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter
// ---------------------------------------------------------------------------

describe('FrameworkAdapter', () => {
  it('maps express route to nextjs route', () => {
    const adapter = new FrameworkAdapter()
    const result = adapter.mapPath('routes/users.routes.ts', 'express', 'nextjs')
    expect(result).toBe('app/api/users/route.ts')
  })

  it('maps express route to fastify route', () => {
    const adapter = new FrameworkAdapter()
    const result = adapter.mapPath('routes/users.routes.ts', 'express', 'fastify')
    expect(result).toBe('src/routes/users.routes.ts')
  })

  it('maps nextjs route back to express', () => {
    const adapter = new FrameworkAdapter()
    const result = adapter.mapPath('app/api/users/route.ts', 'nextjs', 'express')
    expect(result).toBe('src/routes/users.routes.ts')
  })

  it('returns null for unmapped path', () => {
    const adapter = new FrameworkAdapter()
    expect(adapter.mapPath('random/file.ts', 'express', 'nextjs')).toBeNull()
  })

  it('returns null for unknown framework pair', () => {
    const adapter = new FrameworkAdapter()
    expect(adapter.mapPath('routes/users.routes.ts', 'django', 'flask')).toBeNull()
  })

  it('returns adaptation guide for vue3->react', () => {
    const adapter = new FrameworkAdapter()
    const guide = adapter.getAdaptationGuide('vue3', 'react')
    expect(guide).not.toBeNull()
    expect(guide!).toContain('useState')
    expect(guide!).toContain('ref()')
  })

  it('returns adaptation guide for react->vue3', () => {
    const adapter = new FrameworkAdapter()
    const guide = adapter.getAdaptationGuide('react', 'vue3')
    expect(guide).not.toBeNull()
    expect(guide!).toContain('defineProps')
  })

  it('returns null for unknown guide pair', () => {
    const adapter = new FrameworkAdapter()
    expect(adapter.getAdaptationGuide('angular', 'react')).toBeNull()
  })

  it('supports adding custom backend mappings', () => {
    const adapter = new FrameworkAdapter()
    const mapper = new PathMapper()
    mapper.addMapping('pages/(.*)\\.vue', 'pages/$1.tsx')
    adapter.addBackendMapping('nuxt', 'nextjs', mapper)
    expect(adapter.mapPath('pages/index.vue', 'nuxt', 'nextjs')).toBe('pages/index.tsx')
  })

  it('supports adding custom frontend guides', () => {
    const adapter = new FrameworkAdapter()
    adapter.addFrontendGuide('angular', 'react', 'Use hooks instead of services')
    expect(adapter.getAdaptationGuide('angular', 'react')).toBe('Use hooks instead of services')
  })

  it('addBackendMapping and addFrontendGuide support chaining', () => {
    const adapter = new FrameworkAdapter()
    const mapper = new PathMapper()
    const result = adapter.addBackendMapping('a', 'b', mapper).addFrontendGuide('c', 'd', 'guide')
    expect(result).toBe(adapter)
  })
})
