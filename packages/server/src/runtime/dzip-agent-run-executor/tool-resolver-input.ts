import type { ToolResolverContext } from "../tool-resolver.js";
import type { DzupAgentRunExecutorOptions } from "./options.js";

/**
 * Builds the {@link ToolResolverContext} passed to `resolveAgentTools` from the
 * run's requested tool names / metadata and the server-owned connector/workspace
 * profiles configured on the executor. Optional profile fields are only spread
 * when defined so the resolver's own defaults are preserved (zero behavior
 * change vs. the inline construction this replaced).
 */
export function buildToolResolverContext(
  args: {
    toolNames: string[] | undefined;
    metadata: Record<string, unknown> | undefined;
  },
  options: DzupAgentRunExecutorOptions | undefined
): ToolResolverContext {
  return {
    toolNames: args.toolNames,
    metadata: args.metadata,
    env: process.env,
    ...(options?.httpConnectorProfiles
      ? { httpConnectorProfiles: options.httpConnectorProfiles }
      : {}),
    ...(options?.defaultHttpConnectorProfile
      ? { defaultHttpConnectorProfile: options.defaultHttpConnectorProfile }
      : {}),
    ...(options?.githubConnectorProfiles
      ? { githubConnectorProfiles: options.githubConnectorProfiles }
      : {}),
    ...(options?.defaultGithubConnectorProfile
      ? {
          defaultGithubConnectorProfile: options.defaultGithubConnectorProfile,
        }
      : {}),
    ...(options?.slackConnectorProfiles
      ? { slackConnectorProfiles: options.slackConnectorProfiles }
      : {}),
    ...(options?.defaultSlackConnectorProfile
      ? { defaultSlackConnectorProfile: options.defaultSlackConnectorProfile }
      : {}),
    ...(options?.allowUnsafeMetadataHttpConnector !== undefined
      ? {
          allowUnsafeMetadataHttpConnector:
            options.allowUnsafeMetadataHttpConnector,
        }
      : {}),
    ...(options?.gitWorkspaceProfiles
      ? { gitWorkspaceProfiles: options.gitWorkspaceProfiles }
      : {}),
    ...(options?.defaultGitWorkspaceProfile
      ? { defaultGitWorkspaceProfile: options.defaultGitWorkspaceProfile }
      : {}),
    ...(options?.allowUnsafeMetadataGitCwd !== undefined
      ? { allowUnsafeMetadataGitCwd: options.allowUnsafeMetadataGitCwd }
      : {}),
  };
}
