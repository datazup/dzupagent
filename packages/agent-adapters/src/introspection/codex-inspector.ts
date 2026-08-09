/**
 * Deep-tier installation inspector for the Codex CLI (FR-1.2).
 *
 * Codex differs from Claude in two ways that matter here: its config is TOML
 * rather than JSON, and its approval posture is expressed through explicit
 * `--ask-for-approval` / sandbox flags rather than a tool allowlist.
 */
import type {
  CredentialBinding,
  InstallationCapabilityDocument,
} from "@dzupagent/adapter-types/monitoring/installation";
import {
  AdapterInstallationInspector,
  observed,
  unspecified,
  type ConfigLayerCandidate,
} from "./adapter-installation-inspector.js";

export class CodexInstallationInspector extends AdapterInstallationInspector {
  protected readonly binaryName = "codex";

  protected configCandidates(): ConfigLayerCandidate[] {
    const home = this.context.managedHome;

    return [
      {
        id: "codex-user-config",
        scope: "user",
        path: `${home}/.codex/config.toml`,
        format: "toml",
        precedence: 20,
      },
      {
        id: "codex-project-config",
        scope: "project",
        path: ".codex/config.toml",
        format: "toml",
        precedence: 30,
      },
    ];
  }

  protected credentialCandidates(): CredentialBinding[] {
    return [
      {
        name: "openai-api-key",
        acceptedEnvVars: ["OPENAI_API_KEY"],
        storage: "env",
        configured: unspecified<boolean>(),
      },
      {
        name: "codex-oauth",
        acceptedEnvVars: [],
        storage: "oauth",
        configured: unspecified<boolean>(),
      },
    ];
  }

  protected override async enrich(
    document: InstallationCapabilityDocument
  ): Promise<InstallationCapabilityDocument> {
    const flags = document.commands.root.flags ?? [];
    const probedAt = document.probedAt;
    const source = "probe:codex--help";

    const hasExec = document.commands.subcommands.some(
      (command) => command.path[command.path.length - 1] === "exec"
    );
    const hasApprovalFlag = flags.includes("--ask-for-approval");

    return {
      ...document,
      extensions: {
        ...document.extensions,
        skills: {
          ...document.extensions.skills,
          standard: "none",
          locations: [],
        },
      },
      runtimeModes: {
        ...document.runtimeModes,
        // `codex exec` is the non-interactive entrypoint.
        oneShot: hasExec
          ? observed(true, source, probedAt)
          : unspecified<boolean>(),
        structuredOutput: flags.includes("--json")
          ? observed<"json" | "jsonl" | "text" | "unspecified">(
              "jsonl",
              source,
              probedAt
            )
          : unspecified<"json" | "jsonl" | "text" | "unspecified">(),
      },
      security: {
        ...document.security,
        // Left unspecified regardless: the flag's presence proves the control
        // is configurable, never what it defaults to. Reading a default off a
        // flag listing is exactly the guess this model forbids — it needs a
        // config read or a documented fact.
        approvalDefault: unspecified<
          "ask" | "allow" | "always-approve" | "mixed"
        >(),
        permissionRules: hasApprovalFlag
          ? observed(true, source, probedAt)
          : unspecified<boolean>(),
      },
    };
  }
}
