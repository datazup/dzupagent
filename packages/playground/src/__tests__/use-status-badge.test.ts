/**
 * Tests for the `useStatusBadge` composable -- semantic-class mapping helpers.
 */
import { describe, expect, it } from 'vitest'
import {
  badgeVariantClass,
  capabilityBadgeClass,
  capabilityBadgeVariant,
  categoryBadgeClass,
  categoryBadgeVariant,
  statusBadgeClass,
  statusBadgeVariant,
} from '../composables/useStatusBadge.js'

describe('useStatusBadge', () => {
  describe('badgeVariantClass', () => {
    it('prefixes the variant name with pg-badge-', () => {
      expect(badgeVariantClass('success')).toBe('pg-badge-success')
      expect(badgeVariantClass('danger')).toBe('pg-badge-danger')
      expect(badgeVariantClass('muted')).toBe('pg-badge-muted')
    })
  })

  describe('statusBadgeVariant', () => {
    it('maps run / eval statuses to semantic variants', () => {
      expect(statusBadgeVariant('completed')).toBe('success')
      expect(statusBadgeVariant('running')).toBe('info')
      expect(statusBadgeVariant('executing')).toBe('info')
      expect(statusBadgeVariant('failed')).toBe('danger')
      expect(statusBadgeVariant('rejected')).toBe('danger')
      expect(statusBadgeVariant('pending')).toBe('neutral')
      expect(statusBadgeVariant('queued')).toBe('neutral')
      expect(statusBadgeVariant('cancelled')).toBe('muted')
      expect(statusBadgeVariant('awaiting_approval')).toBe('warning')
    })

    it('falls back to muted for unknown statuses', () => {
      expect(statusBadgeVariant('weird-state')).toBe('muted')
    })
  })

  describe('statusBadgeClass', () => {
    it('returns the pg-badge-* class for a status', () => {
      expect(statusBadgeClass('completed')).toBe('pg-badge-success')
      expect(statusBadgeClass('failed')).toBe('pg-badge-danger')
      expect(statusBadgeClass('running')).toBe('pg-badge-info')
      expect(statusBadgeClass('pending')).toBe('pg-badge-neutral')
    })
  })

  describe('capabilityBadgeVariant', () => {
    it('maps capability statuses to semantic variants', () => {
      expect(capabilityBadgeVariant('active')).toBe('success')
      expect(capabilityBadgeVariant('degraded')).toBe('warning')
      expect(capabilityBadgeVariant('dropped')).toBe('danger')
      expect(capabilityBadgeVariant('unsupported')).toBe('muted')
    })

    it('falls back to muted for unknown capability values', () => {
      expect(capabilityBadgeVariant('???')).toBe('muted')
    })
  })

  describe('capabilityBadgeClass', () => {
    it('returns the pg-badge-* class for a capability state', () => {
      expect(capabilityBadgeClass('active')).toBe('pg-badge-success')
      expect(capabilityBadgeClass('degraded')).toBe('pg-badge-warning')
      expect(capabilityBadgeClass('dropped')).toBe('pg-badge-danger')
      expect(capabilityBadgeClass('unsupported')).toBe('pg-badge-muted')
    })
  })

  describe('categoryBadgeVariant', () => {
    it('maps marketplace categories to semantic variants', () => {
      expect(categoryBadgeVariant('observability')).toBe('info')
      expect(categoryBadgeVariant('memory')).toBe('violet')
      expect(categoryBadgeVariant('security')).toBe('warning')
      expect(categoryBadgeVariant('codegen')).toBe('success')
      expect(categoryBadgeVariant('integration')).toBe('cyan')
      expect(categoryBadgeVariant('testing')).toBe('rose')
    })

    it('falls back to muted for unknown categories', () => {
      expect(categoryBadgeVariant('mystery-category')).toBe('muted')
    })
  })

  describe('categoryBadgeClass', () => {
    it('returns the pg-badge-* class for a category', () => {
      expect(categoryBadgeClass('observability')).toBe('pg-badge-info')
      expect(categoryBadgeClass('memory')).toBe('pg-badge-violet')
      expect(categoryBadgeClass('codegen')).toBe('pg-badge-success')
    })
  })
})
