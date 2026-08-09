import { describe, expect, it } from "vitest";
import { ClaudeInstallationInspector } from "../claude-inspector.js";
import { CodexInstallationInspector } from "../codex-inspector.js";
import {
  buildProbeEnv,
  parseHelpFlags,
  parseHelpSubcommands,
  parseVersion,
  PROBE_ENV_ALLOWLIST,
} from "../probe-runner.js";
import type { InspectorContext } from "../adapter-installation-inspector.js";
import type { AdapterInstallationRef } from "@dzupagent/adapter-types/monitoring/installation";
import {
  CLAUDE_HELP_FIXTURE,
  CLAUDE_VERSION_FIXTURE,
  CODEX_HELP_FIXTURE,
  CODEX_VERSION_FIXTURE,
  FIXED_NOW,
  fixedClock,
  notInstalled,
  ok,
  recordingRunner,
  timedOut,
} from "./fixtures/probe-fixtures.js";

const MANAGED_HOME = "/managed/home";

function claudeRef(): AdapterInstallationRef {
  return {
    installationId: "inst-claude-01",
    coordinates: { providerId: "claude", backend: "cli" },
    hostBindingId: "worker-7",
    managed: true,
  };
}

function codexRef(): AdapterInstallationRef {
  return {
    installationId: "inst-codex-01",
    coordinates: { providerId: "codex", backend: "cli" },
    hostBindingId: "worker-7",
    managed: true,
  };
}

function claudeContext(
  overrides: Partial<InspectorContext> = {}
): InspectorContext {
  const runner = recordingRunner({
    "claude --version": ok(CLAUDE_VERSION_FIXTURE),
    "claude --help": ok(CLAUDE_HELP_FIXTURE),
  });

  return {
    runProbe: runner.run,
    managedHome: MANAGED_HOME,
    now: fixedClock,
    ...overrides,
  };
}

describe("probe discipline (doc 05 §4)", () => {
  it("builds a child env from the allowlist only", () => {
    const env = buildProbeEnv({
      source: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "sk-secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        RANDOM_VAR: "x",
      },
      managedHome: MANAGED_HOME,
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");

    // A capability probe never authenticates, so a credential must not leak
    // into a third-party binary.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it("excludes credential variables from the allowlist itself", () => {
    expect(PROBE_ENV_ALLOWLIST).not.toContain("ANTHROPIC_API_KEY");
    expect(PROBE_ENV_ALLOWLIST).not.toContain("OPENAI_API_KEY");
    expect(PROBE_ENV_ALLOWLIST).toContain("PATH");
  });

  it("redirects HOME and XDG into the managed home", () => {
    const env = buildProbeEnv({
      source: {
        HOME: "/home/real-user",
        XDG_CONFIG_HOME: "/home/real-user/.config",
      },
      managedHome: MANAGED_HOME,
    });

    // A real profile must be unreachable even when HOME is already set.
    expect(env.HOME).toBe(MANAGED_HOME);
    expect(env.HOME).not.toBe("/home/real-user");
    expect(env.XDG_CONFIG_HOME).toBe(`${MANAGED_HOME}/.config`);
    expect(env.XDG_CACHE_HOME).toBe(`${MANAGED_HOME}/.cache`);
  });

  it("does not mutate the source environment", () => {
    const source = { PATH: "/usr/bin", HOME: "/home/real-user" };
    buildProbeEnv({ source, managedHome: MANAGED_HOME });

    expect(source.HOME).toBe("/home/real-user");
  });

  it("only walks subcommands the help text advertised", async () => {
    const runner = recordingRunner({
      "claude --version": ok(CLAUDE_VERSION_FIXTURE),
      "claude --help": ok(CLAUDE_HELP_FIXTURE),
    });
    const inspector = new ClaudeInstallationInspector({
      runProbe: runner.run,
      managedHome: MANAGED_HOME,
      now: fixedClock,
    });

    await inspector.inspect(claudeRef());

    // Probing an unadvertised subcommand is the failure this rule prevents.
    const invoked = runner.calls.map((call) =>
      [call.command, ...call.args].join(" ")
    );
    expect(invoked).toEqual([
      "claude --version",
      "claude --help",
      "claude agents --help",
      "claude mcp --help",
      "claude plugin --help",
    ]);
    expect(invoked).not.toContain("claude auth --help");
    expect(invoked).not.toContain("claude update --help");
    expect(invoked.some((call) => call.includes("nonexistent"))).toBe(false);
  });

  it("passes a timeout on every probe", async () => {
    const runner = recordingRunner({
      "claude --version": ok(CLAUDE_VERSION_FIXTURE),
      "claude --help": ok(CLAUDE_HELP_FIXTURE),
    });
    const inspector = new ClaudeInstallationInspector({
      runProbe: runner.run,
      managedHome: MANAGED_HOME,
      now: fixedClock,
      timeoutMs: 1234,
    });

    await inspector.inspect(claudeRef());

    expect(runner.calls).toHaveLength(5);
    for (const call of runner.calls) {
      expect(call.timeoutMs).toBe(1234);
    }
  });

  it("never concatenates arguments into the command string", async () => {
    const runner = recordingRunner({
      "claude --version": ok(CLAUDE_VERSION_FIXTURE),
      "claude --help": ok(CLAUDE_HELP_FIXTURE),
    });
    const inspector = new ClaudeInstallationInspector({
      runProbe: runner.run,
      managedHome: MANAGED_HOME,
      now: fixedClock,
    });

    await inspector.inspect(claudeRef());

    for (const call of runner.calls) {
      expect(call.command).toBe("claude");
      expect(call.command).not.toContain(" ");
      expect(Array.isArray(call.args)).toBe(true);
    }
  });
});

describe("help parsing", () => {
  it("extracts only the advertised subcommands", () => {
    expect(parseHelpSubcommands(CLAUDE_HELP_FIXTURE)).toEqual([
      "agents",
      "auth",
      "mcp",
      "plugin",
      "update",
    ]);
  });

  it("yields different subcommands for different providers", () => {
    // The fixtures must disagree, or a constant-returning parser would pass.
    const claude = parseHelpSubcommands(CLAUDE_HELP_FIXTURE);
    const codex = parseHelpSubcommands(CODEX_HELP_FIXTURE);

    expect(codex).toEqual([
      "exec",
      "review",
      "login",
      "mcp",
      "plugin",
      "update",
      "doctor",
      "resume",
      "fork",
    ]);
    expect(claude).not.toEqual(codex);
  });

  it("returns no subcommands for unrecognized help layouts", () => {
    // Conservative by design: no parse means no probing, never a guess.
    expect(parseHelpSubcommands("some unstructured blob of text")).toEqual([]);
  });

  it("extracts long flags without their values", () => {
    const flags = parseHelpFlags(CLAUDE_HELP_FIXTURE);

    expect(flags).toContain("--print");
    expect(flags).toContain("--output-format");
    expect(flags).toContain("--allowedTools");
    expect(flags.every((flag) => !flag.includes(" "))).toBe(true);
  });

  it("parses a semver token out of version output", () => {
    expect(parseVersion(CLAUDE_VERSION_FIXTURE)).toBe("2.1.226");
    expect(parseVersion(CODEX_VERSION_FIXTURE)).toBe("0.147.0");
  });

  it("returns null rather than the raw line when no version is present", () => {
    expect(parseVersion("unknown build")).toBeNull();
  });
});

describe("ClaudeInstallationInspector", () => {
  it("produces a presence:false document for a missing binary (FR-1.2 AC)", async () => {
    const inspector = new ClaudeInstallationInspector(
      claudeContext({
        runProbe: recordingRunner({ "claude --version": notInstalled() }).run,
      })
    );

    const document = await inspector.inspect(claudeRef());

    // A missing install is a finding, not an exception.
    expect(document.binary.executable).toBe(false);
    expect(document.binary.version.value).toBeNull();
    expect(document.binary.version.certainty).toBe("unspecified");
    expect(document.commands.subcommands).toEqual([]);
    expect(document.schemaVersion).toBe("1.0");
    expect(document.ref.installationId).toBe("inst-claude-01");
  });

  it("records an observed version with provenance", async () => {
    const inspector = new ClaudeInstallationInspector(claudeContext());

    const document = await inspector.inspect(claudeRef());

    expect(document.binary.version.value).toBe("2.1.226");
    expect(document.binary.version.certainty).toBe("observed");
    expect(document.binary.version.source).toBe("probe:claude--version");
    expect(document.binary.version.observedAt).toBe(FIXED_NOW);
  });

  it("reports mcp support as observed true when help advertises it", async () => {
    const inspector = new ClaudeInstallationInspector(claudeContext());

    const document = await inspector.inspect(claudeRef());

    expect(document.extensions.mcp.supported.value).toBe(true);
    expect(document.extensions.mcp.supported.certainty).toBe("observed");
  });

  it("reports an unadvertised subcommand as observed false, not unknown", async () => {
    // Absence from a readable help output is real evidence for that version.
    const helpWithoutPlugin = CLAUDE_HELP_FIXTURE.replace(/^  plugin.*\n/m, "");
    const inspector = new ClaudeInstallationInspector(
      claudeContext({
        runProbe: recordingRunner({
          "claude --version": ok(CLAUDE_VERSION_FIXTURE),
          "claude --help": ok(helpWithoutPlugin),
        }).run,
      })
    );

    const document = await inspector.inspect(claudeRef());

    expect(document.extensions.plugins.supported.value).toBe(false);
    expect(document.extensions.plugins.supported.certainty).toBe("observed");
  });

  it("leaves subcommand support unspecified when help was unreadable", async () => {
    const inspector = new ClaudeInstallationInspector(
      claudeContext({
        runProbe: recordingRunner({
          "claude --version": ok(CLAUDE_VERSION_FIXTURE),
          "claude --help": timedOut(),
        }).run,
      })
    );

    const document = await inspector.inspect(claudeRef());

    // No help means no evidence — distinct from evidence of absence.
    expect(document.extensions.mcp.supported.value).toBeNull();
    expect(document.extensions.mcp.supported.certainty).toBe("unspecified");
  });

  it("never reports a credential value, only its binding", async () => {
    const inspector = new ClaudeInstallationInspector(claudeContext());

    const document = await inspector.inspect(claudeRef());
    const binding = document.credentials[0]!;

    expect(binding.name).toBe("anthropic-api-key");
    expect(binding.acceptedEnvVars).toEqual(["ANTHROPIC_API_KEY"]);
    expect(binding.configured.value).toBeNull();
    expect(JSON.stringify(document)).not.toContain("sk-");
  });

  it("marks a config layer that exists and hashes its contents", async () => {
    const inspector = new ClaudeInstallationInspector(
      claudeContext({
        readConfigFile: async (path: string) =>
          path === `${MANAGED_HOME}/.claude/settings.json`
            ? '{"theme":"dark"}'
            : null,
      })
    );

    const document = await inspector.inspect(claudeRef());
    const userLayer = document.configLayers.find(
      (layer) => layer.id === "claude-user-settings"
    )!;
    const projectLayer = document.configLayers.find(
      (layer) => layer.id === "claude-project-settings"
    )!;

    expect(userLayer.exists).toBe(true);
    expect(userLayer.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(projectLayer.exists).toBe(false);
    expect(projectLayer.sha256).toBeUndefined();
  });

  it("reports writable false when writability was not probed", async () => {
    const inspector = new ClaudeInstallationInspector(
      claudeContext({ readConfigFile: async () => "{}" })
    );

    const document = await inspector.inspect(claudeRef());

    // Claiming writable without evidence invites a failed mutation later.
    expect(document.configLayers.every((layer) => !layer.writable)).toBe(true);
  });

  it("is deterministic across repeated inspections", async () => {
    const first = await new ClaudeInstallationInspector(
      claudeContext()
    ).inspect(claudeRef());
    const second = await new ClaudeInstallationInspector(
      claudeContext()
    ).inspect(claudeRef());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("CodexInstallationInspector", () => {
  function codexContext(): InspectorContext {
    return {
      runProbe: recordingRunner({
        "codex --version": ok(CODEX_VERSION_FIXTURE),
        "codex --help": ok(CODEX_HELP_FIXTURE),
      }).run,
      managedHome: MANAGED_HOME,
      now: fixedClock,
    };
  }

  it("probes the codex binary, not a hardcoded one", async () => {
    const runner = recordingRunner({
      "codex --version": ok(CODEX_VERSION_FIXTURE),
      "codex --help": ok(CODEX_HELP_FIXTURE),
    });
    const inspector = new CodexInstallationInspector({
      runProbe: runner.run,
      managedHome: MANAGED_HOME,
      now: fixedClock,
    });

    await inspector.inspect(codexRef());

    expect(runner.calls.every((call) => call.command === "codex")).toBe(true);
  });

  it("derives one-shot support from the exec subcommand", async () => {
    const inspector = new CodexInstallationInspector(codexContext());

    const document = await inspector.inspect(codexRef());

    expect(document.runtimeModes.oneShot.value).toBe(true);
    expect(document.runtimeModes.structuredOutput.value).toBe("jsonl");
  });

  it("leaves approvalDefault unspecified even when the flag exists", async () => {
    const inspector = new CodexInstallationInspector(codexContext());

    const document = await inspector.inspect(codexRef());

    // A flag proves configurability, never the default value.
    expect(document.security.approvalDefault.value).toBeNull();
    expect(document.security.approvalDefault.certainty).toBe("unspecified");
    expect(document.security.permissionRules.value).toBe(true);
  });

  it("declares toml config layers rather than json", async () => {
    const inspector = new CodexInstallationInspector(codexContext());

    const document = await inspector.inspect(codexRef());

    // Codex and Claude must not produce identical documents.
    expect(
      document.configLayers.every((layer) => layer.format === "toml")
    ).toBe(true);
    expect(document.configLayers.map((layer) => layer.id)).toEqual([
      "codex-user-config",
      "codex-project-config",
    ]);
  });

  it("leaves xdgOverrideHonored unspecified pending a snapshot probe", async () => {
    const inspector = new CodexInstallationInspector(codexContext());

    const document = await inspector.inspect(codexRef());

    // FR-4.7 requires verification; it is never assumed from documentation.
    expect(document.security.xdgOverrideHonored.value).toBeNull();
  });
});
