import { describe, it, expect } from "vitest";
import { parseCodexLine } from "../worker-event-parser.js";

describe("parseCodexLine", () => {
  it("returns null for non-JSON lines", () => {
    expect(parseCodexLine("hello")).toBeNull();
  });

  it("maps a step_start event", () => {
    const line = JSON.stringify({
      type: "turn_started",
      turn_id: "t1",
      at: "2026-05-28T00:00:00Z",
    });
    const e = parseCodexLine(line);
    expect(e?.kind).toBe("step_start");
    if (e?.kind === "step_start") expect(e.stepId).toBe("t1");
  });

  it("maps an assistant message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      text: "hi",
      at: "2026-05-28T00:00:00Z",
    });
    const e = parseCodexLine(line);
    expect(e?.kind).toBe("message");
    if (e?.kind === "message") expect(e.text).toBe("hi");
  });

  it("maps an exit event", () => {
    const line = JSON.stringify({
      type: "exit",
      code: 0,
      at: "2026-05-28T00:00:00Z",
    });
    const e = parseCodexLine(line);
    expect(e?.kind).toBe("exit");
    if (e?.kind === "exit") expect(e.code).toBe(0);
  });

  it("returns null for unknown event shapes", () => {
    const line = JSON.stringify({ type: "unknown", detail: "x" });
    expect(parseCodexLine(line)).toBeNull();
  });

  it("maps a non-fatal error event with fatal:false by default", () => {
    const line = JSON.stringify({ type: "error", message: "oops" });
    const e = parseCodexLine(line);
    expect(e?.kind).toBe("error");
    if (e?.kind === "error") expect(e.fatal).toBe(false);
  });

  it("forwards fatal:true when the subprocess emits it", () => {
    const line = JSON.stringify({
      type: "error",
      message: "fatal oops",
      fatal: true,
    });
    const e = parseCodexLine(line);
    expect(e?.kind).toBe("error");
    if (e?.kind === "error") expect(e.fatal).toBe(true);
  });
});
