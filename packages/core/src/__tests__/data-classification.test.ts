import { describe, it, expect } from 'vitest'
import {
  DataClassifier,
  DEFAULT_CLASSIFICATION_PATTERNS,
} from '../security/classification/data-classification.js'
import type {
  ClassificationLevel,
  DataClassificationTag,
} from '../security/classification/data-classification.js'

describe('DataClassifier', () => {
  const classifier = new DataClassifier()

  // -----------------------------------------------------------------------
  // Auto-classify
  // -----------------------------------------------------------------------

  describe('classify', () => {
    it('classifies SSN as restricted', () => {
      const tag = classifier.classify('My SSN is 123-45-6789')
      expect(tag.level).toBe('restricted')
      expect(tag.reason).toContain('SSN')
      expect(tag.taggedAt).toBeTruthy()
    })

    it('classifies credit card numbers as restricted', () => {
      const tag = classifier.classify('Card: 4111111111111111')
      expect(tag.level).toBe('restricted')
      expect(tag.reason).toContain('Credit card')
    })

    it('classifies API keys as confidential', () => {
      const tag = classifier.classify('api_key = "sk_abcdef1234567890xyz"')
      expect(tag.level).toBe('confidential')
      expect(tag.reason).toContain('API key')
    })

    it('classifies tokens as confidential', () => {
      const tag = classifier.classify('token = "abcdef1234567890xyzabc"')
      expect(tag.level).toBe('confidential')
    })

    it('classifies passwords as confidential', () => {
      const tag = classifier.classify('password = "super_secret_123"')
      expect(tag.level).toBe('confidential')
      expect(tag.reason).toContain('Password')
    })

    it('classifies Stripe-style keys as confidential', () => {
      const tag = classifier.classify('sk-live-abcdefghij1234567890ab')
      expect(tag.level).toBe('confidential')
    })

    it('classifies email addresses as internal', () => {
      const tag = classifier.classify('Contact: user@example.com')
      expect(tag.level).toBe('internal')
      expect(tag.reason).toContain('Email')
    })

    it('classifies phone numbers as internal', () => {
      const tag = classifier.classify('Call (555) 123-4567')
      expect(tag.level).toBe('internal')
      expect(tag.reason).toContain('Phone')
    })

    it('classifies plain text as public', () => {
      const tag = classifier.classify('This is just regular text about coding.')
      expect(tag.level).toBe('public')
    })

    it('returns the highest classification when multiple patterns match', () => {
      const tag = classifier.classify('SSN: 123-45-6789 email: test@foo.com')
      expect(tag.level).toBe('restricted')
    })
  })

  // -----------------------------------------------------------------------
  // getLevel
  // -----------------------------------------------------------------------

  describe('getLevel', () => {
    it('returns the level from a tag', () => {
      const tag: DataClassificationTag = {
        level: 'confidential',
        reason: 'test',
        taggedAt: new Date().toISOString(),
      }
      expect(classifier.getLevel(tag)).toBe('confidential')
    })
  })

  // -----------------------------------------------------------------------
  // isHigherThan
  // -----------------------------------------------------------------------

  describe('isHigherThan', () => {
    it('restricted > confidential', () => {
      expect(classifier.isHigherThan('restricted', 'confidential')).toBe(true)
    })

    it('confidential > internal', () => {
      expect(classifier.isHigherThan('confidential', 'internal')).toBe(true)
    })

    it('internal > public', () => {
      expect(classifier.isHigherThan('internal', 'public')).toBe(true)
    })

    it('public is not higher than public', () => {
      expect(classifier.isHigherThan('public', 'public')).toBe(false)
    })

    it('public is not higher than restricted', () => {
      expect(classifier.isHigherThan('public', 'restricted')).toBe(false)
    })

    it('same levels are not higher', () => {
      const levels: ClassificationLevel[] = ['public', 'internal', 'confidential', 'restricted']
      for (const level of levels) {
        expect(classifier.isHigherThan(level, level)).toBe(false)
      }
    })
  })

  // -----------------------------------------------------------------------
  // tagNamespace
  // -----------------------------------------------------------------------

  describe('tagNamespace', () => {
    it('creates a tag for a namespace', () => {
      const tag = classifier.tagNamespace('user-data', 'confidential', 'Contains PII')
      expect(tag.level).toBe('confidential')
      expect(tag.reason).toBe('Contains PII')
      expect(tag.taggedAt).toBeTruthy()
    })

    it('generates a default reason when none provided', () => {
      const tag = classifier.tagNamespace('logs', 'internal')
      expect(tag.reason).toContain('logs')
      expect(tag.reason).toContain('internal')
    })
  })

  // -----------------------------------------------------------------------
  // Custom config
  // -----------------------------------------------------------------------

  describe('custom config', () => {
    it('respects a custom default level', () => {
      const c = new DataClassifier({ defaultLevel: 'internal' })
      const tag = c.classify('plain text')
      expect(tag.level).toBe('internal')
    })

    it('uses custom patterns', () => {
      const c = new DataClassifier({
        autoClassifyPatterns: [
          { pattern: /SECRET_WORD/, level: 'restricted', reason: 'Custom secret' },
        ],
      })
      expect(c.classify('Contains SECRET_WORD here').level).toBe('restricted')
      expect(c.classify('No secret').level).toBe('public')
    })
  })

  // -----------------------------------------------------------------------
  // DEFAULT_CLASSIFICATION_PATTERNS
  // -----------------------------------------------------------------------

  describe('DEFAULT_CLASSIFICATION_PATTERNS', () => {
    it('is a non-empty array', () => {
      expect(DEFAULT_CLASSIFICATION_PATTERNS.length).toBeGreaterThan(0)
    })

    it('each pattern has required fields', () => {
      for (const p of DEFAULT_CLASSIFICATION_PATTERNS) {
        expect(p.pattern).toBeInstanceOf(RegExp)
        expect(typeof p.level).toBe('string')
        expect(typeof p.reason).toBe('string')
      }
    })
  })
})
