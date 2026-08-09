import { describe, expect, it } from 'vitest'

import type { AdapterInstallationRef } from '@dzupagent/adapter-types/monitoring/installation'
import { ClaudeInstallationInspector } from '../claude-inspector.js'
import { CodexInstallationInspector } from '../codex-inspector.js'
import { parseHelpFlags, parseHelpSubcommands, parseVersion } from '../probe-runner.js'
import {
  CLAUDE_2_1_226_FIXTURE,
  CODEX_0_147_0_FIXTURE,
  M1_FIXTURE_PACKS,
  fixedClock,
  ok,
  recordingRunner,
} from './fixtures/probe-fixtures.js'

const MANAGED_HOME = '/managed/home'

function ref(providerId: 'claude' | 'codex'): AdapterInstallationRef {
  return {
    installationId: `inst-${providerId}-fixture`,
    coordinates: { providerId, backend: 'cli' },
    hostBindingId: 'worker-fixture',
    managed: true,
  }
}

describe('M1 inspector fixture packs (WP-M1.4)', () => {
  it('covers two discriminating versions for each pinned provider', () => {
    expect(M1_FIXTURE_PACKS.map((pack) => `${pack.providerId}@${pack.version}`)).toEqual([
      'claude@2.1.226',
      'claude@2.0.14',
      'codex@0.147.0',
      'codex@0.48.0',
    ])

    for (const providerId of ['claude', 'codex'] as const) {
      const packs = M1_FIXTURE_PACKS.filter((pack) => pack.providerId === providerId)
      expect(packs).toHaveLength(2)
      expect(parseHelpSubcommands(packs[0]!.help)).not.toEqual(
        parseHelpSubcommands(packs[1]!.help),
      )
      expect(parseHelpFlags(packs[0]!.help)).not.toEqual(parseHelpFlags(packs[1]!.help))
      expect(packs[0]!.configSamples).not.toEqual(packs[1]!.configSamples)
    }
  })

  it('parses every captured version exactly and rejects an off-by-one expectation', () => {
    for (const pack of M1_FIXTURE_PACKS) {
      expect(parseVersion(pack.versionOutput)).toBe(pack.version)
      expect(parseVersion(pack.versionOutput)).not.toBe(`${pack.version}.1`)
    }
  })

  it.each([
    ['semver', 'agent 1.2.3', '1.2.3'],
    ['v-prefix', 'agent v2.1.226', '2.1.226'],
    ['prerelease', 'agent 0.147.0-beta.2', '0.147.0-beta.2'],
    ['date', 'snapshot 2026-08-08', '2026-08-08'],
  ])('parses %s version strings', (_kind, raw, expected) => {
    expect(parseVersion(raw)).toBe(expected)
  })

  it('rejects malformed calendar dates rather than treating them as versions', () => {
    expect(parseVersion('snapshot 2026-02-30')).toBeNull()
    expect(parseVersion('snapshot 2026-13-01')).toBeNull()
  })

  it('keeps fixture metadata normalized, redacted, relative, and non-secret', () => {
    for (const pack of M1_FIXTURE_PACKS) {
      expect(pack.normalized).toBe(true)
      expect(pack.redacted).toBe(true)
      expect(pack.configSamples.length).toBeGreaterThan(0)
      for (const sample of pack.configSamples) {
        expect(sample.relativePath.startsWith('/')).toBe(false)
        expect(sample.contents).not.toMatch(/sk-[A-Za-z0-9]/)
        expect(sample.contents).not.toMatch(/api[_-]?key\s*[=:]\s*["'][^"']+/i)
      }
    }
  })

  it('feeds the current Claude config sample through the inspector hash path', async () => {
    const sample = CLAUDE_2_1_226_FIXTURE.configSamples[0]!
    const runner = recordingRunner({
      'claude --version': ok(CLAUDE_2_1_226_FIXTURE.versionOutput),
      'claude --help': ok(CLAUDE_2_1_226_FIXTURE.help),
    })
    const inspector = new ClaudeInstallationInspector({
      runProbe: runner.run,
      managedHome: MANAGED_HOME,
      now: fixedClock,
      readConfigFile: async (path) =>
        path === `${MANAGED_HOME}/${sample.relativePath}` ? sample.contents : null,
    })

    const document = await inspector.inspect(ref('claude'))
    const layer = document.configLayers.find((candidate) => candidate.id === 'claude-user-settings')

    expect(layer?.sha256).toBe(
      'sha256:46f9c11d144cce702f4c43919fe6dd8b2dfbf5a0114c6cfff176442749b853c7',
    )
  })

  it('feeds the current Codex config sample through the inspector hash path', async () => {
    const sample = CODEX_0_147_0_FIXTURE.configSamples[0]!
    const runner = recordingRunner({
      'codex --version': ok(CODEX_0_147_0_FIXTURE.versionOutput),
      'codex --help': ok(CODEX_0_147_0_FIXTURE.help),
    })
    const inspector = new CodexInstallationInspector({
      runProbe: runner.run,
      managedHome: MANAGED_HOME,
      now: fixedClock,
      readConfigFile: async (path) =>
        path === `${MANAGED_HOME}/${sample.relativePath}` ? sample.contents : null,
    })

    const document = await inspector.inspect(ref('codex'))
    const layer = document.configLayers.find((candidate) => candidate.id === 'codex-user-config')

    expect(layer?.sha256).toBe(
      'sha256:a32df945dd0c29f5003d54c6a84a5191e31be6b8144fa781525cf3490a2351b2',
    )
  })
})
