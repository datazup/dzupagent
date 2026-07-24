import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DiscoverableProviderId = "codex" | "claude";
export type ProviderModelCatalogSource =
  | "codex-app-server"
  | "openai-models-api"
  | "anthropic-models-api"
  | "claude-cli";
export type ProviderModelCatalogCompleteness =
  | "account-catalog"
  | "runtime-catalog"
  | "aliases-only";

export interface ProviderModelCatalogEntry {
  providerId: DiscoverableProviderId;
  id: string;
  displayName: string;
  createdAt?: string | undefined;
  isDefault?: boolean | undefined;
  hidden?: boolean | undefined;
  alias?: boolean | undefined;
  defaultReasoningEffort?: string | undefined;
  supportedReasoningEfforts?: readonly string[] | undefined;
  inputModalities?: readonly string[] | undefined;
  supportsPersonality?: boolean | undefined;
  upgrade?: string | undefined;
  maxInputTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  capabilities?: Readonly<Record<string, unknown>> | undefined;
}

export interface ProviderModelCatalog {
  schemaVersion: "dzupagent/provider-model-catalog/v1";
  providerId: DiscoverableProviderId;
  source: ProviderModelCatalogSource;
  completeness: ProviderModelCatalogCompleteness;
  discoveredAt: string;
  authenticated: boolean | null;
  models: readonly ProviderModelCatalogEntry[];
  warnings: readonly string[];
  fingerprint: string;
}

export interface ModelAvailabilityAssessment {
  status: "available" | "unavailable" | "unverified" | "provider-default";
  requestedModel?: string | undefined;
  matchedModel?: ProviderModelCatalogEntry | undefined;
  reason: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CodexPageResult {
  data: unknown[];
  nextCursor: string | null;
}

export interface ModelDiscoveryDependencies {
  fetch?: typeof fetch | undefined;
  runCommand?: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<CommandResult>;
  loadCodexPage?: (input: {
    cliPath: string;
    cursor: string | null;
    includeHidden: boolean;
    timeoutMs: number;
  }) => Promise<CodexPageResult>;
  now?: (() => Date) | undefined;
}

export interface CodexModelDiscoveryOptions {
  source?: "auto" | "app-server" | "openai-api" | undefined;
  cliPath?: string | undefined;
  apiKey?: string | undefined;
  apiBaseUrl?: string | undefined;
  includeHidden?: boolean | undefined;
  timeoutMs?: number | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  dependencies?: ModelDiscoveryDependencies | undefined;
}

export interface ClaudeModelDiscoveryOptions {
  source?: "auto" | "anthropic-api" | "cli" | undefined;
  cliPath?: string | undefined;
  apiKey?: string | undefined;
  apiBaseUrl?: string | undefined;
  anthropicVersion?: string | undefined;
  timeoutMs?: number | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  dependencies?: ModelDiscoveryDependencies | undefined;
}

export type ProviderModelDiscoveryOptions =
  | CodexModelDiscoveryOptions
  | ClaudeModelDiscoveryOptions;

export async function discoverProviderModels(
  providerId: "codex",
  options?: CodexModelDiscoveryOptions,
): Promise<ProviderModelCatalog>;
export async function discoverProviderModels(
  providerId: "claude",
  options?: ClaudeModelDiscoveryOptions,
): Promise<ProviderModelCatalog>;
export async function discoverProviderModels(
  providerId: DiscoverableProviderId,
  options: ProviderModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  return providerId === "codex"
    ? discoverCodexModels(options as CodexModelDiscoveryOptions)
    : discoverClaudeModels(options as ClaudeModelDiscoveryOptions);
}

export async function discoverCodexModels(
  options: CodexModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  const source = options.source ?? "auto";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const dependencies = options.dependencies ?? {};
  const warnings: string[] = [];

  if (source === "auto" || source === "app-server") {
    try {
      const models = await listCodexAppServerModels({
        cliPath: options.cliPath ?? "codex",
        includeHidden: options.includeHidden ?? false,
        timeoutMs,
        dependencies,
      });
      return createCatalog({
        providerId: "codex",
        source: "codex-app-server",
        completeness: "runtime-catalog",
        authenticated: true,
        models,
        warnings,
        now: dependencies.now,
      });
    } catch (error) {
      if (source === "app-server") throw error;
      warnings.push(`Codex app-server discovery failed: ${errorMessage(error)}`);
    }
  }

  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env["OPENAI_API_KEY"];
  if ((source === "auto" || source === "openai-api") && apiKey) {
    const models = await listOpenAiApiModels({
      apiKey,
      apiBaseUrl: options.apiBaseUrl ?? env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
      timeoutMs,
      fetchImpl: dependencies.fetch ?? fetch,
    });
    return createCatalog({
      providerId: "codex",
      source: "openai-models-api",
      completeness: "account-catalog",
      authenticated: true,
      models,
      warnings: [
        ...warnings,
        "OpenAI Models API availability does not by itself prove Codex runtime compatibility.",
      ],
      now: dependencies.now,
    });
  }

  if (source === "openai-api") {
    throw new Error("OPENAI_API_KEY is required for OpenAI Models API discovery");
  }
  throw new Error(
    warnings[0] ??
      "Codex model discovery requires an authenticated Codex app-server or OPENAI_API_KEY",
  );
}

export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions = {},
): Promise<ProviderModelCatalog> {
  const source = options.source ?? "auto";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const dependencies = options.dependencies ?? {};
  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env["ANTHROPIC_API_KEY"];
  const warnings: string[] = [];

  if ((source === "auto" || source === "anthropic-api") && apiKey) {
    try {
      const models = await listAnthropicApiModels({
        apiKey,
        apiBaseUrl:
          options.apiBaseUrl ??
          env["ANTHROPIC_BASE_URL"] ??
          "https://api.anthropic.com",
        anthropicVersion: options.anthropicVersion ?? "2023-06-01",
        timeoutMs,
        fetchImpl: dependencies.fetch ?? fetch,
      });
      return createCatalog({
        providerId: "claude",
        source: "anthropic-models-api",
        completeness: "account-catalog",
        authenticated: true,
        models,
        warnings,
        now: dependencies.now,
      });
    } catch (error) {
      if (source === "anthropic-api") throw error;
      warnings.push(`Anthropic Models API discovery failed: ${errorMessage(error)}`);
    }
  } else if (source === "anthropic-api") {
    throw new Error("ANTHROPIC_API_KEY is required for Anthropic Models API discovery");
  }

  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const cliPath = options.cliPath ?? "claude";
  let authenticated = false;
  try {
    await runCommand(cliPath, ["auth", "status"], timeoutMs);
    authenticated = true;
  } catch (error) {
    warnings.push(`Claude CLI authentication probe failed: ${errorMessage(error)}`);
  }
  const help = await runCommand(cliPath, ["--help"], timeoutMs);
  const models = parseClaudeCliModelAliases(help.stdout);
  if (models.length === 0) {
    throw new Error("Claude CLI help did not advertise any provider-maintained model aliases");
  }
  warnings.push(
    "Claude CLI discovery exposes provider-maintained aliases only; use ANTHROPIC_API_KEY for the complete account model catalog.",
  );
  return createCatalog({
    providerId: "claude",
    source: "claude-cli",
    completeness: "aliases-only",
    authenticated,
    models,
    warnings,
    now: dependencies.now,
  });
}

export function assessModelAvailability(
  catalog: ProviderModelCatalog,
  requestedModel?: string,
): ModelAvailabilityAssessment {
  const normalized = requestedModel?.trim();
  if (!normalized) {
    const defaultModel = catalog.models.find((model) => model.isDefault === true);
    return {
      status: "provider-default",
      ...(defaultModel ? { matchedModel: defaultModel } : {}),
      reason: defaultModel
        ? `Provider runtime advertises ${defaultModel.id} as its default model`
        : "No model was pinned; selection remains owned by the provider runtime",
    };
  }
  const matchedModel = catalog.models.find(
    (model) => model.id.toLowerCase() === normalized.toLowerCase(),
  );
  if (matchedModel) {
    return {
      status: "available",
      requestedModel: normalized,
      matchedModel,
      reason: `Model is present in the ${catalog.source} catalog`,
    };
  }
  if (catalog.completeness === "aliases-only") {
    return {
      status: "unverified",
      requestedModel: normalized,
      reason:
        "The local Claude catalog contains aliases only; absence does not prove the full model ID is unavailable",
    };
  }
  if (catalog.source === "openai-models-api") {
    return {
      status: "unverified",
      requestedModel: normalized,
      reason:
        "The OpenAI account catalog does not prove which models the Codex runtime accepts",
    };
  }
  return {
    status: "unavailable",
    requestedModel: normalized,
    reason: `Model is absent from the complete ${catalog.source} catalog`,
  };
}

export function parseClaudeCliModelAliases(
  helpText: string,
): ProviderModelCatalogEntry[] {
  const modelSection = helpText.match(
    /--model <model>([\s\S]*?)(?=\n\s{2,}--[a-zA-Z]|\nCommands:|$)/u,
  )?.[1];
  if (!modelSection) return [];
  const candidates = [
    ...modelSection.matchAll(
      /'([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})'/gu,
    ),
  ].map((match) => match[1] ?? "");
  return [...new Set(candidates)].map((id) => ({
    providerId: "claude" as const,
    id,
    displayName: id,
    alias: !id.startsWith("claude-"),
  }));
}

function createCatalog(input: {
  providerId: DiscoverableProviderId;
  source: ProviderModelCatalogSource;
  completeness: ProviderModelCatalogCompleteness;
  authenticated: boolean | null;
  models: readonly ProviderModelCatalogEntry[];
  warnings: readonly string[];
  now?: (() => Date) | undefined;
}): ProviderModelCatalog {
  const models = [...input.models].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const identity = {
    schemaVersion: "dzupagent/provider-model-catalog/v1" as const,
    providerId: input.providerId,
    source: input.source,
    completeness: input.completeness,
    models,
  };
  return {
    ...identity,
    discoveredAt: (input.now ?? (() => new Date()))().toISOString(),
    authenticated: input.authenticated,
    warnings: [...input.warnings],
    fingerprint: `sha256:${createHash("sha256").update(stableJson(identity)).digest("hex")}`,
  };
}

async function listCodexAppServerModels(input: {
  cliPath: string;
  includeHidden: boolean;
  timeoutMs: number;
  dependencies: ModelDiscoveryDependencies;
}): Promise<ProviderModelCatalogEntry[]> {
  const loadPage = input.dependencies.loadCodexPage ?? defaultLoadCodexPage;
  const entries: ProviderModelCatalogEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await loadPage({ ...input, cursor });
    for (const raw of page.data) {
      const model = objectValue(raw);
      const id = stringValue(model["id"]) ?? stringValue(model["model"]);
      if (!id) continue;
      const efforts = Array.isArray(model["supportedReasoningEfforts"])
        ? model["supportedReasoningEfforts"]
            .map((item) => stringValue(objectValue(item)["reasoningEffort"]))
            .filter((value): value is string => Boolean(value))
        : undefined;
      const modalities = stringArray(model["inputModalities"]);
      entries.push({
        providerId: "codex",
        id,
        displayName: stringValue(model["displayName"]) ?? id,
        ...(booleanValue(model["isDefault"]) !== undefined
          ? { isDefault: booleanValue(model["isDefault"]) }
          : {}),
        ...(booleanValue(model["hidden"]) !== undefined
          ? { hidden: booleanValue(model["hidden"]) }
          : {}),
        ...(stringValue(model["defaultReasoningEffort"])
          ? { defaultReasoningEffort: stringValue(model["defaultReasoningEffort"]) }
          : {}),
        ...(efforts?.length ? { supportedReasoningEfforts: efforts } : {}),
        ...(modalities.length ? { inputModalities: modalities } : {}),
        ...(booleanValue(model["supportsPersonality"]) !== undefined
          ? { supportsPersonality: booleanValue(model["supportsPersonality"]) }
          : {}),
        ...(stringValue(model["upgrade"])
          ? { upgrade: stringValue(model["upgrade"]) }
          : {}),
      });
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("Codex model pagination cursor repeated");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return entries;
}

async function listOpenAiApiModels(input: {
  apiKey: string;
  apiBaseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<ProviderModelCatalogEntry[]> {
  const response = await fetchWithTimeout(
    `${input.apiBaseUrl.replace(/\/+$/u, "")}/models`,
    {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    },
    input.timeoutMs,
    input.fetchImpl,
  );
  assertOk(response, "OpenAI Models API");
  const payload = objectValue(await response.json());
  const rows = Array.isArray(payload["data"]) ? payload["data"] : [];
  return rows.flatMap((raw): ProviderModelCatalogEntry[] => {
    const model = objectValue(raw);
    const id = stringValue(model["id"]);
    if (!id) return [];
    const created = numberValue(model["created"]);
    return [
      {
        providerId: "codex",
        id,
        displayName: id,
        ...(created !== undefined
          ? { createdAt: new Date(created * 1000).toISOString() }
          : {}),
      },
    ];
  });
}

async function listAnthropicApiModels(input: {
  apiKey: string;
  apiBaseUrl: string;
  anthropicVersion: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<ProviderModelCatalogEntry[]> {
  const entries: ProviderModelCatalogEntry[] = [];
  const seenCursors = new Set<string>();
  let afterId: string | null = null;
  for (;;) {
    const url = new URL(`${input.apiBaseUrl.replace(/\/+$/u, "")}/v1/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await fetchWithTimeout(
      url.href,
      {
        headers: {
          "x-api-key": input.apiKey,
          "anthropic-version": input.anthropicVersion,
        },
      },
      input.timeoutMs,
      input.fetchImpl,
    );
    assertOk(response, "Anthropic Models API");
    const payload = objectValue(await response.json());
    const rows = Array.isArray(payload["data"]) ? payload["data"] : [];
    for (const raw of rows) {
      const model = objectValue(raw);
      const id = stringValue(model["id"]);
      if (!id) continue;
      const capabilities = objectValueOrUndefined(model["capabilities"]);
      entries.push({
        providerId: "claude",
        id,
        displayName: stringValue(model["display_name"]) ?? id,
        ...(stringValue(model["created_at"])
          ? { createdAt: stringValue(model["created_at"]) }
          : {}),
        ...(numberValue(model["max_input_tokens"]) !== undefined
          ? { maxInputTokens: numberValue(model["max_input_tokens"]) }
          : {}),
        ...(numberValue(model["max_tokens"]) !== undefined
          ? { maxOutputTokens: numberValue(model["max_tokens"]) }
          : {}),
        ...(capabilities ? { capabilities } : {}),
      });
    }
    if (payload["has_more"] !== true) break;
    const lastId = stringValue(payload["last_id"]);
    if (!lastId || seenCursors.has(lastId)) {
      throw new Error("Anthropic model pagination returned an invalid cursor");
    }
    seenCursors.add(lastId);
    afterId = lastId;
  }
  return entries;
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const result = await execFileAsync(command, [...args], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function defaultLoadCodexPage(input: {
  cliPath: string;
  cursor: string | null;
  includeHidden: boolean;
  timeoutMs: number;
}): Promise<CodexPageResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.cliPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, page?: CodexPageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(page ?? { data: [], nextCursor: null });
    };
    const timer = setTimeout(
      () => finish(new Error("Codex app-server model discovery timed out")),
      input.timeoutMs,
    );
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(
          new Error(
            `Codex app-server exited before model discovery completed (code ${code ?? "unknown"}${stderr ? `: ${stderr.slice(0, 512)}` : ""})`,
          ),
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      for (;;) {
        const boundary = stdoutBuffer.indexOf("\n");
        if (boundary < 0) break;
        const line = stdoutBuffer.slice(0, boundary);
        stdoutBuffer = stdoutBuffer.slice(boundary + 1);
        let message: Record<string, unknown>;
        try {
          message = objectValue(JSON.parse(line));
        } catch {
          continue;
        }
        if (message["id"] === 0 && message["result"]) {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(
            `${JSON.stringify({
              method: "model/list",
              id: 1,
              params: {
                limit: 100,
                includeHidden: input.includeHidden,
                ...(input.cursor ? { cursor: input.cursor } : {}),
              },
            })}\n`,
          );
        } else if (message["id"] === 1) {
          if (message["error"]) {
            finish(
              new Error(
                `Codex app-server model/list failed: ${stringValue(objectValue(message["error"])["message"]) ?? "unknown error"}`,
              ),
            );
            return;
          }
          const result = objectValue(message["result"]);
          finish(undefined, {
            data: Array.isArray(result["data"]) ? result["data"] : [],
            nextCursor: stringValue(result["nextCursor"]) ?? null,
          });
          return;
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "dzupagent_model_discovery",
            title: "DzupAgent Model Discovery",
            version: "0.2.0",
          },
        },
      })}\n`,
    );
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(response: Response, label: string): void {
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectValueOrUndefined(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const result = objectValue(value);
  return Object.keys(result).length > 0 ? result : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
