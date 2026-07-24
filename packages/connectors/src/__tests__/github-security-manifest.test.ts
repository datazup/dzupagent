import { describe, expect, it } from 'vitest'

import {
  attachConnectorSecurityManifest,
  createGitHubConnectorToolkit,
  resolveConnectorSecurityReadiness,
  validateFlowConnectorSecurityManifest,
} from '../index.js'
import {
  GITHUB_CONNECTOR_CREDENTIAL_CAPABILITY,
  GITHUB_CONNECTOR_CREDENTIAL_PATH,
  GITHUB_CONNECTOR_SECURITY_MANIFEST,
  GITHUB_CONNECTOR_SECURITY_POLICY_SOURCE,
  GITHUB_CONNECTOR_SECURITY_TOOL_REFS,
  GITHUB_FINE_GRAINED_REPOSITORY_SCOPES,
  createGitHubConnectorSecurityManifest,
} from '../github-security.js'

describe('GitHub connector security manifest', () => {
  it('covers every real GitHub connector tool with a valid reviewed policy', () => {
    const toolkit = createGitHubConnectorToolkit({ token: 'not-invoked' })
    const published = toolkit.tools.map(({ name }) => name).sort()
    const declared = [...GITHUB_CONNECTOR_SECURITY_TOOL_REFS].sort()

    expect(declared).toEqual(published)
    expect(GITHUB_CONNECTOR_SECURITY_MANIFEST.tools).toHaveLength(22)
    expect(
      validateFlowConnectorSecurityManifest(
        GITHUB_CONNECTOR_SECURITY_MANIFEST,
      ),
    ).toEqual([])

    const qualified = attachConnectorSecurityManifest(
      toolkit,
      GITHUB_CONNECTOR_SECURITY_MANIFEST,
    )
    expect(resolveConnectorSecurityReadiness(qualified)).toEqual({
      ready: true,
      issues: [],
    })
    expect(toolkit.securityManifest).toBeUndefined()
  })

  it('binds exact handle, provider, classification, and evidence obligations', () => {
    const createIssue = GITHUB_CONNECTOR_SECURITY_MANIFEST.tools.find(
      ({ toolRef }) => toolRef === 'github_create_issue',
    )
    const mergePullRequest = GITHUB_CONNECTOR_SECURITY_MANIFEST.tools.find(
      ({ toolRef }) => toolRef === 'github_merge_pr',
    )
    const checks = GITHUB_CONNECTOR_SECURITY_MANIFEST.tools.find(
      ({ toolRef }) => toolRef === 'github_get_pr_checks',
    )

    expect(createIssue?.policy).toEqual(
      expect.objectContaining({
        acceptedInputClassifications: ['public', 'internal', 'sensitive'],
        credential: {
          mode: 'handle-only',
          inputPaths: [GITHUB_CONNECTOR_CREDENTIAL_PATH],
          resolverCapabilityRef: GITHUB_CONNECTOR_CREDENTIAL_CAPABILITY,
          allowedProviders: ['github'],
          requiredScopes: [
            GITHUB_FINE_GRAINED_REPOSITORY_SCOPES.issuesWrite,
          ],
        },
        outputClassification: 'sensitive',
        effectClasses: ['network_write'],
        evidence: {
          required: ['github-request-id', 'github-operation-result'],
          classification: 'internal',
          rawContent: 'forbidden',
        },
      }),
    )
    expect(mergePullRequest?.policy.effectClasses).toEqual([
      'network_write',
      'code_change',
    ])
    expect(mergePullRequest?.policy.credential.requiredScopes).toEqual([
      GITHUB_FINE_GRAINED_REPOSITORY_SCOPES.contentsWrite,
    ])
    expect(checks?.policy.credential.requiredScopes).toEqual([
      GITHUB_FINE_GRAINED_REPOSITORY_SCOPES.checksRead,
    ])
  })

  it('qualifies exact enabled subsets without mutating the full manifest', () => {
    const enabledTools = ['github_get_repo', 'github_list_issues']
    const toolkit = createGitHubConnectorToolkit({
      token: 'not-invoked',
      enabledTools,
    })
    const subset = createGitHubConnectorSecurityManifest(enabledTools)
    const qualified = attachConnectorSecurityManifest(toolkit, subset)

    expect(subset.tools.map(({ toolRef }) => toolRef).sort()).toEqual(
      [...enabledTools].sort(),
    )
    expect(resolveConnectorSecurityReadiness(qualified).ready).toBe(true)
    expect(GITHUB_CONNECTOR_SECURITY_MANIFEST.tools).toHaveLength(22)
    expect(Object.isFrozen(subset)).toBe(true)
    expect(Object.isFrozen(subset.tools)).toBe(true)
  })

  it('fails closed for empty, duplicate, or unknown tool selections', () => {
    expect(() => createGitHubConnectorSecurityManifest([])).toThrow(
      /cannot be empty/,
    )
    expect(() =>
      createGitHubConnectorSecurityManifest([
        'github_get_repo',
        'github_get_repo',
      ]),
    ).toThrow(/duplicates tool/)
    expect(() =>
      createGitHubConnectorSecurityManifest(['github_delete_repository']),
    ).toThrow(/unknown tool/)
  })

  it('publishes review provenance without executable or credential material', () => {
    expect(GITHUB_CONNECTOR_SECURITY_POLICY_SOURCE.apiVersion).toBe(
      '2022-11-28',
    )
    expect(GITHUB_CONNECTOR_SECURITY_POLICY_SOURCE.documentation).not.toHaveLength(
      0,
    )
    const serialized = JSON.stringify({
      manifest: GITHUB_CONNECTOR_SECURITY_MANIFEST,
      source: GITHUB_CONNECTOR_SECURITY_POLICY_SOURCE,
    })
    expect(serialized).not.toContain('not-invoked')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('Bearer ')
    expect(serialized).not.toContain('"token"')
  })
})
