/**
 * Tests for the useApi composable.
 */
import { describe, it, expect } from 'vitest'
import { buildUrl } from '../composables/useApi.js'

describe('useApi', () => {
  describe('buildUrl', () => {
    it('returns path as-is when it starts with /', () => {
      expect(buildUrl('/api/agents')).toBe('/api/agents')
    })

    it('prepends / when path does not start with /', () => {
      expect(buildUrl('api/agents')).toBe('/api/agents')
    })

    it('handles root path', () => {
      expect(buildUrl('/')).toBe('/')
    })

    it('handles paths with query parameters', () => {
      expect(buildUrl('/api/agents?active=true')).toBe('/api/agents?active=true')
    })

    it('handles nested paths', () => {
      expect(buildUrl('/api/memory-browse/namespaces/test/records')).toBe(
        '/api/memory-browse/namespaces/test/records',
      )
    })
  })
})
