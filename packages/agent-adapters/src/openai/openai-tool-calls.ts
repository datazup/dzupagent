/**
 * Streaming tool-call assembly helpers for the OpenAI adapter.
 *
 * Extracted from `openai-adapter.ts` (MC-027a-1). Encapsulates the
 * `index`-keyed accumulation of tool_call deltas, ordered flushing into
 * `adapter:tool_call` events, and tool-definition normalization.
 */
import type { AdapterProviderId, AgentEvent, AgentInput } from "../types.js";
import type {
  OpenAIToolWire,
  SSEChunkChoice,
  SSEToolCallDelta,
} from "./openai-types.js";

export interface SseChoiceProcessResult {
  events: AgentEvent[];
  /** Content text appended to the current run's full-text accumulator. */
  appendedContent: string;
}

interface PendingToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
  emitted: boolean;
}

/**
 * Accumulates streaming tool-call fragments and flushes them as ordered
 * `adapter:tool_call` events. State is reset between executions via
 * {@link OpenAIToolCallAccumulator.reset}.
 */
export class OpenAIToolCallAccumulator {
  private pending = new Map<number, PendingToolCall>();

  reset(): void {
    this.pending = new Map();
  }

  /**
   * Merge incoming tool_call fragments (`index`-keyed) into the pending map.
   * The first fragment for a given `index` typically supplies `id` and
   * `function.name`; subsequent fragments append `function.arguments` text.
   */
  accumulate(deltas: SSEToolCallDelta[]): void {
    for (const delta of deltas) {
      const existing = this.pending.get(delta.index);
      if (existing) {
        if (delta.id !== undefined) existing.id = delta.id;
        if (delta.function?.name !== undefined)
          existing.name = delta.function.name;
        if (delta.function?.arguments !== undefined) {
          existing.arguments += delta.function.arguments;
        }
      } else {
        this.pending.set(delta.index, {
          index: delta.index,
          ...(delta.id !== undefined ? { id: delta.id } : {}),
          ...(delta.function?.name !== undefined
            ? { name: delta.function.name }
            : {}),
          arguments: delta.function?.arguments ?? "",
          emitted: false,
        });
      }
    }
  }

  /**
   * Convert any unemitted accumulated tool calls into `adapter:tool_call`
   * events (in stream order — sorted by `index`) and mark them emitted.
   *
   * Tool calls without a resolved `name` are skipped since `toolName` is
   * required by the unified event contract; this should never happen for
   * conformant OpenAI streams.
   */
  flush(
    providerId: AdapterProviderId,
    correlationId: string | undefined,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    const ordered = [...this.pending.values()].sort(
      (a, b) => a.index - b.index,
    );
    for (const call of ordered) {
      if (call.emitted) continue;
      call.emitted = true;
      if (call.name === undefined || call.name.length === 0) continue;
      events.push({
        type: "adapter:tool_call",
        providerId,
        toolName: call.name,
        ...(call.id !== undefined ? { toolCallId: call.id } : {}),
        input: parseToolArguments(call.arguments),
        timestamp: Date.now(),
        ...(correlationId ? { correlationId } : {}),
      });
    }
    return events;
  }

  /**
   * Process a single SSE choice payload: accumulate any tool-call fragments,
   * emit a `stream_delta` for textual content, and flush pending tool calls
   * when `finish_reason === 'tool_calls'`. Returns the mapped events plus
   * any text the caller should append to its full-text accumulator.
   */
  processSseChoice(
    choice: SSEChunkChoice,
    providerId: AdapterProviderId,
    correlationId: string | undefined,
  ): SseChoiceProcessResult {
    const events: AgentEvent[] = [];
    let appendedContent = "";

    if (choice.delta?.tool_calls) {
      this.accumulate(choice.delta.tool_calls);
    }

    if (
      typeof choice.delta?.content === "string" &&
      choice.delta.content.length > 0
    ) {
      appendedContent = choice.delta.content;
      events.push({
        type: "adapter:stream_delta",
        providerId,
        content: appendedContent,
        timestamp: Date.now(),
        ...(correlationId ? { correlationId } : {}),
      });
    }

    if (choice.finish_reason === "tool_calls") {
      events.push(...this.flush(providerId, correlationId));
    }

    return { events, appendedContent };
  }
}

/**
 * Parse the accumulated `function.arguments` JSON string. Returns `{}` when
 * the buffer is empty. On a direct `JSON.parse` failure it attempts a best-effort
 * repair (strip trailing commas, close unbalanced braces/brackets, terminate a
 * dangling string) — truncated streaming buffers are the common failure mode —
 * and only falls back to the raw string when the repaired candidate is still
 * unparseable, so consumers still receive the model output for diagnostics.
 */
export function parseToolArguments(buffer: string): unknown {
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer) as unknown;
  } catch {
    const repaired = repairJson(buffer);
    if (repaired !== undefined) {
      try {
        return JSON.parse(repaired) as unknown;
      } catch {
        // fall through to raw fallback
      }
    }
    return buffer;
  }
}

/**
 * Best-effort structural repair of a truncated/lightly-malformed JSON buffer.
 * Handles the failure modes typical of interrupted streaming tool-call
 * arguments: trailing commas, a string left open at EOF, and unclosed
 * object/array brackets. Returns the repaired candidate string, or `undefined`
 * when the buffer does not look like structured JSON (e.g. a bare token like
 * `not-json`) and therefore cannot be meaningfully repaired.
 */
function repairJson(buffer: string): string | undefined {
  const trimmed = buffer.trim();
  // Only attempt repair on inputs that begin as a JSON object/array; bare
  // scalars/tokens are genuinely unrepairable and should hit the raw fallback.
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
  }

  let repaired = trimmed;
  // Close a string left open at EOF (unterminated due to truncation).
  if (inString) repaired += '"';
  // Strip a dangling trailing comma (optionally followed by whitespace) so the
  // subsequently appended closers produce valid JSON.
  repaired = repaired.replace(/,\s*$/, "");
  // Close any still-open brackets in reverse (LIFO) order.
  while (stack.length > 0) {
    repaired += stack.pop();
  }
  return repaired;
}

/**
 * Read tool definitions from `input.options.tools` and convert them into
 * the OpenAI Chat Completions wire format. Accepts either:
 *   1. The flat `OpenAIToolDefinition` shape — `{name, description?, parameters?}`
 *   2. The pre-wrapped wire shape — `{type:'function', function:{...}}`
 *
 * Invalid entries are silently skipped to keep parity with other adapters.
 */
export function resolveOpenAITools(
  input: AgentInput,
): OpenAIToolWire[] | undefined {
  const raw = input.options?.["tools"];
  if (!Array.isArray(raw)) return undefined;
  const wire: OpenAIToolWire[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    // Pre-wrapped form
    if (
      "type" in entry &&
      (entry as { type?: unknown }).type === "function" &&
      "function" in entry
    ) {
      const fn = (entry as { function?: unknown }).function;
      if (
        fn !== null &&
        typeof fn === "object" &&
        "name" in fn &&
        typeof (fn as { name?: unknown }).name === "string"
      ) {
        const named = fn as {
          name: string;
          description?: unknown;
          parameters?: unknown;
        };
        wire.push({
          type: "function",
          function: {
            name: named.name,
            ...(typeof named.description === "string"
              ? { description: named.description }
              : {}),
            ...(named.parameters && typeof named.parameters === "object"
              ? { parameters: named.parameters as Record<string, unknown> }
              : {}),
          },
        });
      }
      continue;
    }
    // Flat form
    if (
      "name" in entry &&
      typeof (entry as { name?: unknown }).name === "string"
    ) {
      const flat = entry as {
        name: string;
        description?: unknown;
        parameters?: unknown;
      };
      wire.push({
        type: "function",
        function: {
          name: flat.name,
          ...(typeof flat.description === "string"
            ? { description: flat.description }
            : {}),
          ...(flat.parameters && typeof flat.parameters === "object"
            ? { parameters: flat.parameters as Record<string, unknown> }
            : {}),
        },
      });
    }
  }
  return filterOpenAIToolsByPolicy(wire, input);
}

function filterOpenAIToolsByPolicy(
  tools: OpenAIToolWire[],
  input: AgentInput,
): OpenAIToolWire[] | undefined {
  const policy = input.policyContext?.activePolicy;
  if (policy === undefined) return tools.length > 0 ? tools : undefined;

  const allowed = new Set(policy.allowedTools ?? []);
  const blocked = new Set(policy.blockedTools ?? []);
  const strictWithoutAllowlist =
    policy.toolPolicy === "strict" && allowed.size === 0;

  const filtered = tools.filter((tool) => {
    const name = tool.function.name;
    if (strictWithoutAllowlist) return false;
    if (allowed.size > 0 && !allowed.has(name)) return false;
    if (blocked.has(name)) return false;
    return true;
  });

  return filtered.length > 0 ? filtered : undefined;
}
