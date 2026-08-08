/**
 * Base installation inspector (spec doc 05 §4, FR-1.2).
 *
 * An inspector answers "what is actually installed on this host, and what can
 * it do" and returns an {@link InstallationCapabilityDocument}. It emits
 * nothing and mutates nothing — inspection is strictly read-only, and
 * lifecycle authority lives elsewhere (doc 07).
 *
 * The two invariants subclasses inherit and must not weaken:
 *
 * 1. **Never guess.** Anything a probe did not evidence is recorded as
 *    `{ value: null, certainty: 'unspecified' }`. A missing binary yields a
 *    well-formed `presence:false` document, not an exception.
 * 2. **Never invoke an unobserved subcommand.** The `--help` walk only
 *    descends into subcommands the root help actually advertised.
 */
import { createHash } from "node:crypto";
import type {
  AdapterInstallationRef,
  BinaryOwnership,
  CommandSpec,
  ConfigLayer,
  CredentialBinding,
  InstallationCapabilityDocument,
  ProbedCommandTree,
  ProbedCrud,
  SourcedValue,
} from "@dzupagent/adapter-types";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  parseHelpFlags,
  parseHelpSubcommands,
  parseVersion,
  type ProbeCommandRunner,
  type ProbeResult,
} from "./probe-runner.js";

/** Version of the inspector framework, recorded on every document. */
export const PROBE_TOOL_VERSION = "1.0.0";

/** A fact that no probe evidenced. */
export function unspecified<T>(): SourcedValue<T> {
  return { value: null, certainty: "unspecified" };
}

/** A fact a probe directly observed. */
export function observed<T>(
  value: T,
  source: string,
  observedAt: string
): SourcedValue<T> {
  return { value, certainty: "observed", source, observedAt };
}

/** A {@link ProbedCrud} in which no verb was observed. */
export function unspecifiedCrud(): ProbedCrud {
  return {
    list: unspecified<CommandSpec>(),
    install: unspecified<CommandSpec>(),
    update: unspecified<CommandSpec>(),
    remove: unspecified<CommandSpec>(),
    authenticate: unspecified<CommandSpec>(),
  };
}

export interface InspectorContext {
  /** Executes probe commands; injectable so tests stay process-free. */
  runProbe: ProbeCommandRunner;
  /** Managed HOME the probes are pointed at. */
  managedHome: string;
  /**
   * Clock, injected so documents are reproducible in tests.
   * Returns an ISO-8601 timestamp.
   */
  now: () => string;
  /** Reads a config file's bytes, or returns null when absent/unreadable. */
  readConfigFile?: (path: string) => Promise<string | null>;
  /** Per-probe timeout override. */
  timeoutMs?: number;
}

/** A config path an inspector knows to look for. */
export interface ConfigLayerCandidate {
  id: string;
  scope: ConfigLayer["scope"];
  path: string;
  format: ConfigLayer["format"];
  precedence: number;
  legacy?: boolean;
}

/**
 * Read-only inspector for one provider's installations.
 *
 * Subclasses declare *what* to look for (binary name, config paths, extension
 * locations); this base owns *how* to look, so probe discipline cannot drift
 * per provider.
 */
export abstract class AdapterInstallationInspector {
  constructor(protected readonly context: InspectorContext) {}

  /** Binary this inspector probes, e.g. `claude`. */
  protected abstract readonly binaryName: string;

  /** Config paths to test, relative to the managed home unless absolute. */
  protected abstract configCandidates(): ConfigLayerCandidate[];

  /**
   * Provider-specific enrichment applied after the generic probe.
   *
   * The base fills everything it can evidence generically; subclasses refine
   * fields their CLI reports in a provider-specific way. The default is a
   * no-op, so a subclass that adds nothing is still correct.
   */
  protected async enrich(
    document: InstallationCapabilityDocument
  ): Promise<InstallationCapabilityDocument> {
    return document;
  }

  /**
   * Probe an installation and build its capability document.
   *
   * Never throws for an absent or broken installation: that is a finding, and
   * a `presence:false` document is the correct representation of it.
   */
  async inspect(
    ref: AdapterInstallationRef
  ): Promise<InstallationCapabilityDocument> {
    const probedAt = this.context.now();
    const timeoutMs = this.context.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    const versionResult = await this.context.runProbe({
      command: this.binaryName,
      args: ["--version"],
      timeoutMs,
    });

    // FR-1.2 AC: a missing binary yields a valid presence:false document.
    if (versionResult.spawnFailed) {
      return this.absentDocument(ref, probedAt);
    }

    const helpResult = await this.context.runProbe({
      command: this.binaryName,
      args: ["--help"],
      timeoutMs,
    });

    const commands = this.buildCommandTree(helpResult);
    const configLayers = await this.probeConfigLayers();
    const version = parseVersion(versionResult.stdout || versionResult.stderr);

    const document: InstallationCapabilityDocument = {
      schemaVersion: "1.0",
      ref,
      probedAt,
      probeToolVersion: PROBE_TOOL_VERSION,
      binary: {
        path: unspecified<string>(),
        version:
          version === null
            ? unspecified<string>()
            : observed(version, `probe:${this.binaryName}--version`, probedAt),
        versionRaw: versionResult.stdout.trim() || undefined,
        // Ownership needs filesystem/package-manager inspection the generic
        // probe does not perform; unknown until a subclass evidences it.
        ownership: unspecified<BinaryOwnership>(),
        executable: true,
      },
      commands,
      configLayers,
      credentials: this.credentialCandidates(),
      extensions: {
        plugins: {
          supported: this.supportsSubcommand(commands, "plugin", probedAt),
          locations: [],
          crud: unspecifiedCrud(),
        },
        skills: {
          supported: unspecified<boolean>(),
          standard: "none",
          locations: [],
        },
        mcp: {
          supported: this.supportsSubcommand(commands, "mcp", probedAt),
          transports: [],
          crud: unspecifiedCrud(),
        },
        hooks: { supported: unspecified<boolean>(), locations: [] },
      },
      runtimeModes: {
        oneShot: unspecified<boolean>(),
        structuredOutput: unspecified<
          "json" | "jsonl" | "text" | "unspecified"
        >(),
        acp: unspecified<boolean>(),
        httpServer: unspecified<boolean>(),
        daemon: unspecified<boolean>(),
      },
      security: {
        approvalDefault: unspecified<
          "ask" | "allow" | "always-approve" | "mixed"
        >(),
        permissionRules: unspecified<boolean>(),
        // Requires a snapshot probe (FR-4.7); never assumed from docs.
        xdgOverrideHonored: unspecified<boolean>(),
      },
      telemetry: {
        documented: null,
        enabledByDefault: null,
        optOutAvailable: null,
        optOutMechanisms: [],
        usageSource: "unspecified",
      },
      rawProbes: {
        helpSha256: sha256(helpResult.stdout),
        capturePath: `probes/${this.binaryName}/${version ?? "unknown"}/help`,
      },
    };

    return this.enrich(document);
  }

  /**
   * Document for an installation whose binary could not be executed.
   *
   * Everything is `unspecified` and `executable` is false — the honest
   * rendering of "we looked and found nothing".
   */
  protected absentDocument(
    ref: AdapterInstallationRef,
    probedAt: string
  ): InstallationCapabilityDocument {
    return {
      schemaVersion: "1.0",
      ref,
      probedAt,
      probeToolVersion: PROBE_TOOL_VERSION,
      binary: {
        path: unspecified<string>(),
        version: unspecified<string>(),
        ownership: unspecified<BinaryOwnership>(),
        executable: false,
      },
      commands: { root: { path: [this.binaryName] }, subcommands: [] },
      configLayers: [],
      credentials: [],
      extensions: {
        plugins: {
          supported: unspecified<boolean>(),
          locations: [],
          crud: unspecifiedCrud(),
        },
        skills: {
          supported: unspecified<boolean>(),
          standard: "none",
          locations: [],
        },
        mcp: {
          supported: unspecified<boolean>(),
          transports: [],
          crud: unspecifiedCrud(),
        },
        hooks: { supported: unspecified<boolean>(), locations: [] },
      },
      runtimeModes: {
        oneShot: unspecified<boolean>(),
        structuredOutput: unspecified<
          "json" | "jsonl" | "text" | "unspecified"
        >(),
        acp: unspecified<boolean>(),
        httpServer: unspecified<boolean>(),
        daemon: unspecified<boolean>(),
      },
      security: {
        approvalDefault: unspecified<
          "ask" | "allow" | "always-approve" | "mixed"
        >(),
        permissionRules: unspecified<boolean>(),
        xdgOverrideHonored: unspecified<boolean>(),
      },
      telemetry: {
        documented: null,
        enabledByDefault: null,
        optOutAvailable: null,
        optOutMechanisms: [],
        usageSource: "unspecified",
      },
      rawProbes: { helpSha256: sha256(""), capturePath: "" },
    };
  }

  /** Build the command tree from root help. Only advertised nodes appear. */
  protected buildCommandTree(helpResult: ProbeResult): ProbedCommandTree {
    const helpText = helpResult.stdout;
    const root: CommandSpec = {
      path: [this.binaryName],
      flags: parseHelpFlags(helpText),
    };

    const subcommands: CommandSpec[] = parseHelpSubcommands(helpText).map(
      (name) => ({ path: [this.binaryName, name] })
    );

    return { root, subcommands };
  }

  /**
   * Whether a named subcommand was advertised.
   *
   * Absence of a subcommand in help is genuine evidence of absence for that
   * version, so this reports an observed `false` rather than `unspecified` —
   * but only when help was actually readable.
   */
  protected supportsSubcommand(
    commands: ProbedCommandTree,
    name: string,
    probedAt: string
  ): SourcedValue<boolean> {
    const advertised = commands.subcommands.some(
      (command) => command.path[command.path.length - 1] === name
    );
    const helpWasReadable =
      commands.subcommands.length > 0 || (commands.root.flags?.length ?? 0) > 0;

    if (!helpWasReadable) return unspecified<boolean>();

    return observed(advertised, `probe:${this.binaryName}--help`, probedAt);
  }

  /** Test each declared config candidate for existence. */
  protected async probeConfigLayers(): Promise<ConfigLayer[]> {
    const readFile = this.context.readConfigFile;
    const layers: ConfigLayer[] = [];

    for (const candidate of this.configCandidates()) {
      const contents = readFile ? await readFile(candidate.path) : null;
      const exists = contents !== null;

      layers.push({
        id: candidate.id,
        scope: candidate.scope,
        path: candidate.path,
        format: candidate.format,
        precedence: candidate.precedence,
        exists,
        // Writability needs a real stat; absent that, the conservative answer
        // is false — claiming writable when unknown invites a failed mutation.
        writable: false,
        sha256: exists ? sha256(contents) : undefined,
        legacy: candidate.legacy,
      });
    }

    return layers;
  }

  /**
   * Credential bindings this provider accepts.
   *
   * Presence only — values are never read, logged, or hashed. The default is
   * an empty list; subclasses declare their provider's bindings.
   */
  protected credentialCandidates(): CredentialBinding[] {
    return [];
  }
}

function sha256(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
