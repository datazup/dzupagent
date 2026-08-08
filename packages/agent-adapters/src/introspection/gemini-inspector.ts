/** Partial-tier installation inspector for Gemini CLI (WP-M1.6). */
import type {
  CredentialBinding,
  InstallationCapabilityDocument,
} from '@dzupagent/adapter-types'
import {
  AdapterInstallationInspector,
  observed,
  unspecified,
  type ConfigLayerCandidate,
} from './adapter-installation-inspector.js'

export class GeminiInstallationInspector extends AdapterInstallationInspector {
  protected readonly binaryName = 'gemini'

  protected configCandidates(): ConfigLayerCandidate[] {
    const home = this.context.managedHome
    return [
      {
        id: 'gemini-user-settings',
        scope: 'user',
        path: `${home}/.gemini/settings.json`,
        format: 'json',
        precedence: 20,
      },
      {
        id: 'gemini-project-settings',
        scope: 'project',
        path: '.gemini/settings.json',
        format: 'json',
        precedence: 30,
      },
    ]
  }

  protected credentialCandidates(): CredentialBinding[] {
    return [
      {
        name: 'gemini-api-key',
        acceptedEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        storage: 'env',
        configured: unspecified<boolean>(),
      },
      {
        name: 'gemini-oauth',
        acceptedEnvVars: [],
        storage: 'oauth',
        configured: unspecified<boolean>(),
      },
    ]
  }

  protected override async enrich(
    document: InstallationCapabilityDocument,
  ): Promise<InstallationCapabilityDocument> {
    const flags = document.commands.root.flags ?? []
    const probedAt = document.probedAt
    const source = 'probe:gemini--help'

    return {
      ...document,
      extensions: {
        ...document.extensions,
        plugins: {
          ...document.extensions.plugins,
          supported: this.supportsSubcommand(document.commands, 'extensions', probedAt),
          locations: [`${this.context.managedHome}/.gemini/extensions`],
        },
        skills: {
          supported: this.supportsSubcommand(document.commands, 'skills', probedAt),
          standard: 'agent-skills',
          locations: [`${this.context.managedHome}/.gemini/skills`],
        },
        hooks: {
          supported: this.supportsSubcommand(document.commands, 'hooks', probedAt),
          locations: [`${this.context.managedHome}/.gemini/settings.json`],
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
      },
      security: {
        ...document.security,
        permissionRules: flags.includes('--policy')
          ? observed(true, source, probedAt)
          : unspecified<boolean>(),
      },
    }
  }
}
