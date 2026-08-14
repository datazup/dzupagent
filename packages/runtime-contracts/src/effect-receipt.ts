import {
  EXECUTION_EFFECT_CLASSES,
  type ExecutionEffectClass,
} from "./canonical-execution.js";
import {
  validateAiExecutionBinding,
  type AiExecutionBinding,
} from "./ai-execution.js";
import {
  CANONICAL_JSON_VERSION,
  canonicalInputDigest,
} from "./idempotency.js";

export const EFFECT_INTENT_SCHEMA = "dzupagent.effectIntent/v1" as const;
export const EFFECT_RECEIPT_SCHEMA = "dzupagent.effectReceipt/v1" as const;

export type EffectJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EffectJsonValue[]
  | { readonly [key: string]: EffectJsonValue };

export interface EffectIntent {
  readonly schema: typeof EFFECT_INTENT_SCHEMA;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly idempotencyKey: string;
  readonly sourceHash: `sha256:${string}`;
  readonly runId: string;
  readonly nodeId: string;
  readonly effectClass: ExecutionEffectClass;
  readonly attemptPolicy: "idempotent" | "exactly-once-required";
  readonly operationDigest: `sha256:${string}`;
  /** Exact AI execution identity when an AI-backed operation caused the effect. */
  readonly executionBinding?: AiExecutionBinding;
  readonly intentDigest: `sha256:${string}`;
}

export type EffectIntentInput = Omit<
  EffectIntent,
  "schema" | "canonicalization" | "intentDigest"
>;

export interface EffectReceipt<T extends EffectJsonValue = EffectJsonValue> {
  readonly schema: typeof EFFECT_RECEIPT_SCHEMA;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly idempotencyKey: string;
  readonly intentDigest: `sha256:${string}`;
  readonly sourceHash: `sha256:${string}`;
  readonly runId: string;
  readonly nodeId: string;
  readonly effectClass: ExecutionEffectClass;
  readonly executionBinding?: AiExecutionBinding;
  readonly result: T;
  readonly resultDigest: `sha256:${string}`;
  readonly committedAt: string;
  readonly receiptDigest: `sha256:${string}`;
}

export type EffectJournalRecord<T extends EffectJsonValue = EffectJsonValue> =
  | {
      readonly status: "pending";
      readonly intent: EffectIntent;
      readonly claimedAt: string;
    }
  | {
      readonly status: "outcome-unknown";
      readonly intent: EffectIntent;
      readonly observedAt: string;
    }
  | {
      readonly status: "committed";
      readonly intent: EffectIntent;
      readonly receipt: EffectReceipt<T>;
    };

export type EffectClaimResult<T extends EffectJsonValue = EffectJsonValue> =
  | { readonly status: "claimed" }
  | { readonly status: "existing"; readonly record: EffectJournalRecord<T> };

/**
 * Durable hosts implement this as an atomic, unique-key journal. `claim` must
 * insert a pending record only when the idempotency key is absent. `commit`
 * and `markOutcomeUnknown` must compare the same intent digest and must never
 * replace a committed record.
 */
export interface EffectJournalStore<T extends EffectJsonValue = EffectJsonValue> {
  claim(intent: EffectIntent, claimedAt: string): Promise<EffectClaimResult<T>>;
  commit(intent: EffectIntent, receipt: EffectReceipt<T>): Promise<void>;
  markOutcomeUnknown(intent: EffectIntent, observedAt: string): Promise<void>;
}

export type EffectExecutionResult<T extends EffectJsonValue = EffectJsonValue> =
  | {
      readonly status: "executed" | "replayed";
      readonly receipt: EffectReceipt<T>;
    }
  | {
      readonly status: "blocked";
      readonly reason:
        | "idempotency-conflict"
        | "invalid-intent"
        | "effect-outcome-unknown"
        | "journal-outcome-unknown";
    };

export type EffectReceiptDiagnosticCode =
  | "EFFECT_INTENT_INVALID"
  | "EFFECT_RECEIPT_INVALID"
  | "EFFECT_RECEIPT_BINDING_MISMATCH";

export interface EffectReceiptDiagnostic {
  readonly code: EffectReceiptDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface EffectReceiptValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly EffectReceiptDiagnostic[];
}

export function materializeEffectIntent(input: EffectIntentInput): EffectIntent {
  const core = {
    schema: EFFECT_INTENT_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    ...input,
  };
  return { ...core, intentDigest: digest(core) };
}

export function materializeEffectReceipt<T extends EffectJsonValue>(input: {
  readonly intent: EffectIntent;
  readonly result: T;
  readonly committedAt: string;
}): EffectReceipt<T> {
  const core = {
    schema: EFFECT_RECEIPT_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    idempotencyKey: input.intent.idempotencyKey,
    intentDigest: input.intent.intentDigest,
    sourceHash: input.intent.sourceHash,
    runId: input.intent.runId,
    nodeId: input.intent.nodeId,
    effectClass: input.intent.effectClass,
    ...(input.intent.executionBinding === undefined
      ? {}
      : { executionBinding: input.intent.executionBinding }),
    result: input.result,
    resultDigest: digest(input.result),
    committedAt: input.committedAt,
  };
  return { ...core, receiptDigest: digest(core) };
}

/**
 * Executes a mutating effect at most once from the coordinator's perspective.
 * A pre-existing pending/unknown record blocks redispatch; an exact committed
 * record replays its result; a different intent under the same key conflicts.
 * If dispatch throws, outcome is conservatively unknown and future attempts
 * remain blocked until a host-specific reconciliation resolves it.
 */
export async function executeEffectOnce<T extends EffectJsonValue>(input: {
  readonly store: EffectJournalStore<T>;
  readonly intent: EffectIntent;
  readonly execute: () => Promise<T>;
  readonly now: () => string;
}): Promise<EffectExecutionResult<T>> {
  if (!validateEffectIntent(input.intent).valid) {
    return { status: "blocked", reason: "invalid-intent" };
  }
  let claim: EffectClaimResult<T>;
  try {
    claim = await input.store.claim(input.intent, input.now());
  } catch {
    return { status: "blocked", reason: "journal-outcome-unknown" };
  }
  if (claim.status === "existing") {
    if (claim.record.intent.intentDigest !== input.intent.intentDigest) {
      return { status: "blocked", reason: "idempotency-conflict" };
    }
    if (claim.record.status === "committed") {
      return validateEffectReceipt(claim.record.receipt, input.intent).valid
        ? { status: "replayed", receipt: claim.record.receipt }
        : { status: "blocked", reason: "journal-outcome-unknown" };
    }
    return { status: "blocked", reason: "effect-outcome-unknown" };
  }

  let result: T;
  try {
    result = await input.execute();
  } catch {
    try {
      await input.store.markOutcomeUnknown(input.intent, input.now());
      return { status: "blocked", reason: "effect-outcome-unknown" };
    } catch {
      return { status: "blocked", reason: "journal-outcome-unknown" };
    }
  }
  let receipt: EffectReceipt<T>;
  try {
    receipt = materializeEffectReceipt({
      intent: input.intent,
      result,
      committedAt: input.now(),
    });
  } catch {
    return markUnknownOrJournalUncertain(input.store, input.intent, input.now());
  }
  if (!validateEffectReceipt(receipt, input.intent).valid) {
    return markUnknownOrJournalUncertain(input.store, input.intent, input.now());
  }
  try {
    await input.store.commit(input.intent, receipt);
  } catch {
    return { status: "blocked", reason: "journal-outcome-unknown" };
  }
  return { status: "executed", receipt };
}

async function markUnknownOrJournalUncertain<T extends EffectJsonValue>(
  store: EffectJournalStore<T>,
  intent: EffectIntent,
  observedAt: string,
): Promise<EffectExecutionResult<T>> {
  try {
    await store.markOutcomeUnknown(intent, observedAt);
    return { status: "blocked", reason: "effect-outcome-unknown" };
  } catch {
    return { status: "blocked", reason: "journal-outcome-unknown" };
  }
}

export function validateEffectIntent(value: unknown): EffectReceiptValidation {
  const diagnostics: EffectReceiptDiagnostic[] = [];
  if (!record(value)) {
    return invalid("EFFECT_INTENT_INVALID", "$", "Effect intent must be an object.");
  }
  if (value.schema !== EFFECT_INTENT_SCHEMA) {
    add(diagnostics, "EFFECT_INTENT_INVALID", "schema", "Unsupported effect-intent schema.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    add(diagnostics, "EFFECT_INTENT_INVALID", "canonicalization", "Unsupported canonical JSON version.");
  }
  for (const key of ["idempotencyKey", "runId", "nodeId"] as const) {
    if (!nonEmpty(value[key])) add(diagnostics, "EFFECT_INTENT_INVALID", key, "Field must be non-empty.");
  }
  sha(value.sourceHash, "sourceHash", diagnostics, "EFFECT_INTENT_INVALID");
  if (!EXECUTION_EFFECT_CLASSES.includes(value.effectClass as ExecutionEffectClass)) {
    add(diagnostics, "EFFECT_INTENT_INVALID", "effectClass", "Unknown canonical effect class.");
  }
  if (value.attemptPolicy !== "idempotent" && value.attemptPolicy !== "exactly-once-required") {
    add(diagnostics, "EFFECT_INTENT_INVALID", "attemptPolicy", "Effect replay requires idempotent or exactly-once-required policy.");
  }
  sha(value.operationDigest, "operationDigest", diagnostics, "EFFECT_INTENT_INVALID");
  if (value.executionBinding !== undefined) {
    const binding = validateAiExecutionBinding(value.executionBinding);
    for (const diagnostic of binding.diagnostics) {
      add(diagnostics, "EFFECT_INTENT_INVALID", `executionBinding.${diagnostic.path}`, diagnostic.message);
    }
    if (
      !record(value.executionBinding) ||
      value.executionBinding.bindingDigest !== safeDigestWithout(value.executionBinding, "bindingDigest")
    ) {
      add(diagnostics, "EFFECT_INTENT_INVALID", "executionBinding.bindingDigest", "Execution binding digest does not match canonical content.");
    }
  }
  sha(value.intentDigest, "intentDigest", diagnostics, "EFFECT_INTENT_INVALID");
  const { intentDigest, ...core } = value;
  if (intentDigest !== safeDigest(core)) {
    add(diagnostics, "EFFECT_INTENT_INVALID", "intentDigest", "Intent digest does not match canonical content.");
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateEffectReceipt(
  value: unknown,
  intent?: EffectIntent,
): EffectReceiptValidation {
  const diagnostics: EffectReceiptDiagnostic[] = [];
  if (!record(value)) {
    return invalid("EFFECT_RECEIPT_INVALID", "$", "Effect receipt must be an object.");
  }
  if (value.schema !== EFFECT_RECEIPT_SCHEMA) {
    add(diagnostics, "EFFECT_RECEIPT_INVALID", "schema", "Unsupported effect-receipt schema.");
  }
  if (value.canonicalization !== CANONICAL_JSON_VERSION) {
    add(diagnostics, "EFFECT_RECEIPT_INVALID", "canonicalization", "Unsupported canonical JSON version.");
  }
  if (!nonEmpty(value.idempotencyKey)) {
    add(diagnostics, "EFFECT_RECEIPT_INVALID", "idempotencyKey", "Idempotency key must be non-empty.");
  }
  for (const key of ["runId", "nodeId"] as const) {
    if (!nonEmpty(value[key])) add(diagnostics, "EFFECT_RECEIPT_INVALID", key, "Field must be non-empty.");
  }
  sha(value.sourceHash, "sourceHash", diagnostics, "EFFECT_RECEIPT_INVALID");
  if (!EXECUTION_EFFECT_CLASSES.includes(value.effectClass as ExecutionEffectClass)) {
    add(diagnostics, "EFFECT_RECEIPT_INVALID", "effectClass", "Unknown canonical effect class.");
  }
  if (value.executionBinding !== undefined) {
    const binding = validateAiExecutionBinding(value.executionBinding);
    for (const diagnostic of binding.diagnostics) {
      add(diagnostics, "EFFECT_RECEIPT_INVALID", `executionBinding.${diagnostic.path}`, diagnostic.message);
    }
    if (
      !record(value.executionBinding) ||
      value.executionBinding.bindingDigest !== safeDigestWithout(value.executionBinding, "bindingDigest")
    ) {
      add(diagnostics, "EFFECT_RECEIPT_INVALID", "executionBinding.bindingDigest", "Execution binding digest does not match canonical content.");
    }
  }
  sha(value.intentDigest, "intentDigest", diagnostics, "EFFECT_RECEIPT_INVALID");
  sha(value.resultDigest, "resultDigest", diagnostics, "EFFECT_RECEIPT_INVALID");
  sha(value.receiptDigest, "receiptDigest", diagnostics, "EFFECT_RECEIPT_INVALID");
  if (value.resultDigest !== safeDigest(value.result)) {
    add(diagnostics, "EFFECT_RECEIPT_INVALID", "resultDigest", "Result digest does not match canonical result.");
  }
  const { receiptDigest, ...core } = value;
  if (receiptDigest !== safeDigest(core)) {
    add(diagnostics, "EFFECT_RECEIPT_INVALID", "receiptDigest", "Receipt digest does not match canonical content.");
  }
  if (!iso(value.committedAt)) {
    add(diagnostics, "EFFECT_RECEIPT_INVALID", "committedAt", "Commit time must be ISO-8601.");
  }
  if (
    intent !== undefined &&
    (value.idempotencyKey !== intent.idempotencyKey ||
      value.intentDigest !== intent.intentDigest ||
      value.sourceHash !== intent.sourceHash ||
      value.runId !== intent.runId ||
      value.nodeId !== intent.nodeId ||
      value.effectClass !== intent.effectClass ||
      !sameOptionalBinding(value.executionBinding, intent.executionBinding))
  ) {
    add(diagnostics, "EFFECT_RECEIPT_BINDING_MISMATCH", "$", "Receipt does not bind the supplied effect intent.");
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${canonicalInputDigest(value)}`;
}

function safeDigestWithout(
  value: Record<string, unknown>,
  key: string,
): `sha256:${string}` | undefined {
  const { [key]: _omitted, ...core } = value;
  return safeDigest(core);
}

function sameOptionalBinding(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftDigest = safeDigest(left);
  return leftDigest !== undefined && leftDigest === safeDigest(right);
}

function safeDigest(value: unknown): `sha256:${string}` | undefined {
  try {
    return digest(value);
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sha(
  value: unknown,
  path: string,
  diagnostics: EffectReceiptDiagnostic[],
  code: EffectReceiptDiagnosticCode,
): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(nonEmpty(value) ? value : "")) {
    add(diagnostics, code, path, "Field must be a lowercase SHA-256 digest.");
  }
}

function add(
  diagnostics: EffectReceiptDiagnostic[],
  code: EffectReceiptDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function invalid(
  code: EffectReceiptDiagnosticCode,
  path: string,
  message: string,
): EffectReceiptValidation {
  return { valid: false, diagnostics: [{ code, path, message }] };
}
