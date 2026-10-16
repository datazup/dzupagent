import { describe, it, expect, vi, afterEach } from "vitest";
import { createSafetyMonitor } from "../safety-monitor.js";
import type { SafetyRule } from "../built-in-rules.js";
import type { DzupEventBus } from "../../../events/event-bus.js";

/**
 * ERR-H-02: a throwing safety rule silently skipped a whole detection category
 * (scanContent catch {}), and a throwing event bus silently dropped
 * safety:violation / safety:kill_requested. Both are now logged via
 * defaultLogger (which writes through console.error / console.warn).
 */
describe("SafetyMonitor error observability (ERR-H-02)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs (not swallows) when a rule.check() throws, and keeps scanning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const throwingRule: SafetyRule = {
      id: "boom",
      category: "prompt_injection",
      severity: "critical",
      action: "block",
      check() {
        throw new Error("ReDoS in rule");
      },
    };

    const monitor = createSafetyMonitor({
      rules: [throwingRule],
      replaceBuiltInRules: true,
    });

    // Must not throw — one bad rule cannot break scanning.
    expect(() => monitor.scanContent("malicious input")).not.toThrow();

    // The skipped category must be observable.
    expect(errorSpy).toHaveBeenCalledWith(
      "[safety-monitor] rule check threw",
      expect.objectContaining({ rule: "prompt_injection" })
    );
  });

  it("reports a throwing rule through scanContentDetailed (ERR-H-80)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const monitor = createSafetyMonitor({
      injectionScanner: () => {
        throw new Error("scanner down");
      },
    });

    const result = monitor.scanContentDetailed!("ignore previous instructions");
    expect(result.failedRules).toEqual([
      { ruleId: "builtin:prompt-injection", category: "prompt_injection", action: "block" },
    ]);
    // The other categories still produced a verdict.
    expect(monitor.scanContentDetailed!("AKIAIOSFODNN7EXAMPLE").violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "secret_leak" })])
    );
    expect(monitor.scanContent("benign")).toEqual([]);
  });

  it("logs when the event bus throws while emitting a kill_requested violation", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const killRule: SafetyRule = {
      id: "kill",
      category: "escalation",
      severity: "emergency",
      action: "kill",
      check(content) {
        return {
          category: "escalation",
          severity: "emergency",
          action: "kill",
          message: "privilege escalation",
          evidence: content,
          timestamp: new Date(),
        };
      },
    };

    const throwingBus = {
      emit: vi.fn(() => {
        throw new Error("bus down");
      }),
      on: vi.fn(() => () => {}),
    } as unknown as DzupEventBus;

    const monitor = createSafetyMonitor({
      rules: [killRule],
      replaceBuiltInRules: true,
      eventBus: throwingBus,
    });

    expect(() => monitor.scanContent("escalate now")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      "[safety-monitor] violation emit failed",
      expect.objectContaining({ category: "escalation", action: "kill" })
    );
  });
});
