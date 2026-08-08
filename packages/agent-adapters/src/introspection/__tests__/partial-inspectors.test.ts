import { describe, expect, it } from 'vitest'

import type { AdapterInstallationRef } from '@dzupagent/adapter-types'
import { GeminiInstallationInspector } from '../gemini-inspector.js'
import { PARTIAL_INSPECTOR_GAPS } from '../partial-inspector-gaps.js'
import { QwenInstallationInspector } from '../qwen-inspector.js'
import {
  GEMINI_0_35_3_FIXTURE,
  PARTIAL_FIXTURE_PACKS,
  QWEN_0_17_1_FIXTURE,
} from './fixtures/partial-fixture-packs.js'
import { fixedClock, notInstalled, ok, recordingRunner } from './fixtures/probe-fixtures.js'

const MANAGED_HOME = '/managed/home'

function installationRef(providerId: 'gemini' | 'qwen'): AdapterInstallationRef {
  return {
    installationId: `inst-${providerId}-partial`,
    coordinates: { providerId, backend: 'cli' },
    hostBindingId: 'worker-partial',
    managed: true,
  }
}

describe('partial-tier fixture custody', () => {
  it('contains normalized, redacted, transcript-free captures for both providers', () => {
    expect(PARTIAL_FIXTURE_PACKS.map((pack) => `${pack.providerId}@${pack.version}`)).toEqual([
      'gemini@0.35.3',
      'qwen@0.17.1',
    ])

    for (const pack of PARTIAL_FIXTURE_PACKS) {
      expect(pack.normalized).toBe(true)
      expect(pack.redacted).toBe(true)
      expect(pack.usageTranscript).toBeNull()
      expect(pack.help).not.toMatch(/Bearer\s+\S+/i)
      expect(JSON.stringify(pack.configSamples)).not.toMatch(/api[_-]?key\s*[=:]\s*["'][^"']+/i)
    }
  })

  it('records why usage parsing remains intentionally absent', () => {
    expect(PARTIAL_INSPECTOR_GAPS.gemini.usageTranscript).toMatch(/No real redacted Gemini/)
    expect(PARTIAL_INSPECTOR_GAPS.qwen.usageTranscript).toMatch(/No real redacted Qwen/)
  })
})

describe('GeminiInstallationInspector (WP-M1.6)', () => {
  function context(readConfigFile?: (path: string) => Promise<string | null>) {
    const runner = recordingRunner({
      'gemini --version': ok(GEMINI_0_35_3_FIXTURE.versionOutput),
      'gemini --help': ok(GEMINI_0_35_3_FIXTURE.help),
    })
    return {
      runner,
      context: {
        runProbe: runner.run,
        managedHome: MANAGED_HOME,
        now: fixedClock,
        readConfigFile,
      },
    }
  }

  it('produces a valid absent document when Gemini is not installed', async () => {
    const inspector = new GeminiInstallationInspector({
      runProbe: recordingRunner({ 'gemini --version': notInstalled() }).run,
      managedHome: MANAGED_HOME,
      now: fixedClock,
    })

    const document = await inspector.inspect(installationRef('gemini'))

    expect(document.binary.executable).toBe(false)
    expect(document.binary.version).toEqual({ value: null, certainty: 'unspecified' })
    expect(document.commands.subcommands).toEqual([])
  })

  it('derives only help-evidenced extension and runtime capabilities', async () => {
    const { context: inspectorContext } = context()
    const document = await new GeminiInstallationInspector(inspectorContext).inspect(
      installationRef('gemini'),
    )

    expect(document.binary.version.value).toBe('0.35.3')
    expect(document.extensions.mcp.supported.value).toBe(true)
    expect(document.extensions.plugins.supported.value).toBe(true)
    expect(document.extensions.skills.supported.value).toBe(true)
    expect(document.extensions.hooks.supported.value).toBe(true)
    expect(document.runtimeModes.oneShot.value).toBe(true)
    expect(document.runtimeModes.structuredOutput.value).toBe('jsonl')
    expect(document.runtimeModes.acp.value).toBe(true)
    expect(document.security.permissionRules.value).toBe(true)
  })

  it('reads the captured user config without claiming writability', async () => {
    const sample = GEMINI_0_35_3_FIXTURE.configSamples[0]!
    const { context: inspectorContext } = context(async (path) =>
      path === `${MANAGED_HOME}/${sample.relativePath}` ? sample.contents : null,
    )
    const document = await new GeminiInstallationInspector(inspectorContext).inspect(
      installationRef('gemini'),
    )
    const user = document.configLayers.find((layer) => layer.id === 'gemini-user-settings')

    expect(user?.exists).toBe(true)
    expect(user?.writable).toBe(false)
    expect(user?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('keeps usage, ownership, binary path, and XDG behavior unspecified', async () => {
    const { context: inspectorContext } = context()
    const document = await new GeminiInstallationInspector(inspectorContext).inspect(
      installationRef('gemini'),
    )

    expect(document.telemetry.usageSource).toBe('unspecified')
    expect(document.binary.path.certainty).toBe('unspecified')
    expect(document.binary.ownership.certainty).toBe('unspecified')
    expect(document.security.xdgOverrideHonored.certainty).toBe('unspecified')
  })
})

describe('QwenInstallationInspector (WP-M1.6)', () => {
  function context(readConfigFile?: (path: string) => Promise<string | null>) {
    const runner = recordingRunner({
      'qwen --version': ok(QWEN_0_17_1_FIXTURE.versionOutput),
      'qwen --help': ok(QWEN_0_17_1_FIXTURE.help),
    })
    return {
      runner,
      context: {
        runProbe: runner.run,
        managedHome: MANAGED_HOME,
        now: fixedClock,
        readConfigFile,
      },
    }
  }

  it('derives partial capabilities and the local daemon from captured help', async () => {
    const { context: inspectorContext } = context()
    const document = await new QwenInstallationInspector(inspectorContext).inspect(
      installationRef('qwen'),
    )

    expect(document.binary.version.value).toBe('0.17.1')
    expect(document.extensions.mcp.supported.value).toBe(true)
    expect(document.extensions.plugins.supported.value).toBe(true)
    expect(document.extensions.hooks.supported.value).toBe(true)
    expect(document.extensions.skills.supported.value).toBeNull()
    expect(document.runtimeModes.oneShot.value).toBe(true)
    expect(document.runtimeModes.structuredOutput.value).toBe('jsonl')
    expect(document.runtimeModes.acp.value).toBe(true)
    expect(document.runtimeModes.daemon.value).toBe(true)
  })

  it('records telemetry controls without inventing an enabled-by-default value', async () => {
    const { context: inspectorContext } = context()
    const document = await new QwenInstallationInspector(inspectorContext).inspect(
      installationRef('qwen'),
    )

    expect(document.telemetry).toEqual({
      documented: true,
      enabledByDefault: null,
      optOutAvailable: true,
      optOutMechanisms: ['settings:telemetry.enabled'],
      usageSource: 'unspecified',
    })
  })

  it('declares only the subscription credential binding and never a value', async () => {
    const { context: inspectorContext } = context()
    const document = await new QwenInstallationInspector(inspectorContext).inspect(
      installationRef('qwen'),
    )

    expect(document.credentials).toEqual([
      {
        name: 'bailian-coding-plan',
        acceptedEnvVars: ['BAILIAN_CODING_PLAN_API_KEY'],
        storage: 'env',
        configured: { value: null, certainty: 'unspecified' },
      },
    ])
  })

  it('reads the captured settings layer and preserves null-honesty gaps', async () => {
    const sample = QWEN_0_17_1_FIXTURE.configSamples[0]!
    const { context: inspectorContext } = context(async (path) =>
      path === `${MANAGED_HOME}/${sample.relativePath}` ? sample.contents : null,
    )
    const document = await new QwenInstallationInspector(inspectorContext).inspect(
      installationRef('qwen'),
    )
    const user = document.configLayers.find((layer) => layer.id === 'qwen-user-settings')

    expect(user?.exists).toBe(true)
    expect(user?.writable).toBe(false)
    expect(document.telemetry.usageSource).toBe('unspecified')
    expect(document.binary.ownership.value).toBeNull()
    expect(document.security.xdgOverrideHonored.value).toBeNull()
  })

  it('never invokes an unadvertised management command', async () => {
    const { runner, context: inspectorContext } = context()
    await new QwenInstallationInspector(inspectorContext).inspect(installationRef('qwen'))

    expect(runner.calls.map((call) => [call.command, ...call.args].join(' '))).toEqual([
      'qwen --version',
      'qwen --help',
    ])
  })
})
