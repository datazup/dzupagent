/**
 * Tests for the useApi composable.
 */
import { describe, it, expect } from 'vitest'
import { buildUrl } from '../composables/useApi.js'

describe('useApi', () => {
  describe('buildUrl', () => {
    it('returns path as-is when it starts with /', () => {
      expect(buildUrl('/api/agent-definitions')).toBe('/api/agent-definitions')
    })

    it('prepends / when path does not start with /', () => {
      expect(buildUrl('api/agent-definitions')).toBe('/api/agent-definitions')
    })

    it('handles root path', () => {
      expect(buildUrl('/')).toBe('/')
    })

    it('handles paths with query parameters', () => {
      expect(buildUrl('/api/agent-definitions?active=true')).toBe('/api/agent-definitions?active=true')
    })

    it('handles nested paths', () => {
      expect(buildUrl('/api/memory-browse/namespaces/test/records')).toBe(
        '/api/memory-browse/namespaces/test/records',
      )
    })
  })
})
