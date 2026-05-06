import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyToolProfile, getToolProfileConfig } from '../tool-profile-config.js'
import {
  resolveTokenProfile,
  selectGitWorkspace,
  selectHttpConnectorProfile,
} from '../tool-profile-selection.js'

describe('tool profile seams', () => {
  it('expands profile categories without dropping explicit tool names', () => {
    const requested = new Set(['github_get_file'])

    applyToolProfile(requested, 'full')

    expect(requested).toContain('github_get_file')
    expect(requested).toContain('git:*')
    expect(requested).toContain('github:*')
    expect(requested).toContain('slack:*')
    expect(requested).toContain('http:*')
    expect(requested).toContain('mcp:*')
    expect(getToolProfileConfig('full').enableConnectors).toBe(true)
  })

  it('selects a server-side HTTP connector profile before unsafe metadata fallback', () => {
    const selected = selectHttpConnectorProfile({
      metadata: {
        httpProfile: 'public-api',
        httpBaseUrl: 'https://unsafe.example.com',
        httpHeaders: { Authorization: 'Bearer unsafe' },
      },
      httpConnectorProfiles: {
        'public-api': {
          baseUrl: 'https://api.example.com',
          headers: { Authorization: 'Bearer server-owned' },
          timeoutMs: 1000,
        },
      },
      allowUnsafeMetadataHttpConnector: true,
    })

    expect(selected.profileName).toBe('public-api')
    expect(selected.profile).toEqual({
      baseUrl: 'https://api.example.com',
      headers: { Authorization: 'Bearer server-owned' },
      timeoutMs: 1000,
    })
    expect(selected.warnings).toEqual([])
  })

  it('selects environment HTTP profile with parsed host allowlist', () => {
    const selected = selectHttpConnectorProfile({
      env: {
        DZIP_HTTP_BASE_URL: 'https://api.example.com',
        DZIP_HTTP_ALLOWED_HOSTS: 'api.example.com, cdn.example.com ',
      },
    })

    expect(selected.profileName).toBe('env:DZIP_HTTP_BASE_URL')
    expect(selected.profile).toEqual({
      baseUrl: 'https://api.example.com',
      allowedHosts: ['api.example.com', 'cdn.example.com'],
    })
  })

  it('resolves connector tokens from selected server-side profiles', () => {
    const selected = resolveTokenProfile(
      'GitHub',
      { release: { envVar: 'GITHUB_RELEASE_TOKEN' } },
      'release',
      undefined,
      { GITHUB_RELEASE_TOKEN: 'ghp-release' },
      'GITHUB_TOKEN',
    )

    expect(selected).toEqual({
      token: 'ghp-release',
      profile: { envVar: 'GITHUB_RELEASE_TOKEN' },
      profileName: 'release',
      warnings: [],
    })
  })

  it('rejects metadata Git cwd that escapes the selected workspace root', () => {
    const selected = selectGitWorkspace({
      metadata: { cwd: '../outside' },
      gitWorkspaceProfiles: {
        default: { root: resolve('/tmp/dzupagent-profile-test/repo') },
      },
      allowUnsafeMetadataGitCwd: true,
    })

    expect(selected.cwd).toBeUndefined()
    expect(selected.allowedRoots).toBeUndefined()
    expect(selected.allowMutatingTools).toBe(false)
    expect(selected.warnings.some((warning) => warning.includes('escapes the selected workspace root'))).toBe(true)
  })
})
