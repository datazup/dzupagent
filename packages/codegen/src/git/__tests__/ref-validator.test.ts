import { describe, it, expect } from 'vitest'
import {
  GIT_REF_PATTERN,
  InvalidGitRefError,
  validateRefName,
  validateRevision,
} from '../ref-validator.js'

describe('ref-validator', () => {
  describe('validateRefName — rejects flag-shaped values', () => {
    it('rejects --upload-pack=/tmp/x.sh as a branch ref', () => {
      expect(() =>
        validateRefName('--upload-pack=/tmp/x.sh', 'branch'),
      ).toThrowError(InvalidGitRefError)
    })

    it('rejects -c as a branch ref', () => {
      expect(() => validateRefName('-c', 'branch')).toThrowError(InvalidGitRefError)
    })

    it('rejects bare --end-of-options', () => {
      expect(() => validateRefName('--end-of-options', 'ref')).toThrowError(
        InvalidGitRefError,
      )
    })

    it('rejects values with leading dash regardless of payload', () => {
      expect(() => validateRefName('-anything', 'branch')).toThrowError(
        InvalidGitRefError,
      )
    })
  })

  describe('validateRefName — rejects ref-format violations', () => {
    it('rejects ".." anywhere', () => {
      expect(() => validateRefName('foo..bar', 'branch')).toThrowError(
        InvalidGitRefError,
      )
    })

    it('rejects empty strings', () => {
      expect(() => validateRefName('', 'branch')).toThrowError(InvalidGitRefError)
    })

    it('rejects leading slash', () => {
      expect(() => validateRefName('/abs', 'ref')).toThrowError(InvalidGitRefError)
    })

    it('rejects trailing slash', () => {
      expect(() => validateRefName('trail/', 'ref')).toThrowError(InvalidGitRefError)
    })

    it('rejects consecutive slashes', () => {
      expect(() => validateRefName('foo//bar', 'ref')).toThrowError(InvalidGitRefError)
    })

    it('rejects leading dot', () => {
      expect(() => validateRefName('.hidden', 'branch')).toThrowError(
        InvalidGitRefError,
      )
    })

    it('rejects .lock suffix', () => {
      expect(() => validateRefName('foo.lock', 'branch')).toThrowError(
        InvalidGitRefError,
      )
    })

    it('rejects @{ reflog selector', () => {
      expect(() => validateRefName('foo@{1}', 'branch')).toThrowError(
        InvalidGitRefError,
      )
    })

    it.each([
      ['tilde', 'foo~1'],
      ['caret', 'foo^'],
      ['colon', 'foo:bar'],
      ['question mark', 'foo?'],
      ['asterisk', 'foo*'],
      ['open bracket', 'foo['],
      ['backslash', 'foo\\bar'],
      ['space', 'foo bar'],
      ['tab', 'foo\tbar'],
      ['newline', 'foo\nbar'],
    ])('rejects %s in ref name', (_label, ref) => {
      expect(() => validateRefName(ref, 'branch')).toThrowError(InvalidGitRefError)
    })

    it('rejects refs longer than 255 chars', () => {
      const long = 'a'.repeat(256)
      expect(() => validateRefName(long, 'branch')).toThrowError(InvalidGitRefError)
    })
  })

  describe('validateRefName — accepts well-formed refs', () => {
    it('accepts feature/foo-bar as a branch', () => {
      expect(() => validateRefName('feature/foo-bar', 'branch')).not.toThrow()
    })

    it('accepts refs/heads/main', () => {
      expect(() => validateRefName('refs/heads/main', 'ref')).not.toThrow()
    })

    it('accepts main', () => {
      expect(() => validateRefName('main', 'branch')).not.toThrow()
    })

    it('accepts a 40-char commit hash', () => {
      expect(() =>
        validateRefName('0123456789abcdef0123456789abcdef01234567', 'commit'),
      ).not.toThrow()
    })

    it('accepts version-like tags', () => {
      expect(() => validateRefName('v1.2.3', 'tag')).not.toThrow()
    })

    it('accepts dotted segments away from boundaries', () => {
      expect(() => validateRefName('release/2026.05.06', 'tag')).not.toThrow()
    })
  })

  describe('error metadata', () => {
    it('exposes refName, kind, and reason', () => {
      try {
        validateRefName('--evil', 'branch')
        expect.fail('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidGitRefError)
        const e = err as InvalidGitRefError
        expect(e.refName).toBe('--evil')
        expect(e.kind).toBe('branch')
        expect(e.reason).toMatch(/must not start with "-"/)
        expect(e.name).toBe('InvalidGitRefError')
      }
    })
  })

  describe('validateRevision — ancestry suffixes on a validated base', () => {
    it('accepts trailing ~n / ^n operators', () => {
      expect(() => validateRevision('HEAD~3', 'ref')).not.toThrow()
      expect(() => validateRevision('foo^', 'ref')).not.toThrow()
      expect(() => validateRevision('main^2~1', 'ref')).not.toThrow()
      expect(() => validateRevision('v1.2.3~10', 'ref')).not.toThrow()
    })

    it('still accepts plain ref names', () => {
      expect(() => validateRevision('feature/foo-bar', 'ref')).not.toThrow()
    })

    it('rejects flag-shaped and metacharacter bases', () => {
      for (const rev of [
        '--output=/tmp/x~1',
        '-c^',
        'foo:bar~1',
        'foo bar^2',
        'foo@{1}~2',
        'foo..bar~1',
        'foo~1bar',
        '~3',
        '^',
        '',
      ]) {
        expect(() => validateRevision(rev, 'ref')).toThrowError(
          InvalidGitRefError,
        )
      }
    })
  })

  describe('GIT_REF_PATTERN', () => {
    it('matches accepted shapes', () => {
      expect(GIT_REF_PATTERN.test('feature/foo-bar')).toBe(true)
      expect(GIT_REF_PATTERN.test('main')).toBe(true)
      expect(GIT_REF_PATTERN.test('v1.2.3')).toBe(true)
    })

    it('rejects leading dash and metacharacters', () => {
      expect(GIT_REF_PATTERN.test('-evil')).toBe(false)
      expect(GIT_REF_PATTERN.test('foo bar')).toBe(false)
      expect(GIT_REF_PATTERN.test('foo:bar')).toBe(false)
    })
  })
})
