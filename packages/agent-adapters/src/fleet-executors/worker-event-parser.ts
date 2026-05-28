import type { WorkerEvent } from "@dzupagent/agent-types/fleet";

interface RawCodex {
  type: string;
  at?: string;
  turn_id?: string;
  text?: string;
  role?: string;
  tool_name?: string;
  input?: unknown;
  code?: number | null;
  reason?: string | null;
  message?: string;
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
      return raw.turn_id
        ? { kind: "step_start", stepId: raw.turn_id, at }
        : null;
    case "turn_completed":
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
    case "error":
      return {
        kind: "error",
        message: raw.message ?? "unknown",
        fatal: false,
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
