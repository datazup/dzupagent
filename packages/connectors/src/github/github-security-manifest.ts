import type {
  EffectClass,
  FlowConnectorSecurityManifest,
} from '@dzupagent/flow-ast'
import {
  defineFlowConnectorSecurityManifest,
  defineFlowToolSecurityPolicy,
} from '../security-manifest.js'

export const GITHUB_CONNECTOR_SECURITY_REF =
  'connector://dzupagent/github-rest@1' as const
export const GITHUB_CONNECTOR_SECURITY_PROVIDER = 'github' as const
export const GITHUB_CONNECTOR_CREDENTIAL_PATH = 'input.credential' as const
export const GITHUB_CONNECTOR_CREDENTIAL_CAPABILITY =
  'flow.runtime.credential.resolve@1' as const

/**
 * Canonical host scope vocabulary for GitHub fine-grained repository
 * permissions. These strings are carried by credential handles; they are not
 * raw OAuth tokens or classic PAT scope strings.
 */
export const GITHUB_FINE_GRAINED_REPOSITORY_SCOPES = Object.freeze({
  actionsRead: 'actions:read',
  checksRead: 'checks:read',
  contentsRead: 'contents:read',
  contentsWrite: 'contents:write',
  issuesRead: 'issues:read',
  issuesWrite: 'issues:write',
  metadataRead: 'metadata:read',
  pullRequestsRead: 'pull_requests:read',
  pullRequestsWrite: 'pull_requests:write',
} as const)

export const GITHUB_CONNECTOR_SECURITY_POLICY_SOURCE = Object.freeze({
  apiVersion: '2022-11-28',
  reviewedOn: '2026-07-24',
  documentation: Object.freeze([
    'https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/issues/labels?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/branches/branches?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28',
    'https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28',
  ]),
})

interface GitHubToolPolicySpec {
  readonly toolRef: string
  readonly requiredScopes: readonly string[]
  readonly effectClasses: readonly EffectClass[]
  readonly evidence: readonly string[]
}

const READ_EVIDENCE = Object.freeze([
  'github-request-id',
  'github-response-digest',
])
const WRITE_EVIDENCE = Object.freeze([
  'github-request-id',
  'github-operation-result',
])
const SCOPE = GITHUB_FINE_GRAINED_REPOSITORY_SCOPES

const GITHUB_TOOL_POLICY_SPECS: readonly GitHubToolPolicySpec[] = Object.freeze([
  {
    toolRef: 'github_get_file',
    requiredScopes: [SCOPE.contentsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_list_issues',
    requiredScopes: [SCOPE.issuesRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_get_issue',
    requiredScopes: [SCOPE.issuesRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_create_issue',
    requiredScopes: [SCOPE.issuesWrite],
    effectClasses: ['network_write'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_update_issue',
    requiredScopes: [SCOPE.issuesWrite],
    effectClasses: ['network_write'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_add_comment',
    requiredScopes: [SCOPE.issuesWrite, SCOPE.pullRequestsWrite],
    effectClasses: ['network_write'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_list_prs',
    requiredScopes: [SCOPE.pullRequestsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_get_pr',
    requiredScopes: [SCOPE.pullRequestsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_create_pr',
    requiredScopes: [SCOPE.pullRequestsWrite],
    effectClasses: ['network_write'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_merge_pr',
    requiredScopes: [SCOPE.contentsWrite],
    effectClasses: ['network_write', 'code_change'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_list_pr_reviews',
    requiredScopes: [SCOPE.pullRequestsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_create_pr_review',
    requiredScopes: [SCOPE.pullRequestsWrite],
    effectClasses: ['network_write'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_get_repo',
    requiredScopes: [SCOPE.metadataRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_list_branches',
    requiredScopes: [SCOPE.contentsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_get_commit',
    requiredScopes: [SCOPE.contentsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_compare_commits',
    requiredScopes: [SCOPE.contentsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_get_pr_checks',
    requiredScopes: [SCOPE.checksRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_add_labels',
    requiredScopes: [SCOPE.issuesWrite, SCOPE.pullRequestsWrite],
    effectClasses: ['network_write'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_remove_label',
    requiredScopes: [SCOPE.issuesWrite, SCOPE.pullRequestsWrite],
    effectClasses: ['network_write'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_create_review_comment',
    requiredScopes: [SCOPE.pullRequestsWrite],
    effectClasses: ['network_write'],
    evidence: WRITE_EVIDENCE,
  },
  {
    toolRef: 'github_get_workflow_runs',
    requiredScopes: [SCOPE.actionsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
  {
    toolRef: 'github_search_code',
    requiredScopes: [SCOPE.contentsRead],
    effectClasses: ['read'],
    evidence: READ_EVIDENCE,
  },
])

export const GITHUB_CONNECTOR_SECURITY_TOOL_REFS = Object.freeze(
  GITHUB_TOOL_POLICY_SPECS.map(({ toolRef }) => toolRef),
)

function defineGitHubToolPolicy(spec: GitHubToolPolicySpec) {
  return defineFlowToolSecurityPolicy({
    acceptedInputClassifications: ['public', 'internal', 'sensitive'],
    credential: {
      mode: 'handle-only',
      inputPaths: [GITHUB_CONNECTOR_CREDENTIAL_PATH],
      resolverCapabilityRef: GITHUB_CONNECTOR_CREDENTIAL_CAPABILITY,
      allowedProviders: [GITHUB_CONNECTOR_SECURITY_PROVIDER],
      requiredScopes: spec.requiredScopes,
    },
    outputClassification: 'sensitive',
    effectClasses: spec.effectClasses,
    evidence: {
      required: spec.evidence,
      classification: 'internal',
      rawContent: 'forbidden',
    },
  })
}

const GITHUB_CONNECTOR_SECURITY_TOOLS = Object.freeze(
  GITHUB_TOOL_POLICY_SPECS.map((spec) =>
    Object.freeze({
      toolRef: spec.toolRef,
      policy: defineGitHubToolPolicy(spec),
    }),
  ),
)

export const GITHUB_CONNECTOR_SECURITY_MANIFEST =
  defineFlowConnectorSecurityManifest({
    ref: GITHUB_CONNECTOR_SECURITY_REF,
    provider: GITHUB_CONNECTOR_SECURITY_PROVIDER,
    tools: GITHUB_CONNECTOR_SECURITY_TOOLS,
  })

/**
 * Return the reviewed full manifest or an exact enabled-tool subset.
 * Unknown, duplicate, or empty selections fail closed.
 *
 * This is a provider-free catalog operation. It does not create a client,
 * resolve a credential handle, or claim that the legacy token-configured
 * connector is a strict runtime host.
 */
export function createGitHubConnectorSecurityManifest(
  enabledTools?: readonly string[],
): FlowConnectorSecurityManifest {
  if (enabledTools === undefined) return GITHUB_CONNECTOR_SECURITY_MANIFEST
  if (enabledTools.length === 0) {
    throw new TypeError('GitHub security manifest selection cannot be empty')
  }
  const requested = new Set<string>()
  for (const toolRef of enabledTools) {
    if (requested.has(toolRef)) {
      throw new TypeError(
        `GitHub security manifest selection duplicates tool: ${toolRef}`,
      )
    }
    if (!GITHUB_CONNECTOR_SECURITY_TOOL_REFS.includes(toolRef)) {
      throw new TypeError(
        `GitHub security manifest selection contains unknown tool: ${toolRef}`,
      )
    }
    requested.add(toolRef)
  }
  return defineFlowConnectorSecurityManifest({
    ref: GITHUB_CONNECTOR_SECURITY_REF,
    provider: GITHUB_CONNECTOR_SECURITY_PROVIDER,
    tools: GITHUB_CONNECTOR_SECURITY_TOOLS.filter(({ toolRef }) =>
      requested.has(toolRef),
    ),
  })
}
