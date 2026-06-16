import type { WorkerEvent } from "@dzupagent/agent-types/fleet";

interface RawCodex {
  type: string;
  at?: string;
  turn_id?: string;
  id?: string;
  text?: string;
  role?: string;
  tool_name?: string;
  input?: unknown;
  item?: {
    type?: string;
    name?: string;
    tool_name?: string;
    input?: unknown;
    query?: string;
    text?: string;
  };
  code?: number | null;
  reason?: string | null;
  message?: string;
  fatal?: boolean;
}

export function parseCodexLine(line: string): WorkerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: RawCodex;
  try {
    raw = JSON.parse(trimmed) as RawCodex;
  } catch {
    return null;
  }
  const at = raw.at ?? new Date().toISOString();
  switch (raw.type) {
    case "turn_started":
    case "turn.started":
      return raw.turn_id
        ? { kind: "step_start", stepId: raw.turn_id, at }
        : null;
    case "turn_completed":
    case "turn.completed":
      return raw.turn_id
        ? { kind: "step_done", stepId: raw.turn_id, at }
        : null;
    case "message":
      return raw.text
        ? {
            kind: "message",
            text: raw.text,
            role: raw.role === "tool" ? "tool" : "assistant",
            at,
          }
        : null;
    case "tool_call":
      return raw.tool_name
        ? {
            kind: "tool_call",
            toolName: raw.tool_name,
            inputSummary: summarize(raw.input),
            at,
          }
        : null;
    case "item.completed": {
      const item = raw.item;
      const toolName = item?.tool_name ?? item?.name ?? item?.type;
      if (!toolName) return null;
      if (toolName === "message") {
        return item?.text
          ? { kind: "message", text: item.text, role: "assistant", at }
          : null;
      }
      return {
        kind: "tool_call",
        toolName,
        inputSummary: summarize(item?.input ?? item?.query ?? item?.text),
        at,
      };
    }
    case "error":
      return {
        kind: "error",
        message: raw.message ?? "unknown",
        fatal: raw.fatal === true,
        at,
      };
    case "exit":
      return {
        kind: "exit",
        code: raw.code ?? null,
        reason: raw.reason ?? null,
        at,
      };
    default:
      return null;
  }
}

function summarize(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = typeof input === "string" ? input : JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}
