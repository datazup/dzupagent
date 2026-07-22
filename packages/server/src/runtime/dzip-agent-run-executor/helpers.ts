import type { ModelRegistry } from "@dzupagent/core/quick-start";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_096;

export function resolveModelName(
  modelTier: string,
  registry: ModelRegistry
): string {
  try {
    const model = registry.getModel(
      modelTier as "chat" | "reasoning" | "codegen" | "embedding"
    );
    return (model as unknown as { model?: string }).model ?? modelTier;
  } catch {
    return modelTier;
  }
}

export function toPrompt(input: unknown): string {
  if (typeof input === "string" && input.trim()) return input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const direct = ["message", "content", "prompt"]
      .map((key) => record[key])
      .find(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      );
    if (direct) return direct;
    return JSON.stringify(input, null, 2);
  }
  if (input == null) return "";
  return String(input);
}
