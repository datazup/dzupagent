/**
 * Deep-tier installation inspector for the Claude Code CLI (FR-1.2).
 *
 * Every provider-specific fact below is either evidenced by a probe or left
 * `unspecified`. Config *paths* are candidates to test, not assertions that
 * the files exist — existence is decided by the probe.
 */
import type {
  CredentialBinding,
  InstallationCapabilityDocument,
} from "@dzupagent/adapter-types";
import {
  AdapterInstallationInspector,
  observed,
  unspecified,
  type ConfigLayerCandidate,
} from "./adapter-installation-inspector.js";

export class ClaudeInstallationInspector extends AdapterInstallationInspector {
  protected readonly binaryName = "claude";

  protected configCandidates(): ConfigLayerCandidate[] {
    const home = this.context.managedHome;

    return [
      {
        id: "claude-user-settings",
        scope: "user",
        path: `${home}/.claude/settings.json`,
        format: "json",
        precedence: 20,
      },
      {
        id: "claude-project-settings",
        scope: "project",
        path: ".claude/settings.json",
        format: "json",
        precedence: 30,
      },
      {
        id: "claude-local-settings",
        scope: "workspace",
        path: ".claude/settings.local.json",
        format: "json",
        precedence: 40,
      },
      {
        id: "claude-managed-policy",
        scope: "managed-policy",
        path: `${home}/.claude/managed-settings.json`,
        format: "json",
        precedence: 10,
      },
    ];
  }

  protected credentialCandidates(): CredentialBinding[] {
    return [
      {
        name: "anthropic-api-key",
        acceptedEnvVars: ["ANTHROPIC_API_KEY"],
        storage: "env",
        // Presence is not probed here: the probe env deliberately excludes
        // credential variables, so this inspector cannot observe it.
        configured: unspecified<boolean>(),
      },
    ];
  }

  protected override async enrich(
    document: InstallationCapabilityDocument
  ): Promise<InstallationCapabilityDocument> {
    const flags = document.commands.root.flags ?? [];
    const probedAt = document.probedAt;
    const source = "probe:claude--help";

    // Only claim a mode when its flag was actually advertised in help.
    const hasPrintFlag = flags.includes("--print");
    const hasOutputFormat = flags.includes("--output-format");

    return {
      ...document,
      extensions: {
        ...document.extensions,
        skills: {
          ...document.extensions.skills,
          standard: "agent-skills",
          locations: [`${this.context.managedHome}/.claude/skills`],
        },
        hooks: {
          ...document.extensions.hooks,
          locations: [`${this.context.managedHome}/.claude/settings.json`],
        },
      },
      runtimeModes: {
        ...document.runtimeModes,
        oneShot: hasPrintFlag
          ? observed(true, source, probedAt)
          : unspecified<boolean>(),
        structuredOutput: hasOutputFormat
          ? observed<"json" | "jsonl" | "text" | "unspecified">(
              "json",
              source,
              probedAt
            )
          : unspecified<"json" | "jsonl" | "text" | "unspecified">(),
      },
      security: {
        ...document.security,
        permissionRules: flags.includes("--allowedTools")
          ? observed(true, source, probedAt)
          : unspecified<boolean>(),
      },
    };
  }
}
