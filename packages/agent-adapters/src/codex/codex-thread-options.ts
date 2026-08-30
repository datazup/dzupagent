import type { AdapterConfig, AgentInput, InteractionPolicy } from "../types.js";
import { toCodexSandboxMode } from "./codex-helpers.js";
import type { CodexThreadOptions } from "./codex-types.js";

export interface CodexAdapterConfig extends AdapterConfig {
  networkAccessEnabled?: boolean | undefined;
  approvalPolicy?: string | undefined;
}

/** Project one AgentInput + adapter config into Codex SDK thread options. */
export function buildCodexThreadOptions(
  input: AgentInput,
  config: CodexAdapterConfig,
  resolveInteractionPolicy: (input: AgentInput) => InteractionPolicy
): CodexThreadOptions {
  const opts: CodexThreadOptions = {
    sandboxMode: toCodexSandboxMode(config.sandboxMode),
    approvalPolicy: resolveCodexApprovalPolicy(
      input,
      config,
      resolveInteractionPolicy
    ),
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
function resolveCodexApprovalPolicy(
  input: AgentInput,
  config: CodexAdapterConfig,
  resolveInteractionPolicy: (input: AgentInput) => InteractionPolicy
): string {
  // Explicit per-call override takes priority (checked again in buildCodexThreadOptions)
  if (typeof input.options?.["approvalPolicy"] === "string") {
    return input.options["approvalPolicy"];
  }
  const configApprovalPolicy = config.approvalPolicy;
  if (typeof configApprovalPolicy === "string") {
    return configApprovalPolicy;
  }
  const policy = resolveInteractionPolicy(input);
  return policy.mode === "auto-approve" ? "never" : "on-failure";
}
