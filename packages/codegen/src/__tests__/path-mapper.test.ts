import { describe, it, expect } from 'vitest'
import { PathMapper } from '../adaptation/path-mapper.js'

describe('PathMapper', () => {
  it('maps a matching path to the target', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^src/(.+)\\.ts$', 'dist/$1.js')
    expect(mapper.map('src/foo.ts')).toBe('dist/foo.js')
  })

  it('returns null for non-matching paths', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^src/', 'dist/')
    expect(mapper.map('lib/foo.ts')).toBeNull()
  })

  it('applies the first matching mapping', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^src/components/', 'ui/')
    mapper.addMapping('^src/', 'dist/')
    expect(mapper.map('src/components/Button.tsx')).toBe('ui/Button.tsx')
  })

  it('supports chained addMapping calls', () => {
    const mapper = new PathMapper()
    const result = mapper
      .addMapping('^a/', 'b/')
      .addMapping('^c/', 'd/')
    expect(result).toBe(mapper)
    expect(mapper.map('a/x')).toBe('b/x')
    expect(mapper.map('c/y')).toBe('d/y')
  })

  it('handles regex groups in target', () => {
    const mapper = new PathMapper()
    mapper.addMapping('^(.+)\\.vue$', '$1.tsx')
    expect(mapper.map('App.vue')).toBe('App.tsx')
  })

  it('returns null when no mappings are configured', () => {
    const mapper = new PathMapper()
    expect(mapper.map('any/path')).toBeNull()
  })
})
