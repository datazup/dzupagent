/** Partial-tier installation inspector for Qwen Code (WP-M1.6). */
import type {
  CredentialBinding,
  InstallationCapabilityDocument,
} from '@dzupagent/adapter-types/monitoring/installation'
import {
  AdapterInstallationInspector,
  observed,
  unspecified,
  type ConfigLayerCandidate,
} from './adapter-installation-inspector.js'

export class QwenInstallationInspector extends AdapterInstallationInspector {
  protected readonly binaryName = 'qwen'

  protected configCandidates(): ConfigLayerCandidate[] {
    const home = this.context.managedHome
    return [
      {
        id: 'qwen-user-settings',
        scope: 'user',
        path: `${home}/.qwen/settings.json`,
        format: 'json',
        precedence: 20,
      },
      {
        id: 'qwen-project-settings',
        scope: 'project',
        path: '.qwen/settings.json',
        format: 'json',
        precedence: 30,
      },
      {
        id: 'qwen-project-env',
        scope: 'project',
        path: '.qwen/.env',
        format: 'dotenv',
        precedence: 25,
      },
    ]
  }

  protected credentialCandidates(): CredentialBinding[] {
    return [
      {
        name: 'bailian-coding-plan',
        acceptedEnvVars: ['BAILIAN_CODING_PLAN_API_KEY'],
        storage: 'env',
        configured: unspecified<boolean>(),
      },
    ]
  }

  protected override async enrich(
    document: InstallationCapabilityDocument,
  ): Promise<InstallationCapabilityDocument> {
    const flags = document.commands.root.flags ?? []
    const probedAt = document.probedAt
    const source = 'probe:qwen--help'

    return {
      ...document,
      extensions: {
        ...document.extensions,
        plugins: {
          ...document.extensions.plugins,
          supported: this.supportsSubcommand(document.commands, 'extensions', probedAt),
          locations: [`${this.context.managedHome}/.qwen/extensions`],
        },
        hooks: {
          supported: this.supportsSubcommand(document.commands, 'hooks', probedAt),
          locations: [`${this.context.managedHome}/.qwen/settings.json`],
        },
      },
      runtimeModes: {
        ...document.runtimeModes,
        oneShot: flags.includes('--prompt')
          ? observed(true, source, probedAt)
          : unspecified<boolean>(),
        structuredOutput: flags.includes('--output-format')
          ? observed<'json' | 'jsonl' | 'text' | 'unspecified'>('jsonl', source, probedAt)
          : unspecified<'json' | 'jsonl' | 'text' | 'unspecified'>(),
        acp: flags.includes('--acp')
          ? observed(true, source, probedAt)
          : unspecified<boolean>(),
        daemon: this.supportsSubcommand(document.commands, 'serve', probedAt),
      },
      security: {
        ...document.security,
        permissionRules: flags.includes('--allowed-tools')
          ? observed(true, source, probedAt)
          : unspecified<boolean>(),
      },
      telemetry: flags.includes('--telemetry')
        ? {
            documented: true,
            enabledByDefault: null,
            optOutAvailable: true,
            optOutMechanisms: ['settings:telemetry.enabled'],
            usageSource: 'unspecified',
          }
        : document.telemetry,
    }
  }
}
