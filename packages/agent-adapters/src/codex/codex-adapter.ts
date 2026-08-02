/**
 * CodexAdapter — wraps the @openai/codex-sdk package and normalizes
 * its streaming events to the unified AgentEvent types.
 *
 * The SDK is an optional peer dependency, loaded lazily via dynamic import.
 *
 * Module split:
 *   - `codex-types.ts`           — SDK type declarations
 *   - `codex-helpers.ts`         — pure normalizers (event mapping, usage, ids)
 *   - `codex-streamed-thread.ts` — streaming loop + signal helpers
 *   - `codex-approval.ts`        — interaction/approval flow generators
 */

import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AdapterProviderId,
  AgentEvent,
  AgentStreamEvent,
  AgentInput,
  HealthStatus,
  ProviderRequestLookupInput,
  ProviderRequestLookupResult,
} from "../types.js";
import { getDefaultMonitorStatus } from "../provider-catalog.js";
import { InteractionResolver } from "../interaction/interaction-resolver.js";
import { BaseSdkAdapter } from "../base/base-sdk-adapter.js";
import { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { CodexPromptPayload } from "../prompts/system-prompt-builder.js";
import type {
  CodexClass,
  CodexCtorOptions,
  CodexInstance,
  CodexThreadOptions,
} from "./codex-types.js";
import { now, toCodexSandboxMode } from "./codex-helpers.js";
import {
  combineSignals,
  runStreamedThread,
  type RunStreamedThreadContext,
} from "./codex-streamed-thread.js";
import type { CodexApprovalContext } from "./codex-approval.js";
import {
  lookupCodexProviderRequest,
} from "./codex-provider-request-lookup.js";

export interface CodexAdapterConfig extends AdapterConfig {
  networkAccessEnabled?: boolean | undefined;
  approvalPolicy?: string | undefined;
}

export function applyDynamicWorkflowCodexDefaults(
  config: CodexAdapterConfig,
): CodexAdapterConfig {
  return {
    ...config,
    networkAccessEnabled: config.networkAccessEnabled ?? false,
    sandboxMode: config.sandboxMode ?? "workspace-write",
    approvalPolicy: config.approvalPolicy ?? "on-request",
  };
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter extends BaseSdkAdapter<{ Codex: CodexClass }> {
  readonly providerId: AdapterProviderId = "codex";

  private currentSessionId: string | null = null;
  private sdkModule: { Codex: CodexClass } | null = null;
  private currentInput: AgentInput | null = null;
  private currentIsResume = false;

  // ---- AgentCLIAdapter interface ------------------------------------------

  async *execute(
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeWithRaw(input)) {
      if (event.type !== "adapter:provider_raw") {
        yield event;
      }
    }
  }

  async *executeWithRaw(
    input: AgentInput,
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const sdk = await this.loadSdk();
    const codex = this.createInstance(sdk, input);
    const threadOpts = this.buildThreadOptions(input);

    const thread = codex.startThread(threadOpts);

    this.currentInput = input;
    this.currentIsResume = false;

    // Set up the runner's AbortController so interrupt() can abort the stream.
    // The runner signal is a combination of input.signal + runner's internal controller.
    this.abortController = new AbortController();
    const signal = combineSignals(input.signal, this.abortController.signal);

    try {
      yield* runStreamedThread(
        thread,
        input,
        codex,
        signal,
        this.buildStreamContext(),
      );
    } finally {
      this.abortController = null;
      this.currentInput = null;
      this.disposeResolver();
    }
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const sdk = await this.loadSdk();
    const codex = this.createInstance(sdk, input);
    const threadOpts = this.buildThreadOptions(input);

    const thread = codex.resumeThread(sessionId, threadOpts);

    this.currentInput = input;
    this.currentIsResume = true;
    this.currentSessionId = sessionId;
    const resumeSignal = input.signal ?? new AbortController().signal;
    for await (const event of runStreamedThread(
      thread,
      input,
      codex,
      resumeSignal,
      this.buildStreamContext(),
    )) {
      if (event.type !== "adapter:provider_raw") {
        yield event;
      }
    }
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.loadSdk();
      return {
        healthy: true,
        providerId: this.providerId,
        sdkInstalled: true,
        cliAvailable: true,
        lastSuccessTimestamp: now(),
        monitorStatus: getDefaultMonitorStatus(this.providerId),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        healthy: false,
        providerId: this.providerId,
        sdkInstalled: false,
        cliAvailable: false,
        lastError: message,
        monitorStatus: getDefaultMonitorStatus(this.providerId),
      };
    }
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
      nativeToolControls: {
        mode: true,
        allowlist: true,
        blocklist: true,
      },
      providerRequestCorrelation: {
        idempotencyKey: {
          accepted: false,
          enforcement: "none",
        },
        restartLookup: {
          supported: true,
          lookupBy: ["sessionId"],
        },
      },
    };
  }

  async lookupProviderRequest(
    lookup: ProviderRequestLookupInput,
  ): Promise<ProviderRequestLookupResult> {
    const providerOptions = this.config.providerOptions ?? {};
    return lookupCodexProviderRequest({
      cliPath:
        typeof providerOptions["codexPathOverride"] === "string"
          ? providerOptions["codexPathOverride"]
          : "codex",
      threadId: String(lookup.sessionId || ""),
      timeoutMs: this.config.timeoutMs,
      env: this.config.env,
    });
  }

  // ---- BaseSdkAdapter.loadSdk — concrete implementation -----------------

  /**
   * Dynamically import the Codex SDK. Caches the module after first load.
   * Delegates to {@link BaseSdkAdapter.loadOptionalSdkModule} for the
   * shared dynamic-import + ForgeError pattern.
   */
  override async loadSdk(): Promise<{ Codex: CodexClass }> {
    if (this.sdkModule) return this.sdkModule;
    this.sdkModule = await this.loadOptionalSdkModule<{ Codex: CodexClass }>(
      "@openai/codex-sdk",
      { providerId: "codex" },
    );
    return this.sdkModule;
  }

  // ---- Private helpers ----------------------------------------------------

  /** Create a Codex instance from the loaded SDK module */
  private createInstance(
    sdk: { Codex: CodexClass },
    input: AgentInput,
  ): CodexInstance {
    const ctorOpts: CodexCtorOptions = {};

    if (this.config.apiKey) {
      ctorOpts.apiKey = this.config.apiKey;
    }

    const providerOpts = this.config.providerOptions ?? {};
    if (typeof providerOpts["codexPathOverride"] === "string") {
      ctorOpts.codexPathOverride = providerOpts["codexPathOverride"];
    }

    if (this.config.env) {
      ctorOpts.env = this.config.env;
    }

    // systemPrompt is passed via the CLI's `instructions` config key.
    // Per-request systemPrompt (from AgentInput) takes priority over
    // the static default in providerOptions.systemPrompt.
    // We merge with any caller-supplied providerOptions.config overrides.
    const staticSystemPrompt =
      typeof providerOpts["systemPrompt"] === "string"
        ? providerOpts["systemPrompt"]
        : undefined;
    const effectiveSystemPrompt = input.systemPrompt ?? staticSystemPrompt;
    const callerConfig =
      (providerOpts["config"] as Record<string, unknown> | undefined) ?? {};
    // developerInstructions sets meta-level agent behavior (separate from user-facing instructions).
    const developerInstructions =
      typeof providerOpts["developerInstructions"] === "string"
        ? providerOpts["developerInstructions"]
        : undefined;

    const configOverrides: Record<string, unknown> = { ...callerConfig };
    const activePolicy = input.policyContext?.activePolicy;
    if (activePolicy?.toolPolicy === "strict") {
      // @openai/codex-sdk does not expose per-thread tool allow/block lists.
      // Keep strict turns on the built-in local transport by removing user-configured
      // MCP/app surfaces. The sandbox, network toggle, and downstream event verifier
      // remain the enforcement boundary for the declared policy.
      configOverrides["mcp_servers"] = {};
      configOverrides["web_search"] = "disabled";
      configOverrides["features"] = {
        ...((configOverrides["features"] as Record<string, unknown> | undefined) ?? {}),
        apps: false,
        browser_use: false,
        browser_use_external: false,
        browser_use_full_cdp_access: false,
        code_mode: false,
        code_mode_host: false,
        code_mode_only: false,
        computer_use: false,
        enable_mcp_apps: false,
        image_generation: false,
        multi_agent: false,
        plugin_sharing: false,
        plugins: false,
        remote_plugin: false,
        skill_mcp_dependency_install: false,
      };
    }
    if (effectiveSystemPrompt) {
      const builder = new SystemPromptBuilder(effectiveSystemPrompt, {
        codexDeveloperInstructions: developerInstructions,
      });
      const payload = builder.buildFor("codex") as CodexPromptPayload;
      configOverrides["instructions"] = payload.instructions;
      if (payload.developer_instructions) {
        configOverrides["developer_instructions"] =
          payload.developer_instructions;
      }
    } else if (developerInstructions) {
      // No system prompt but developerInstructions is set — pass it through directly
      configOverrides["developer_instructions"] = developerInstructions;
    }
    if (Object.keys(configOverrides).length > 0) {
      ctorOpts.config = configOverrides;
    }

    return new sdk.Codex(ctorOpts);
  }

  /** Build thread options from AgentInput + stored config */
  private buildThreadOptions(input: AgentInput): CodexThreadOptions {
    const opts: CodexThreadOptions = {
      sandboxMode: toCodexSandboxMode(this.config.sandboxMode),
      approvalPolicy: this.resolveCodexApprovalPolicy(input),
      networkAccessEnabled:
        (this.config as CodexAdapterConfig).networkAccessEnabled ?? true,
    };

    const configuredModel =
      typeof input.options?.["model"] === "string" && input.options["model"].trim()
        ? input.options["model"].trim()
        : this.config.model;
    if (configuredModel) {
      opts.model = configuredModel;
    }

    const workDir = input.workingDirectory ?? this.config.workingDirectory;
    if (workDir) {
      opts.workingDirectory = workDir;
    }

    // Merge adapter-specific thread options from input.options
    const inputOpts = input.options ?? {};
    if (typeof inputOpts["sandboxMode"] === "string") {
      opts.sandboxMode = inputOpts["sandboxMode"];
    }
    // Direct approvalPolicy override still respected (already applied above, but per-call wins)
    if (typeof inputOpts["approvalPolicy"] === "string") {
      opts.approvalPolicy = inputOpts["approvalPolicy"];
    }
    if (typeof inputOpts["networkAccessEnabled"] === "boolean") {
      opts.networkAccessEnabled = inputOpts["networkAccessEnabled"];
    }
    if (typeof inputOpts["skipGitRepoCheck"] === "boolean") {
      opts.skipGitRepoCheck = inputOpts["skipGitRepoCheck"];
    } else if (typeof this.config.skipGitRepoCheck === "boolean") {
      opts.skipGitRepoCheck = this.config.skipGitRepoCheck;
    }

    // Normalized reasoning effort → Codex modelReasoningEffort field.
    // Defaults to "medium" when neither the per-call input nor the adapter
    // config specifies one, matching the agent-planning run-layer default.
    const reasoning =
      (inputOpts["reasoning"] as string | undefined) ??
      this.config.reasoning ??
      "medium";
    if (reasoning) {
      opts.modelReasoningEffort = reasoning;
    }

    return opts;
  }

  /**
   * Map the InteractionPolicy to the Codex SDK approvalPolicy string.
   * 'auto-approve' → 'never' (Codex auto-proceeds, never pauses).
   * All other modes → 'on-failure' so Codex pauses on permission boundaries,
   * allowing the InteractionResolver to intercept via turn.failed detection.
   */
  private resolveCodexApprovalPolicy(input: AgentInput): string {
    // Explicit per-call override takes priority (checked again in buildThreadOptions)
    if (typeof input.options?.["approvalPolicy"] === "string") {
      return input.options["approvalPolicy"];
    }
    const configApprovalPolicy = (this.config as CodexAdapterConfig)
      .approvalPolicy;
    if (typeof configApprovalPolicy === "string") {
      return configApprovalPolicy;
    }
    const policy = this.resolveInteractionPolicy(input);
    return policy.mode === "auto-approve" ? "never" : "on-failure";
  }

  /** Get or create the InteractionResolver for the current execution. */
  private getOrCreateResolver(input: AgentInput): InteractionResolver {
    if (!this.resolver) {
      this.resolver = new InteractionResolver(
        this.resolveInteractionPolicy(input),
      );
    }
    return this.resolver;
  }

  /** Build the per-call context handed to the streaming loop. */
  private buildStreamContext(): RunStreamedThreadContext {
    const adapter = this;
    return {
      providerId: adapter.providerId,
      get config(): AdapterConfig {
        return adapter.config;
      },
      get currentInput(): AgentInput | undefined {
        return adapter.currentInput ?? undefined;
      },
      get isResume(): boolean {
        return adapter.currentIsResume;
      },
      getSessionId: () => adapter.currentSessionId,
      setSessionId: (sid) => {
        adapter.currentSessionId = sid;
      },
      abort: () => {
        adapter.abortController?.abort();
      },
      buildApprovalContext: (input) => adapter.buildApprovalContext(input),
      isApprovalCapable: (input) =>
        adapter.resolveInteractionPolicy(input).mode !== "auto-approve",
      buildThreadOptions: (input) => adapter.buildThreadOptions(input),
    };
  }

  /** Build the per-call context handed to the approval helpers. */
  private buildApprovalContext(input: AgentInput): CodexApprovalContext {
    return {
      providerId: this.providerId,
      policy: this.resolveInteractionPolicy(input),
      resolver: this.getOrCreateResolver(input),
      buildThreadOptions: (i) => this.buildThreadOptions(i),
    };
  }
}

/**
 * Factory function for {@link CodexAdapter}.
 *
 * Provides a stable functional entry point for callers that prefer not to
 * instantiate the class directly (for example, the CJS-to-ESM
 * `scripts/lib/agent-bridge/run.mjs` resolves adapters by `create<Provider>Adapter`
 * before falling back to class exports).
 */
export function createCodexAdapter(config: AdapterConfig = {}): CodexAdapter {
  return new CodexAdapter(config);
}
