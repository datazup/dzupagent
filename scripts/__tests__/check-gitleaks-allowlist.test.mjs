import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  checkGitleaksAllowlist,
  extractAllowlistPathPatterns,
  renderReport,
  runCheck,
} from '../check-gitleaks-allowlist.mjs'

function configWithPaths(paths) {
  return [
    'title = "fixture"',
    '',
    '[[allowlists]]',
    'description = "fixtures"',
    'paths = [',
    ...paths.map((pattern) => `  '''${pattern}''',`),
    ']',
    '',
  ].join('\n')
}

test('extractAllowlistPathPatterns reads triple-quoted path regexes from allowlist blocks', () => {
  const patterns = extractAllowlistPathPatterns(configWithPaths([
    '^packages/core/src/__tests__/secrets-scanner\\.test\\.ts$',
    '^packages/security/src/__tests__/pii-detector\\.test\\.ts$',
  ]))

  assert.deepEqual(patterns, [
    '^packages/core/src/__tests__/secrets-scanner\\.test\\.ts$',
    '^packages/security/src/__tests__/pii-detector\\.test\\.ts$',
  ])
})

test('extractAllowlistPathPatterns keeps regexes containing bracket character classes', () => {
  const patterns = extractAllowlistPathPatterns(configWithPaths([
    '^packages/core/src/__tests__/[a-z0-9-]+\\.test\\.ts$',
  ]))

  assert.deepEqual(patterns, [
    '^packages/core/src/__tests__/[a-z0-9-]+\\.test\\.ts$',
  ])
})

test('checkGitleaksAllowlist accepts anchored valid regexes', () => {
  const result = checkGitleaksAllowlist(configWithPaths([
    '^packages/core/src/__tests__/secrets-scanner\\.test\\.ts$',
  ]))

  assert.equal(result.patterns.length, 1)
  assert.deepEqual(result.issues, [])
})

test('checkGitleaksAllowlist rejects unanchored path regexes', () => {
  const result = checkGitleaksAllowlist(configWithPaths([
    'packages/core/src/__tests__/secrets-scanner\\.test\\.ts',
  ]))

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].issue, 'allowlist path regex must be anchored with ^ and $')
})

test('checkGitleaksAllowlist rejects invalid regexes', () => {
  const result = checkGitleaksAllowlist(configWithPaths([
    '^packages/[broken$',
  ]))

  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0].issue, /invalid regex/)
})

test('renderReport includes failure details', () => {
  const report = renderReport({
    patterns: ['unanchored'],
    issues: [{ pattern: 'unanchored', issue: 'allowlist path regex must be anchored with ^ and $' }],
  }, '.gitleaks.toml')

  assert.match(report, /Status: failed/)
  assert.match(report, /unanchored/)
})

test('runCheck reads a config file and returns issues', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-allowlist-test-'))
  const configPath = join(dir, '.gitleaks.toml')
  try {
    writeFileSync(configPath, configWithPaths(['^ok$']), 'utf8')
    const result = runCheck(configPath)
    assert.equal(result.patterns.length, 1)
    assert.deepEqual(result.issues, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
