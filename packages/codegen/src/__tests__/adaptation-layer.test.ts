/**
 * W15-D3: Adaptation layer deep-coverage tests.
 *
 * Covers PathMapper edge cases, FrameworkAdapter builtin mapping completeness,
 * frontend guide content validation, language config field-level assertions,
 * and cross-cutting concerns (extension uniqueness, detection priority, etc.).
 */

import { describe, it, expect } from 'vitest'
import { PathMapper } from '../adaptation/path-mapper.js'
import { FrameworkAdapter } from '../adaptation/framework-adapter.js'
import {
  LANGUAGE_CONFIGS,
  detectLanguageFromFiles,
  getLanguagePrompt,
} from '../adaptation/languages/language-config.js'
import type { SupportedLanguage, LanguageConfig } from '../adaptation/languages/language-config.js'

// ---------------------------------------------------------------------------
// PathMapper — edge cases
// ---------------------------------------------------------------------------

describe('PathMapper edge cases', () => {
  it('handles multiple capture groups in pattern', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^(\\w+)/(\\w+)\\.ts$', 'out/$2-$1.js')
    expect(mapper.map('foo/bar.ts')).toBe('out/bar-foo.js')
  })

  it('handles pattern that matches entire string', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^(.*)$', 'prefix/$1')
    expect(mapper.map('anything/here.ts')).toBe('prefix/anything/here.ts')
  })

  it('handles pattern with special regex characters in replacement', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^src/(.+)$', 'out/$1')
    expect(mapper.map('src/foo/bar.ts')).toBe('out/foo/bar.ts')
  })

  it('does not match partial string when anchored', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^src/index\\.ts$', 'dist/index.js')
    expect(mapper.map('prefix/src/index.ts')).toBeNull()
  })

  it('matches partial string when not anchored', () => {
    const mapper = new PathMapper()
    mapper.addMapping('index\\.ts', 'index.js')
    expect(mapper.map('src/index.ts')).toBe('src/index.js')
  })

  it('processes many mappings and picks the correct first match', () => {
    const mapper = new PathMapper()
    for (let i = 0; i < 20; i++) {
      mapper.addMapping(`^miss${i}/`, `out${i}/`)
    }
    mapper.addMapping('^hit/', 'found/')
    expect(mapper.map('hit/file.ts')).toBe('found/file.ts')
  })

  it('returns null for empty string input when no catch-all exists', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^src/', 'dist/')
    expect(mapper.map('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter — express->sveltekit complete coverage
// ---------------------------------------------------------------------------

describe('FrameworkAdapter express->sveltekit mappings', () => {
  const adapter = new FrameworkAdapter()

  it('maps controller files', () => {
    const result = adapter.mapPath('controllers/auth.controller.ts', 'express', 'sveltekit')
    expect(result).toContain('+server.ts')
    expect(result).toContain('auth')
  })

  it('maps service files', () => {
    const result = adapter.mapPath('services/user.service.ts', 'express', 'sveltekit')
    expect(result).toContain('server/services')
    expect(result).toContain('user.service.ts')
  })

  it('maps schema files', () => {
    const result = adapter.mapPath('schemas/auth.schemas.ts', 'express', 'sveltekit')
    expect(result).toContain('schemas')
    expect(result).toContain('auth.schemas.ts')
  })

  it('returns null for middleware (no sveltekit middleware mapping)', () => {
    const result = adapter.mapPath('middleware/cors.ts', 'express', 'sveltekit')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter — express->fastify complete coverage
// ---------------------------------------------------------------------------

describe('FrameworkAdapter express->fastify mappings', () => {
  const adapter = new FrameworkAdapter()

  it('maps route files', () => {
    const result = adapter.mapPath('routes/users.routes.ts', 'express', 'fastify')
    expect(result).toBe('src/routes/users.routes.ts')
  })

  it('maps controller files to routes', () => {
    const result = adapter.mapPath('controllers/auth.controller.ts', 'express', 'fastify')
    expect(result).toBe('src/routes/auth.routes.ts')
  })

  it('maps service files', () => {
    const result = adapter.mapPath('services/data.service.ts', 'express', 'fastify')
    expect(result).toBe('src/services/data.service.ts')
  })

  it('maps middleware to plugins', () => {
    const result = adapter.mapPath('middleware/auth.ts', 'express', 'fastify')
    expect(result).toBe('src/plugins/auth.plugin.ts')
  })

  it('returns null for unmapped schema path', () => {
    const result = adapter.mapPath('schemas/user.schemas.ts', 'express', 'fastify')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter — nextjs->express complete coverage
// ---------------------------------------------------------------------------

describe('FrameworkAdapter nextjs->express mappings', () => {
  const adapter = new FrameworkAdapter()

  it('maps service files', () => {
    const result = adapter.mapPath('lib/services/user.service.ts', 'nextjs', 'express')
    expect(result).toBe('src/services/user.service.ts')
  })

  it('maps schema files', () => {
    const result = adapter.mapPath('lib/schemas/auth.schemas.ts', 'nextjs', 'express')
    expect(result).toBe('src/schemas/auth.schemas.ts')
  })

  it('returns null for unmapped lib/middleware path', () => {
    const result = adapter.mapPath('lib/middleware/cors.ts', 'nextjs', 'express')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter — frontend guide content validation
// ---------------------------------------------------------------------------

describe('FrameworkAdapter frontend guide content', () => {
  const adapter = new FrameworkAdapter()

  describe('vue3->react guide', () => {
    const guide = adapter.getAdaptationGuide('vue3', 'react')!

    it('contains reactive state mapping', () => {
      expect(guide).toContain('reactive()')
    })

    it('contains computed mapping', () => {
      expect(guide).toContain('useMemo()')
    })

    it('contains lifecycle mapping', () => {
      expect(guide).toContain('onMounted()')
      expect(guide).toContain('useEffect')
    })

    it('contains template-to-JSX mapping', () => {
      expect(guide).toContain('<template>')
      expect(guide).toContain('JSX')
    })

    it('contains event binding mapping', () => {
      expect(guide).toContain('@click')
      expect(guide).toContain('onClick')
    })

    it('contains v-model mapping', () => {
      expect(guide).toContain('v-model')
      expect(guide).toContain('onChange')
    })

    it('contains store migration mapping', () => {
      expect(guide).toContain('Pinia')
      expect(guide).toContain('Zustand')
    })
  })

  describe('vue3->svelte guide', () => {
    const guide = adapter.getAdaptationGuide('vue3', 'svelte')!

    it('contains rune mappings', () => {
      expect(guide).toContain('$state')
      expect(guide).toContain('$derived')
      expect(guide).toContain('$effect')
    })

    it('contains template syntax mapping', () => {
      expect(guide).toContain('{#if}')
      expect(guide).toContain('{#each}')
    })

    it('contains props mapping', () => {
      expect(guide).toContain('defineProps')
      expect(guide).toContain('$props')
    })
  })

  describe('react->svelte guide', () => {
    const guide = adapter.getAdaptationGuide('react', 'svelte')!

    it('contains useState replacement', () => {
      expect(guide).toContain('useState')
      expect(guide).toContain('$state')
    })

    it('contains useMemo replacement', () => {
      expect(guide).toContain('useMemo')
      expect(guide).toContain('$derived')
    })

    it('contains conditional rendering mapping', () => {
      expect(guide).toContain('{#if')
    })
  })

  describe('react->vue3 guide', () => {
    const guide = adapter.getAdaptationGuide('react', 'vue3')!

    it('contains defineProps and defineEmits', () => {
      expect(guide).toContain('defineProps')
      expect(guide).toContain('defineEmits')
    })

    it('contains v-if and v-for directives', () => {
      expect(guide).toContain('v-if')
      expect(guide).toContain('v-for')
    })

    it('contains Pinia store mapping', () => {
      expect(guide).toContain('Pinia')
    })
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter — custom mapping interaction with builtins
// ---------------------------------------------------------------------------

describe('FrameworkAdapter custom mapping behavior', () => {
  it('custom mapping does not shadow builtin for same pair', () => {
    const adapter = new FrameworkAdapter()
    const mapper = new PathMapper()
    mapper.addMapping('^custom-only/', 'custom-out/')
    adapter.addBackendMapping('express', 'nextjs', mapper)

    // Builtin should still work for its own patterns
    expect(adapter.mapPath('routes/users.routes.ts', 'express', 'nextjs')).toBe('app/api/users/route.ts')
    // Custom should also work for its own pattern
    expect(adapter.mapPath('custom-only/file.ts', 'express', 'nextjs')).toBe('custom-out/file.ts')
  })

  it('custom frontend guide does not shadow builtin for different pair', () => {
    const adapter = new FrameworkAdapter()
    adapter.addFrontendGuide('angular', 'react', 'Custom guide')
    // Builtin vue3->react should still work
    expect(adapter.getAdaptationGuide('vue3', 'react')).toContain('useState')
    // Custom angular->react should also work
    expect(adapter.getAdaptationGuide('angular', 'react')).toBe('Custom guide')
  })

  it('multiple custom mappers for same pair are scanned in order', () => {
    const adapter = new FrameworkAdapter()
    const m1 = new PathMapper().addMapping('^a/', 'out1/')
    const m2 = new PathMapper().addMapping('^a/', 'out2/')
    adapter.addBackendMapping('x', 'y', m1)
    adapter.addBackendMapping('x', 'y', m2)
    // First registered custom mapper wins
    expect(adapter.mapPath('a/file.ts', 'x', 'y')).toBe('out1/file.ts')
  })
})

// ---------------------------------------------------------------------------
// LanguageConfig — field-level validation per language
// ---------------------------------------------------------------------------

describe('LanguageConfig field-level validation', () => {
  it('TypeScript has buildCommand defined', () => {
    expect(LANGUAGE_CONFIGS.typescript.buildCommand).toBe('npx tsc')
  })

  it('TypeScript packageManager is npm', () => {
    expect(LANGUAGE_CONFIGS.typescript.packageManager).toBe('npm')
  })

  it('Python packageManager is pip', () => {
    expect(LANGUAGE_CONFIGS.python.packageManager).toBe('pip')
  })

  it('Go has buildCommand defined', () => {
    expect(LANGUAGE_CONFIGS.go.buildCommand).toBe('go build ./...')
  })

  it('Go packageManager is go', () => {
    expect(LANGUAGE_CONFIGS.go.packageManager).toBe('go')
  })

  it('Rust buildCommand uses cargo', () => {
    expect(LANGUAGE_CONFIGS.rust.buildCommand).toBe('cargo build')
  })

  it('Rust packageManager is cargo', () => {
    expect(LANGUAGE_CONFIGS.rust.packageManager).toBe('cargo')
  })

  it('Java and Kotlin share the same sandboxImage', () => {
    expect(LANGUAGE_CONFIGS.java.sandboxImage).toBe(LANGUAGE_CONFIGS.kotlin.sandboxImage)
  })

  it('Java and Kotlin packageManager is gradle', () => {
    expect(LANGUAGE_CONFIGS.java.packageManager).toBe('gradle')
    expect(LANGUAGE_CONFIGS.kotlin.packageManager).toBe('gradle')
  })

  it('Python has no buildCommand', () => {
    expect(LANGUAGE_CONFIGS.python.buildCommand).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// LanguageConfig — extension uniqueness across languages
// ---------------------------------------------------------------------------

describe('LanguageConfig extension uniqueness', () => {
  it('no extension belongs to more than one language', () => {
    const seen = new Map<string, SupportedLanguage>()
    const allLangs = Object.keys(LANGUAGE_CONFIGS) as SupportedLanguage[]
    for (const lang of allLangs) {
      for (const ext of LANGUAGE_CONFIGS[lang].extensions) {
        const existing = seen.get(ext)
        if (existing) {
          // This will fail with a descriptive message if duplicates exist
          expect(`${ext} in ${lang}`).toBe(`${ext} already in ${existing}`)
        }
        seen.set(ext, lang)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// detectLanguageFromFiles — priority and edge cases
// ---------------------------------------------------------------------------

describe('detectLanguageFromFiles priority edge cases', () => {
  it('TypeScript wins over Go when both present', () => {
    expect(detectLanguageFromFiles(['package.json', 'go.mod'])).toBe('typescript')
  })

  it('Python wins over Rust when both present', () => {
    expect(detectLanguageFromFiles(['requirements.txt', 'Cargo.toml'])).toBe('python')
  })

  it('Kotlin wins over Java when build.gradle.kts and pom.xml both present', () => {
    expect(detectLanguageFromFiles(['build.gradle.kts', 'pom.xml'])).toBe('kotlin')
  })

  it('Java detected from build.gradle but not build.gradle.kts', () => {
    expect(detectLanguageFromFiles(['build.gradle'])).toBe('java')
  })

  it('handles deeply nested paths by extracting basename', () => {
    expect(detectLanguageFromFiles(['a/b/c/d/e/Cargo.toml'])).toBe('rust')
  })

  it('handles filenames with no directory separators', () => {
    expect(detectLanguageFromFiles(['go.mod'])).toBe('go')
  })

  it('handles duplicate filenames gracefully', () => {
    expect(detectLanguageFromFiles(['go.mod', 'go.mod', 'go.sum'])).toBe('go')
  })

  it('ignores unrelated files mixed in', () => {
    expect(
      detectLanguageFromFiles(['README.md', 'LICENSE', '.gitignore', 'Cargo.toml', 'Dockerfile']),
    ).toBe('rust')
  })
})

// ---------------------------------------------------------------------------
// getLanguagePrompt — content sanity per language
// ---------------------------------------------------------------------------

describe('getLanguagePrompt content specifics', () => {
  it('Java prompt mentions records', () => {
    expect(getLanguagePrompt('java')).toContain('records')
  })

  it('Java prompt mentions Optional', () => {
    expect(getLanguagePrompt('java')).toContain('Optional')
  })

  it('Kotlin prompt mentions data class', () => {
    expect(getLanguagePrompt('kotlin')).toContain('data class')
  })

  it('Kotlin prompt mentions null safety', () => {
    expect(getLanguagePrompt('kotlin')).toContain('null safety')
  })

  it('Go prompt mentions composition', () => {
    expect(getLanguagePrompt('go')).toContain('composition')
  })

  it('Rust prompt mentions derive', () => {
    expect(getLanguagePrompt('rust')).toContain('Derive')
  })

  it('TypeScript prompt mentions readonly', () => {
    expect(getLanguagePrompt('typescript')).toContain('readonly')
  })

  it('Python prompt mentions dataclasses or Pydantic', () => {
    const prompt = getLanguagePrompt('python')
    expect(prompt).toContain('dataclasses')
  })
})
