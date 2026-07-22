import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  HealthStatus,
  SessionInfo,
} from "../types.js";
import { getDefaultMonitorStatus } from "../provider-catalog.js";
import { normalizeCodex } from "../normalize-codex.js";
import {
  createCliHomeProjection,
  runJsonlProcess,
} from "../cli-runtime/index.js";
import type {
  CliRuntimeDependencies,
  CliRuntimeLimits,
} from "../cli-runtime/index.js";
import type { PreparedCodexCliRun } from "./codex-cli-adapter/types.js";
import {
  combineSignals,
  isSensitiveEnvKey,
  policyRejected,
  stringOption,
  unsupported,
} from "./codex-cli-adapter/policy.js";
import { createPersistentCodexHome } from "./codex-cli-adapter/persistent-home.js";
import {
  buildBaseProfileInputs,
  readApprovedBaseConfig,
} from "./codex-cli-adapter/base-profile.js";
import {
  projectCodexMcp,
  readMcpDescriptors,
  validateCodexMcpDescriptors,
} from "./codex-cli-adapter/mcp-projection.js";
import {
  toFailedEvent,
  withCorrelation,
  wrapRawEvent,
} from "./codex-cli-adapter/events.js";

const execFileAsync = promisify(execFile);

export interface CodexCliAdapterConfig extends AdapterConfig {
  /** Defaults to `codex`; injectable for managed installations and tests. */
  cliPath?: string | undefined;
  /** Optional approved base Codex profile directory copied into the private CODEX_HOME. */
  cliBaseProfileRoot?: string | undefined;
  /** Relative regular files copied from cliBaseProfileRoot. */
  cliBaseProfileFiles?: readonly string[] | undefined;
  /** Keep Codex thread state inside the worker-owned working directory for crash recovery. */
  persistentSessionHome?: boolean | undefined;
  /** Strict JSONL is the canonical Codex CLI backend default. */
  malformedLinePolicy?: "skip" | "error" | undefined;
  /** Test/runtime injection point; not forwarded to the subprocess. */
  runtimeDependencies?: CliRuntimeDependencies | undefined;
  /** Optional bounded-output overrides for deterministic harness tests. */
  runtimeLimits?: Partial<CliRuntimeLimits> | undefined;
}

export class CodexCliAdapter implements AgentCLIAdapter {
  readonly providerId = "codex" as const;
  private config: CodexCliAdapterConfig;
  private readonly runtimeDependencies: CliRuntimeDependencies;
  private readonly abortControllers = new Set<AbortController>();

  constructor(config: CodexCliAdapterConfig = {}) {
    this.runtimeDependencies = config.runtimeDependencies ?? {};
    this.config = { ...config, runtimeDependencies: undefined };
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts };
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      // CLI/SDK adapter: runs its own in-subprocess/agentic tool loop.
      emitsToolCalls: true,
      executesToolLoop: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: { mode: true, allowlist: false, blocklist: true },
    };
  }

  async *execute(
    input: AgentInput
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeWithRaw(input)) {
      if (event.type !== "adapter:provider_raw") yield event;
    }
  }

  async *executeWithRaw(
    input: AgentInput
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const sessionId = randomUUID();
    const startedAt = Date.now();
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const signal = combineSignals(input.signal, controller.signal);

    const model = this.resolveModel(input);
    yield withCorrelation(
      {
        type: "adapter:started",
        providerId: "codex",
        sessionId,
        timestamp: Date.now(),
        prompt: input.prompt,
        ...(input.systemPrompt !== undefined
          ? { systemPrompt: input.systemPrompt }
          : {}),
        ...(model ? { model } : {}),
        workingDirectory:
          input.workingDirectory ?? this.config.workingDirectory,
        ...({
          backend: "cli",
          telemetry: { codex_backend_selected: "cli" },
        } as Record<string, unknown>),
      } as AgentEvent,
      input
    );

    try {
      const prepared = await this.prepareCliRun(input);
      let ordinal = 0;
      let completed = false;
      let failed = false;
      let lastAssistantResult = "";
      for await (const record of runJsonlProcess(
        {
          command: this.config.cliPath ?? "codex",
          args: prepared.args,
          cwd: prepared.cwd,
          env: prepared.env,
          homeProjection: prepared.homeProjection,
          signal,
          timeoutMs: this.config.timeoutMs,
          limits: this.config.runtimeLimits,
          malformedLinePolicy: this.config.malformedLinePolicy ?? "error",
        },
        this.runtimeDependencies
      )) {
        ordinal += 1;
        const raw = wrapRawEvent(record, sessionId, input, ordinal);
        yield raw;
        const mapped = this.mapProviderEvent(record, sessionId, input);
        if (!mapped) continue;
        const mappedEvents = Array.isArray(mapped) ? mapped : [mapped];
        for (const candidate of mappedEvents) {
          if (
            candidate.type === "adapter:message" &&
            candidate.role === "assistant"
          ) {
            lastAssistantResult = candidate.content;
          }
          const event =
            candidate.type === "adapter:completed" &&
            !candidate.result &&
            lastAssistantResult
              ? { ...candidate, result: lastAssistantResult }
              : candidate;
          if (event.type === "adapter:completed") completed = true;
          if (event.type === "adapter:failed") failed = true;
          yield withCorrelation(event, input);
        }
      }
      if (!completed && !failed) {
        yield withCorrelation(
          {
            type: "adapter:completed",
            providerId: "codex",
            sessionId,
            result: "",
            durationMs: Date.now() - startedAt,
            timestamp: Date.now(),
          },
          input
        );
      }
    } catch (error) {
      const failed = toFailedEvent(error, sessionId, input);
      yield failed;
      throw error;
    } finally {
      this.abortControllers.delete(controller);
    }
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.execute({
      ...input,
      resumeSessionId: sessionId,
    }))
      yield event;
  }

  interrupt(): void {
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await execFileAsync(this.config.cliPath ?? "codex", ["--version"], {
        timeout: 5_000,
      });
      return {
        healthy: true,
        providerId: "codex",
        sdkInstalled: false,
        cliAvailable: true,
        lastSuccessTimestamp: Date.now(),
        monitorStatus: getDefaultMonitorStatus("codex"),
      };
    } catch {
      return {
        healthy: false,
        providerId: "codex",
        sdkInstalled: false,
        cliAvailable: false,
        lastError: "Codex CLI binary not found or not executable",
        monitorStatus: getDefaultMonitorStatus("codex"),
      };
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }
  async forkSession(): Promise<string> {
    throw unsupported(
      "Codex CLI session forking is not exposed by this backend"
    );
  }

  buildArgs(input: AgentInput, outputSchemaPath?: string): string[] {
    this.validateSupportedPolicy(input);
    const args = [
      "--ask-for-approval",
      this.resolveApprovalPolicy(input),
      "--sandbox",
      this.resolveSandbox(input),
    ];
    if (readMcpDescriptors(input).length > 0) {
      // An explicit runtime MCP projection is the complete external-tool
      // authority for this process. Disable ambient app/plugin tool planes so
      // a same-named subscription connector cannot bypass the projection.
      args.push(
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "enable_mcp_apps"
      );
    }
    const model = this.resolveModel(input);
    if (model) args.push("--model", model);
    const reasoning = this.resolveReasoning(input);
    if (reasoning)
      args.push("--config", `model_reasoning_effort="${reasoning}"`);
    args.push("exec");
    if (input.resumeSessionId) args.push("resume");
    args.push("--json");
    if (outputSchemaPath) args.push("--output-schema", outputSchemaPath);
    args.push("--");
    if (input.resumeSessionId) args.push(input.resumeSessionId);
    args.push(input.prompt);
    return args;
  }

  async prepareCliRun(input: AgentInput): Promise<PreparedCodexCliRun> {
    this.validateSupportedPolicy(input);
    const cwd = input.workingDirectory ?? this.config.workingDirectory;
    if (this.resolveSandbox(input) === "workspace-write" && !cwd) {
      throw policyRejected(
        "Codex CLI workspace-write requires an explicit working directory",
        "missing_working_directory"
      );
    }
    const outputSchema =
      input.outputSchema === undefined
        ? undefined
        : JSON.stringify(input.outputSchema);
    const mcpProjection = projectCodexMcp(input);
    const baseConfig = mcpProjection
      ? await readApprovedBaseConfig(
          this.config.cliBaseProfileRoot,
          this.config.cliBaseProfileFiles
        )
      : "";
    const baseProfileInputs = await buildBaseProfileInputs(
      this.config.cliBaseProfileRoot,
      this.config.cliBaseProfileFiles,
      mcpProjection ? new Set(["config.toml"]) : new Set()
    );
    const generatedFiles = {
      ...(outputSchema === undefined
        ? {}
        : {
            outputSchema: {
              path: "output-schema.json",
              content: `${outputSchema}\n`,
            },
          }),
      ...(mcpProjection
        ? {
            mcpConfig: {
              path: "config.toml",
              content: `${baseConfig.trim()}${baseConfig.trim() ? "\n\n" : ""}${
                mcpProjection.config
              }`,
            },
          }
        : {}),
    };
    const homeProjection = this.config.persistentSessionHome
      ? await createPersistentCodexHome(cwd, baseProfileInputs, generatedFiles)
      : await createCliHomeProjection({
          prefix: "dzupagent-codex-",
          envVar: "CODEX_HOME",
          requiredDirectories: ["sessions", "mcp"],
          approvedBaseProfileRoots: this.config.cliBaseProfileRoot
            ? [this.config.cliBaseProfileRoot]
            : [],
          baseProfileInputs,
          generatedFiles:
            Object.keys(generatedFiles).length > 0 ? generatedFiles : undefined,
        });
    try {
      return {
        args: this.buildArgs(
          input,
          homeProjection.generatedPaths["outputSchema"]
        ),
        cwd,
        env: { ...this.buildSpawnEnv(), ...(mcpProjection?.env ?? {}) },
        homeProjection,
      };
    } catch (error) {
      await homeProjection.cleanup().catch(() => undefined);
      throw error;
    }
  }

  mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
    input: AgentInput
  ): AgentEvent | AgentEvent[] | null {
    const normalized = normalizeCodex(record, sessionId);
    if (normalized?.type === "adapter:failed") {
      const text = `${normalized.error} ${normalized.code ?? ""}`.toLowerCase();
      if (text.includes("auth") || text.includes("login")) {
        return {
          ...normalized,
          code: "ADAPTER_AUTH_FAILED",
          ...({ telemetry: { codex_cli_auth_failure: true } } as Record<
            string,
            unknown
          >),
        };
      }
    }
    return normalized ? withCorrelation(normalized, input) : null;
  }

  private validateSupportedPolicy(input: AgentInput): void {
    const sandbox = this.resolveSandbox(input);
    if (sandbox !== "read-only" && sandbox !== "workspace-write") {
      throw policyRejected(
        `Codex CLI backend does not support sandbox mode: ${sandbox}`,
        "unsupported_sandbox"
      );
    }
    const approval = this.resolveApprovalPolicy(input);
    if (!["never", "on-request", "untrusted"].includes(approval)) {
      throw policyRejected(
        `Codex CLI backend does not support approval policy: ${approval}`,
        "unsupported_approval"
      );
    }
    if (
      input.maxTurns !== undefined ||
      input.policyContext?.activePolicy?.maxTurns !== undefined
    ) {
      throw policyRejected(
        "Codex CLI backend does not expose a deterministic max-turns flag",
        "unsupported_max_turns"
      );
    }
    const activePolicy = input.policyContext?.activePolicy;
    if (activePolicy?.allowedTools?.length) {
      throw policyRejected(
        "Codex CLI backend does not strictly enforce tool allowlists",
        "unsupported_tool_allowlist"
      );
    }
    validateCodexMcpDescriptors(input);
  }

  private resolveModel(input: AgentInput): string | undefined {
    return stringOption(input.options?.["model"]) ?? this.config.model;
  }

  private resolveReasoning(
    input: AgentInput
  ): "low" | "medium" | "high" | undefined {
    const value =
      stringOption(input.options?.["reasoning"]) ?? this.config.reasoning;
    return value === "low" || value === "medium" || value === "high"
      ? value
      : undefined;
  }

  private resolveSandbox(input: AgentInput): string {
    return (
      input.policyContext?.activePolicy?.sandboxMode ??
      stringOption(input.options?.["sandboxMode"]) ??
      this.config.sandboxMode ??
      "read-only"
    );
  }

  private resolveApprovalPolicy(input: AgentInput): string {
    const explicit = stringOption(input.options?.["approvalPolicy"]);
    if (explicit) return explicit;
    const configPolicy = stringOption(
      (this.config as AdapterConfig & { approvalPolicy?: unknown })
        .approvalPolicy
    );
    if (configPolicy) return configPolicy;
    const required = input.policyContext?.activePolicy?.approvalRequired;
    return required === false ? "never" : "on-request";
  }

  private buildSpawnEnv(): Readonly<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !isSensitiveEnvKey(key)) env[key] = value;
    }
    for (const [key, value] of Object.entries(this.config.env ?? {})) {
      if (!isSensitiveEnvKey(key)) env[key] = value;
    }
    return env;
  }
}

export function createCodexCliAdapter(
  config: CodexCliAdapterConfig = {}
): CodexCliAdapter {
  return new CodexCliAdapter(config);
}
