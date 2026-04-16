export { createGitHubConnector, createGitHubConnectorToolkit } from './github-connector.js'
export type { GitHubConnectorConfig } from './github-connector.js'

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
