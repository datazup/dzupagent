export { createGitHubConnector, createGitHubConnectorToolkit } from './github-connector.js'
export type { GitHubConnectorConfig } from './github-connector.js'
export {
  GITHUB_CONNECTOR_CREDENTIAL_CAPABILITY,
  GITHUB_CONNECTOR_CREDENTIAL_PATH,
  GITHUB_CONNECTOR_SECURITY_MANIFEST,
  GITHUB_CONNECTOR_SECURITY_POLICY_SOURCE,
  GITHUB_CONNECTOR_SECURITY_PROVIDER,
  GITHUB_CONNECTOR_SECURITY_REF,
  GITHUB_CONNECTOR_SECURITY_TOOL_REFS,
  GITHUB_FINE_GRAINED_REPOSITORY_SCOPES,
  createGitHubConnectorSecurityManifest,
} from './github-security-manifest.js'

export { GitHubClient, GitHubApiError } from './github-client.js'
export type {
  GitHubClientConfig,
  GitHubIssue,
  GitHubComment,
  GitHubPullRequest,
  GitHubReview,
  GitHubMergeResult,
  GitHubRepo,
  GitHubBranch,
  GitHubCommit,
  GitHubComparison,
  GitHubContent,
  ListIssuesOptions,
  UpdateIssueOptions,
  ListPRsOptions,
  MergePROptions,
} from './github-client.js'
