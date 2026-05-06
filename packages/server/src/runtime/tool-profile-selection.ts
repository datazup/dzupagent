import { isAbsolute, relative, resolve } from 'node:path'

export interface HttpConnectorProfile {
  /** Server-side base URL for the HTTP connector. */
  baseUrl: string
  /** Server-side headers or secret-resolved header values for this profile. */
  headers?: Record<string, string>
  /** Optional method allowlist passed to the connector. */
  allowedMethods?: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>
  /** Optional request timeout passed to the connector. */
  timeoutMs?: number
  /** Private/loopback/link-local hosts explicitly allowed for this profile. */
  allowedHosts?: string[]
}

export interface ConnectorTokenProfile {
  /** Server-owned token value. Prefer envVar in production hosts. */
  token?: string
  /** Environment variable name resolved by the server at execution time. */
  envVar?: string
  /** Optional connector API base URL for private/enterprise deployments. */
  baseUrl?: string
  /** Private/loopback/link-local hosts explicitly allowed for this profile. */
  allowedHosts?: string[]
}

export interface GitWorkspaceProfile {
  /** Server-side repository/workspace root for built-in Git tools. */
  root: string
  /** Explicit host-side policy allowing mutating Git tools such as commit or branch switch. */
  allowMutatingTools?: boolean
}

export interface ToolProfileSelectionContext {
  metadata?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  httpConnectorProfiles?: Record<string, HttpConnectorProfile>
  defaultHttpConnectorProfile?: string
  githubConnectorProfiles?: Record<string, ConnectorTokenProfile>
  defaultGithubConnectorProfile?: string
  slackConnectorProfiles?: Record<string, ConnectorTokenProfile>
  defaultSlackConnectorProfile?: string
  gitWorkspaceProfiles?: Record<string, GitWorkspaceProfile>
  defaultGitWorkspaceProfile?: string
  allowUnsafeMetadataHttpConnector?: boolean
  allowUnsafeMetadataGitCwd?: boolean
}

function parseCsvSet(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries.length ? entries : undefined
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function selectGitWorkspace(context: ToolProfileSelectionContext): {
  cwd?: string
  allowedRoots?: string[]
  allowMutatingTools: boolean
  profileName?: string
  warnings: string[]
} {
  const warnings: string[] = []
  const profileName = typeof context.metadata?.['gitWorkspace'] === 'string' && context.metadata['gitWorkspace'].trim()
    ? context.metadata['gitWorkspace'].trim()
    : context.defaultGitWorkspaceProfile ?? 'default'

  const hasProfiles = context.gitWorkspaceProfiles && Object.keys(context.gitWorkspaceProfiles).length > 0
  const configuredProfile = context.gitWorkspaceProfiles?.[profileName]

  if (hasProfiles && !configuredProfile) {
    warnings.push(`Git workspace profile "${profileName}" is not configured.`)
    return { allowMutatingTools: false, warnings }
  }

  const root = resolve(configuredProfile?.root ?? process.cwd())
  let cwd = root

  const metadataCwd = typeof context.metadata?.['cwd'] === 'string'
    ? context.metadata['cwd']
    : undefined

  if (metadataCwd && context.allowUnsafeMetadataGitCwd) {
    const requestedCwd = resolve(root, metadataCwd)
    if (!isInsideRoot(requestedCwd, root)) {
      warnings.push('Ignoring metadata.cwd for Git tools because it escapes the selected workspace root.')
      return { allowMutatingTools: false, warnings }
    }
    warnings.push('Using unsafe metadata-controlled Git cwd within the selected workspace root.')
    cwd = requestedCwd
  } else if (metadataCwd) {
    warnings.push(
      'Ignoring metadata.cwd for Git tools; configure gitWorkspaceProfiles or set allowUnsafeMetadataGitCwd.',
    )
  }

  return {
    cwd,
    allowedRoots: [root],
    allowMutatingTools: configuredProfile?.allowMutatingTools === true,
    profileName,
    warnings,
  }
}

export function selectHttpConnectorProfile(context: ToolProfileSelectionContext): {
  profile?: HttpConnectorProfile
  profileName?: string
  warnings: string[]
} {
  const warnings: string[] = []
  const profileName = typeof context.metadata?.['httpProfile'] === 'string' && context.metadata['httpProfile'].trim()
    ? context.metadata['httpProfile'].trim()
    : context.defaultHttpConnectorProfile ?? 'default'

  const configuredProfile = context.httpConnectorProfiles?.[profileName]
  if (configuredProfile) {
    return { profile: configuredProfile, profileName, warnings }
  }

  if (context.httpConnectorProfiles && Object.keys(context.httpConnectorProfiles).length > 0) {
    warnings.push(`HTTP connector profile "${profileName}" is not configured.`)
    return { warnings }
  }

  const envBaseUrl = context.env?.['DZIP_HTTP_BASE_URL']
  if (envBaseUrl) {
    const allowedHosts = parseCsvSet(context.env?.['DZIP_HTTP_ALLOWED_HOSTS'])
    return {
      profile: {
        baseUrl: envBaseUrl,
        ...(allowedHosts ? { allowedHosts } : {}),
      },
      profileName: 'env:DZIP_HTTP_BASE_URL',
      warnings,
    }
  }

  if (context.allowUnsafeMetadataHttpConnector) {
    const metadataBaseUrl = typeof context.metadata?.['httpBaseUrl'] === 'string'
      ? context.metadata['httpBaseUrl']
      : undefined
    if (metadataBaseUrl) {
      const headerRecord = context.metadata?.['httpHeaders']
      const headers = (headerRecord && typeof headerRecord === 'object' && !Array.isArray(headerRecord))
        ? Object.fromEntries(
            Object.entries(headerRecord)
              .filter(([, v]) => typeof v === 'string') as Array<[string, string]>,
          )
        : undefined

      warnings.push('Using unsafe metadata-controlled HTTP connector configuration.')
      const allowedHosts = parseCsvSet(context.env?.['DZIP_HTTP_ALLOWED_HOSTS'])
      return {
        profile: {
          baseUrl: metadataBaseUrl,
          ...(headers ? { headers } : {}),
          ...(allowedHosts ? { allowedHosts } : {}),
        },
        profileName: 'unsafe-metadata',
        warnings,
      }
    }
  } else if (context.metadata?.['httpBaseUrl'] || context.metadata?.['httpHeaders']) {
    warnings.push(
      'Ignoring metadata.httpBaseUrl/httpHeaders for HTTP connector; configure httpConnectorProfiles or set allowUnsafeMetadataHttpConnector.',
    )
  }

  return { warnings }
}

export function resolveTokenProfile(
  kind: 'GitHub' | 'Slack',
  profiles: Record<string, ConnectorTokenProfile> | undefined,
  selectedProfile: unknown,
  defaultProfile: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  fallbackEnvVar: 'GITHUB_TOKEN' | 'SLACK_BOT_TOKEN',
): { token?: string; profile?: ConnectorTokenProfile; profileName?: string; warnings: string[] } {
  const warnings: string[] = []
  const profileName = typeof selectedProfile === 'string' && selectedProfile.trim()
    ? selectedProfile.trim()
    : defaultProfile ?? 'default'

  const configuredProfile = profiles?.[profileName]
  if (configuredProfile) {
    const token = configuredProfile.token ?? (
      configuredProfile.envVar ? env?.[configuredProfile.envVar] : undefined
    )
    if (token) return { token, profile: configuredProfile, profileName, warnings }
    warnings.push(`${kind} connector profile "${profileName}" has no resolvable token.`)
    return { profile: configuredProfile, profileName, warnings }
  }

  if (profiles && Object.keys(profiles).length > 0) {
    warnings.push(`${kind} connector profile "${profileName}" is not configured.`)
    return { warnings }
  }

  const token = env?.[fallbackEnvVar]
  if (token) return { token, profileName: `env:${fallbackEnvVar}`, warnings }

  return { warnings }
}
