import { describe, expect, it } from "vitest";
import { evaluateCircuitGate, type CircuitGateResult } from "../index.js";

describe("circuit gate (MPCO P8a / T16)", () => {
  // T16: open circuit blocks before execution, records a typed reason
  it("T16a: an open circuit (canExecute=false) is NOT allowed and carries the typed reason", () => {
    const res: CircuitGateResult = evaluateCircuitGate(false, "codex");
    expect(res.allowed).toBe(false);
    expect(res.provider).toBe("codex");
    expect(res.reason).toBe("circuit_open");
  });

  it("T16b: a closed/half-open circuit (canExecute=true) is allowed with no reason", () => {
    const res = evaluateCircuitGate(true, "claude");
    expect(res.allowed).toBe(true);
    expect(res.provider).toBe("claude");
    expect(res.reason).toBeUndefined();
  });

  it("T16c (determinism): same inputs → same result", () => {
    expect(evaluateCircuitGate(false, "codex")).toEqual(
      evaluateCircuitGate(false, "codex")
    );
  });
});
