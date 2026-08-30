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
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AdapterProviderId,
  AgentEvent,
  AgentStreamEvent,
  AgentInput,
  HealthStatus,
  ProviderRequestLookupInput,
  ProviderRequestLookupResult,
} from "../types.js";
import {
  assertAdapterExecutionControlsAdmitted,
  buildExecutionControlAdmission,
} from "../execution-control-admission.js";
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
import { lookupCodexProviderRequest } from "./codex-provider-request-lookup.js";
import {
  createCodexRunContext,
  disposeCodexRunContext,
  type CodexRunContext,
} from "./codex-run-context.js";

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

  /**
   * Narrowed view of the inherited config.
   *
   * `BaseSdkAdapter` declares `config` as `AdapterConfig`, which does not carry
   * `networkAccessEnabled` or `approvalPolicy`. This adapter reads both, and used
   * to reach them with `(config as CodexAdapterConfig)` casts -- a cast that no
   * caller could ever make true, because the inherited constructor only accepted
   * `AdapterConfig` and rejects both fields as excess properties.
   *
   * `declare` because the base constructor already assigns the value; this only
   * refines its type. Goose, Qwen and Ollama solve the same problem by keeping a
   * second `private xConfig` copy, but that leaves two states to keep in sync in
   * `configure()`; narrowing the one field cannot drift.
   */
  protected declare config: CodexAdapterConfig;

  private sdkModule: { Codex: CodexClass } | null = null;

  constructor(config: CodexAdapterConfig = {}) {
    super(config);
  }

  /** Widened from the base signature so Codex-specific keys are settable. */
  override configure(opts: Partial<CodexAdapterConfig>): void {
    super.configure(opts);
  }

  /**
   * All in-flight runs. Each `execute()`/`resumeSession()` call owns exactly
   * one {@link CodexRunContext}; no per-run state lives on the adapter
   * instance itself, so concurrent runs cannot share session identity,
   * input/resume state, or abort controllers.
   */
  private readonly activeRuns = new Set<CodexRunContext>();

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
    assertAdapterExecutionControlsAdmitted(this, input);
    const sdk = await this.loadSdk();
    const run = createCodexRunContext({
      input,
      isResume: false,
      config: this.config,
    });
    const codex = this.createInstance(sdk, input, run.config);
    const threadOpts = this.buildThreadOptions(input, run.config);

    const thread = codex.startThread(threadOpts);

    // The effective stream signal combines the caller-provided AbortSignal
    // (the authoritative per-turn cancellation) with this run's OWN internal
    // controller (timeout + adapter-wide emergency interrupt). Neither is
    // shared with any concurrent run.
    this.activeRuns.add(run);
    const signal = combineSignals(input.signal, run.abortController.signal);

    try {
      yield* runStreamedThread(
        thread,
        input,
        codex,
        signal,
        this.buildStreamContext(run),
      );
    } finally {
      this.activeRuns.delete(run);
      disposeCodexRunContext(run);
    }
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    assertAdapterExecutionControlsAdmitted(this, input);
    const sdk = await this.loadSdk();
    const run = createCodexRunContext({
      input,
      isResume: true,
      config: this.config,
      sessionId,
    });
    const codex = this.createInstance(sdk, input, run.config);
    const threadOpts = this.buildThreadOptions(input, run.config);

    const thread = codex.resumeThread(sessionId, threadOpts);

    this.activeRuns.add(run);
    const resumeSignal = combineSignals(
      input.signal,
      run.abortController.signal,
    );
    try {
      for await (const event of runStreamedThread(
        thread,
        input,
        codex,
        resumeSignal,
        this.buildStreamContext(run),
      )) {
        if (event.type !== "adapter:provider_raw") {
          yield event;
        }
      }
    } finally {
      this.activeRuns.delete(run);
      disposeCodexRunContext(run);
    }
  }

  /**
   * Adapter-wide EMERGENCY stop: aborts EVERY active run on this adapter.
   *
   * Per-turn cancellation is the caller-provided `AgentInput.signal` — abort
   * that to cancel one run without affecting its siblings. Codev session code
   * must never call `interrupt()`.
   */
  interrupt(): void {
    for (const run of this.activeRuns) {
      run.abortController.abort();
    }
  }

  /**
   * Route an interaction answer to whichever active run owns the pending
   * interaction. Run-scoped so concurrent approval flows cannot cross-talk.
   */
  override respondInteraction(interactionId: string, answer: string): boolean {
    for (const run of this.activeRuns) {
      if (run.resolver?.respond(interactionId, answer)) {
        return true;
      }
    }
    return false;
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
      supportsZeroToolDispatch: false,
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

  admitExecutionControls(
    _input: AgentInput,
    requirement: AdapterExecutionControlRequirement,
  ): AdapterExecutionControlAdmission {
    return buildExecutionControlAdmission({
      providerId: "codex",
      requirement,
      status: "rejected",
      enforcement: "unsupported",
      blockers: ["zero_tool_dispatch_unsupported"],
    });
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
    config: CodexAdapterConfig = this.config,
  ): CodexInstance {
    const ctorOpts: CodexCtorOptions = {};

    if (config.apiKey) {
      ctorOpts.apiKey = config.apiKey;
    }

    const providerOpts = config.providerOptions ?? {};
    if (typeof providerOpts["codexPathOverride"] === "string") {
      ctorOpts.codexPathOverride = providerOpts["codexPathOverride"];
    }

    if (config.env) {
      ctorOpts.env = config.env;
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
        ...((configOverrides["features"] as
          | Record<string, unknown>
          | undefined) ?? {}),
        apps: false,
        browser_use: false,
        browser_use_external: false,
        browser_use_full_cdp_access: false,
        code_mode: false,
        // Keep the local Code Mode transport available even when the optional
        // Code Mode feature itself is disabled. Current Codex CLI builds use
        // this bundled host to execute their built-in tool surface and fail
        // closed at startup when the adapter explicitly disables it.
        code_mode_host: true,
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

  /** Build thread options from AgentInput + the run's config snapshot */
  private buildThreadOptions(
    input: AgentInput,
    config: CodexAdapterConfig = this.config,
  ): CodexThreadOptions {
    const opts: CodexThreadOptions = {
      sandboxMode: toCodexSandboxMode(config.sandboxMode),
      approvalPolicy: this.resolveCodexApprovalPolicy(input, config),
      networkAccessEnabled: config.networkAccessEnabled ?? true,
    };

    const configuredModel =
      typeof input.options?.["model"] === "string" &&
      input.options["model"].trim()
        ? input.options["model"].trim()
        : config.model;
    if (configuredModel) {
      opts.model = configuredModel;
    }

    const workDir = input.workingDirectory ?? config.workingDirectory;
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
    } else if (typeof config.skipGitRepoCheck === "boolean") {
      opts.skipGitRepoCheck = config.skipGitRepoCheck;
    }

    // Normalized reasoning effort → Codex modelReasoningEffort field.
    // Defaults to "medium" when neither the per-call input nor the adapter
    // config specifies one, matching the agent-planning run-layer default.
    const reasoning =
      (inputOpts["reasoning"] as string | undefined) ??
      config.reasoning ??
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
  private resolveCodexApprovalPolicy(
    input: AgentInput,
    config: CodexAdapterConfig = this.config,
  ): string {
    // Explicit per-call override takes priority (checked again in buildThreadOptions)
    if (typeof input.options?.["approvalPolicy"] === "string") {
      return input.options["approvalPolicy"];
    }
    const configApprovalPolicy = config.approvalPolicy;
    if (typeof configApprovalPolicy === "string") {
      return configApprovalPolicy;
    }
    const policy = this.resolveInteractionPolicy(input);
    return policy.mode === "auto-approve" ? "never" : "on-failure";
  }

  /** Get or create the run-local InteractionResolver for one execution. */
  private getOrCreateResolver(
    run: CodexRunContext,
    input: AgentInput,
  ): InteractionResolver {
    if (!run.resolver) {
      run.resolver = new InteractionResolver(
        this.resolveInteractionPolicy(input),
      );
    }
    return run.resolver;
  }

  /** Build the run-scoped context handed to the streaming loop. */
  private buildStreamContext(run: CodexRunContext): RunStreamedThreadContext {
    const adapter = this;
    return {
      providerId: adapter.providerId,
      get config(): AdapterConfig {
        return run.config;
      },
      get currentInput(): AgentInput | undefined {
        return run.input;
      },
      get isResume(): boolean {
        return run.isResume;
      },
      getSessionId: () => run.sessionId,
      setSessionId: (sid) => {
        run.sessionId = sid;
      },
      abort: () => {
        // Timeout enforcement aborts THIS run only.
        run.abortController.abort();
      },
      buildApprovalContext: (input) => adapter.buildApprovalContext(run, input),
      isApprovalCapable: (input) =>
        adapter.resolveInteractionPolicy(input).mode !== "auto-approve",
      buildThreadOptions: (input) =>
        adapter.buildThreadOptions(input, run.config),
    };
  }

  /** Build the run-scoped context handed to the approval helpers. */
  private buildApprovalContext(
    run: CodexRunContext,
    input: AgentInput,
  ): CodexApprovalContext {
    return {
      providerId: this.providerId,
      policy: this.resolveInteractionPolicy(input),
      resolver: this.getOrCreateResolver(run, input),
      buildThreadOptions: (i) => this.buildThreadOptions(i, run.config),
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
