import type { WorkerSpec } from "@dzupagent/agent-types/fleet";
import type {
  AdapterProviderId,
  AgentInput,
  AgentInputPolicy,
  TaskDescriptor,
} from "@dzupagent/adapter-types";

export interface AdapterFleetExecutionMapping {
  input: AgentInput;
  task: TaskDescriptor;
}

export function mapWorkerSpecToAgentExecution(
  spec: WorkerSpec
): AdapterFleetExecutionMapping {
  const payload = asRecord(spec.taskBundle.payload);
  const runtimePolicy =
    readPolicy(spec.config, "runtimePolicy") ??
    readPolicy(payload, "runtimePolicy");
  const provider =
    readProvider(spec.config, "provider") ??
    readProvider(payload, "provider") ??
    readProvider(payload, "providerId");
  const model = readString(spec.config, "model") ?? readString(payload, "model");
  const maxTurns = readNumber(spec.config, "maxTurns") ?? readNumber(payload, "maxTurns");
  const maxBudgetUsd =
    readNumber(spec.config, "maxBudgetUsd") ?? readNumber(payload, "maxBudgetUsd");
  const outputSchema =
    readRecord(spec.config, "outputSchema") ?? readRecord(payload, "outputSchema");
  const correlationId =
    readString(spec.config, "correlationId") ?? readString(payload, "correlationId");
  const prompt = buildPrompt(spec, payload);
  const tags = buildTags(spec, payload);

  const input: AgentInput = {
    prompt,
    workingDirectory: spec.repoPath,
    systemPrompt: readString(payload, "systemPrompt"),
    maxTurns,
    maxBudgetUsd,
    options: model === undefined ? undefined : { model },
    correlationId,
    outputSchema,
    policyContext:
      runtimePolicy === undefined ? undefined : { activePolicy: runtimePolicy },
  };

  const task: TaskDescriptor = {
    prompt,
    tags,
    preferredProvider: provider,
    requiresExecution: true,
    requiresReasoning: true,
    workingDirectory: spec.repoPath,
  };

  return { input, task };
}

function buildPrompt(spec: WorkerSpec, payload: Record<string, unknown>): string {
  const basePrompt =
    readString(payload, "prompt") || spec.taskBundle.description || spec.taskBundle.id;
  const acceptanceCriteria = readStringArray(payload, "acceptanceCriteria");
  const sections = [
    basePrompt,
    `Worker ID: ${spec.workerId}`,
    `Repo: ${spec.repo.name}`,
    `Task ID: ${spec.taskBundle.id}`,
  ];

  if (acceptanceCriteria.length > 0) {
    sections.push(
      ["Acceptance criteria:", ...acceptanceCriteria.map((item) => `- ${item}`)].join("\n")
    );
  }

  return sections.join("\n\n");
}

function buildTags(spec: WorkerSpec, payload: Record<string, unknown>): string[] {
  return Array.from(
    new Set(["fleet", spec.repo.name, ...readStringArray(payload, "tags")])
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readProvider(
  record: Record<string, unknown>,
  key: string
): AdapterProviderId | undefined {
  const value = readString(record, key);
  if (
    value === "claude" ||
    value === "codex" ||
    value === "gemini" ||
    value === "gemini-sdk" ||
    value === "qwen" ||
    value === "crush" ||
    value === "goose" ||
    value === "openrouter" ||
    value === "openai"
  ) {
    return value;
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  return asOptionalRecord(record[key]);
}

function readPolicy(
  record: Record<string, unknown>,
  key: string
): AgentInputPolicy | undefined {
  const value = asOptionalRecord(record[key]);
  if (value === undefined) return undefined;

  const policy: AgentInputPolicy = {};
  const sandboxMode = value.sandboxMode;
  if (
    sandboxMode === "read-only" ||
    sandboxMode === "workspace-write" ||
    sandboxMode === "full-access"
  ) {
    policy.sandboxMode = sandboxMode;
  }
  if (typeof value.networkAccess === "boolean") {
    policy.networkAccess = value.networkAccess;
  }
  if (typeof value.approvalRequired === "boolean") {
    policy.approvalRequired = value.approvalRequired;
  }
  if (Array.isArray(value.allowedTools)) {
    policy.allowedTools = value.allowedTools.filter(
      (item): item is string => typeof item === "string"
    );
  }
  if (Array.isArray(value.blockedTools)) {
    policy.blockedTools = value.blockedTools.filter(
      (item): item is string => typeof item === "string"
    );
  }
  if (typeof value.maxBudgetUsd === "number") {
    policy.maxBudgetUsd = value.maxBudgetUsd;
  }
  if (typeof value.maxTurns === "number") {
    policy.maxTurns = value.maxTurns;
  }

  return Object.keys(policy).length === 0 ? undefined : policy;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
