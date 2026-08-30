import { validateAiUsageTruthV2 } from "../ai-execution.js";
import {
  add,
  canonicalEqual,
  exactKeys,
  nonEmpty,
  record,
  sha,
  validateSortedUniqueNodes,
} from "./shared.js";
import type { LoopEconomicsEvidenceDiagnostic } from "./types.js";

export function validateTerminal(
  value: unknown,
  admissions: readonly unknown[],
  effectIntents: readonly unknown[],
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!record(value)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "terminal", "Terminal evidence is required.");
    return;
  }
  if (value.status === "pending") {
    exactKeys(value, ["status"], "terminal", diagnostics);
    return;
  }
  if (value.status !== "recorded") {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "terminal.status", "Terminal status must be pending or recorded.");
    return;
  }
  exactKeys(value, ["status", "executions", "effects"], "terminal", diagnostics);
  const terminalExecutions = Array.isArray(value.executions) ? value.executions : [];
  if (!Array.isArray(value.executions)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "terminal.executions", "Terminal executions must be an array.");
  }
  validateSortedUniqueNodes(terminalExecutions, "terminal.executions", diagnostics);
  if (terminalExecutions.length !== admissions.length) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", "terminal.executions", "Terminal executions must cover every admitted execution exactly once.");
  }
  terminalExecutions.forEach((terminal, index) => {
    const path = `terminal.executions[${index}]`;
    if (!record(terminal)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Terminal execution must be an object.");
      return;
    }
    exactKeys(terminal, ["nodeId", "bindingDigest", "receiptDigest", "usage"], path, diagnostics);
    nonEmpty(terminal.nodeId, `${path}.nodeId`, diagnostics);
    sha(terminal.bindingDigest, `${path}.bindingDigest`, diagnostics);
    sha(terminal.receiptDigest, `${path}.receiptDigest`, diagnostics);
    for (const diagnostic of validateAiUsageTruthV2(terminal.usage).diagnostics) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", `${path}.${diagnostic.path}`, diagnostic.message);
    }
    const admission = record(admissions[index]) ? admissions[index] : undefined;
    if (
      admission === undefined ||
      terminal.nodeId !== admission.nodeId ||
      !record(admission.binding) ||
      terminal.bindingDigest !== admission.binding.bindingDigest
    ) {
      add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", path, "Terminal execution does not match its admitted node and execution binding.");
      return;
    }
    validateTerminalUsageAgainstAdmission(terminal.usage, admission, path, diagnostics);
  });

  const effects = Array.isArray(value.effects) ? value.effects : [];
  if (!Array.isArray(value.effects)) {
    add(diagnostics, "LOOP_ECONOMICS_INVALID", "terminal.effects", "Terminal effects must be an array.");
  }
  validateSortedUniqueNodes(effects, "terminal.effects", diagnostics);
  effects.forEach((effect, index) => {
    const path = `terminal.effects[${index}]`;
    if (!record(effect)) {
      add(diagnostics, "LOOP_ECONOMICS_INVALID", path, "Terminal effect must be an object.");
      return;
    }
    exactKeys(effect, ["nodeId", "intentDigest", "receiptDigest"], path, diagnostics);
    nonEmpty(effect.nodeId, `${path}.nodeId`, diagnostics);
    sha(effect.intentDigest, `${path}.intentDigest`, diagnostics);
    sha(effect.receiptDigest, `${path}.receiptDigest`, diagnostics);
    const intent = effectIntents.find(
      (candidate) => record(candidate) && candidate.nodeId === effect.nodeId
    );
    if (!record(intent) || intent.intentDigest !== effect.intentDigest) {
      add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", path, "Terminal effect does not match an admitted effect intent.");
    }
  });
}

function validateTerminalUsageAgainstAdmission(
  usage: unknown,
  admission: Record<string, unknown>,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnostic[]
): void {
  if (!record(usage) || !record(usage.cost) || !record(admission.money)) return;
  const money = admission.money;
  if (money.status === "unknown") {
    if (usage.cost.status !== "unknown" || usage.cost.reason !== money.reason) {
      add(diagnostics, "LOOP_ECONOMICS_COST_MISMATCH", `${path}.usage.cost`, "Terminal unknown money must preserve the admitted unknown reason.");
    }
  } else if (money.status === "priced" && record(money.reservation)) {
    if (
      usage.cost.status === "unknown" ||
      usage.cost.currency !== money.reservation.currency ||
      !Array.isArray(usage.cost.charges)
    ) {
      add(diagnostics, "LOOP_ECONOMICS_COST_MISMATCH", `${path}.usage.cost`, "Priced admission requires authoritative terminal charge lines in the reserved currency.");
    } else {
      for (const charge of usage.cost.charges) {
        if (
          !record(charge) ||
          charge.offerRef !== money.reservation.offerRef ||
          charge.tariffRef !== money.reservation.tariffRef ||
          !canonicalEqual(charge.provenance, money.reservation.provenance)
        ) {
          add(diagnostics, "LOOP_ECONOMICS_COST_MISMATCH", `${path}.usage.cost.charges`, "Terminal charge attribution does not match the admitted offer, tariff, or price authority.");
          break;
        }
      }
    }
  }
  if (!record(admission.quota)) return;
  if (admission.quota.status === "bound" && !record(usage.quota)) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", `${path}.usage.quota`, "Bound quota authority requires measured terminal quota truth.");
  }
  if (admission.quota.status === "not-applicable" && usage.quota !== undefined) {
    add(diagnostics, "LOOP_ECONOMICS_BINDING_MISMATCH", `${path}.usage.quota`, "Quota truth cannot appear without an admitted quota authority.");
  }
}
