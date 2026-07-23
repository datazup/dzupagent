import {
  createHash,
  sign,
  verify,
  type KeyLike,
} from "node:crypto";

import {
  validateFlowRedactionReceipt,
  type FlowRedactionReceipt,
  type FlowSecurityContractValidation,
  type FlowSha256Digest,
} from "@dzupagent/flow-ast";

type WithoutAttestation<T> = T extends unknown
  ? Omit<T, "attestation">
  : never;

export type FlowUnsignedRedactionReceipt =
  WithoutAttestation<FlowRedactionReceipt>;

export type FlowRedactionReceiptPublicKeyResolver = (
  keyRef: string,
) => KeyLike | null | Promise<KeyLike | null>;

/** RFC 8785-compatible serialization for JSON-domain security payloads. */
export function canonicalizeFlowSecurityJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>(), "$");
}

export function digestFlowSecurityJson(value: unknown): FlowSha256Digest {
  return `sha256:${createHash("sha256")
    .update(canonicalizeFlowSecurityJson(value), "utf8")
    .digest("hex")}`;
}

export function digestFlowRedactionReceiptPayload(
  receipt: FlowUnsignedRedactionReceipt | FlowRedactionReceipt,
): FlowSha256Digest {
  const { attestation: _attestation, ...payload } =
    receipt as FlowRedactionReceipt;
  return digestFlowSecurityJson(payload);
}

/**
 * Create an Ed25519 attestation over the UTF-8 payload-digest identity.
 * The completed receipt is structurally revalidated before it is returned.
 */
export function attestFlowRedactionReceipt(
  receipt: FlowUnsignedRedactionReceipt,
  keyRef: string,
  privateKey: KeyLike,
): FlowRedactionReceipt {
  if (keyRef.trim().length === 0) {
    throw new TypeError("keyRef must be a non-empty string");
  }
  const payloadDigest = digestFlowRedactionReceiptPayload(receipt);
  const signature = sign(
    null,
    Buffer.from(payloadDigest, "utf8"),
    privateKey,
  ).toString("base64");
  const completed = {
    ...receipt,
    attestation: {
      algorithm: "ed25519" as const,
      keyRef,
      payloadDigest,
      signature,
    },
  } as FlowRedactionReceipt;
  const validation = validateFlowRedactionReceipt(completed);
  if (!validation.valid) {
    throw new TypeError(
      `invalid redaction receipt: ${validation.issues.join("; ")}`,
    );
  }
  const detached = JSON.parse(
    canonicalizeFlowSecurityJson(completed),
  ) as FlowRedactionReceipt;
  return deepFreezeJson(detached);
}

/** Resolve the declared key, recompute the payload digest, and verify Ed25519. */
export async function verifyFlowRedactionReceiptAttestation(
  receipt: unknown,
  resolvePublicKey: FlowRedactionReceiptPublicKeyResolver,
): Promise<FlowSecurityContractValidation> {
  const structural = validateFlowRedactionReceipt(receipt);
  if (!structural.valid) return structural;
  const typedReceipt = receipt as FlowRedactionReceipt;
  let expectedDigest: FlowSha256Digest;
  try {
    expectedDigest = digestFlowRedactionReceiptPayload(typedReceipt);
  } catch {
    return invalid("receipt payload must be canonical JSON");
  }
  if (typedReceipt.attestation.payloadDigest !== expectedDigest) {
    return invalid("attestation.payloadDigest does not match receipt payload");
  }
  let publicKey: KeyLike | null;
  try {
    publicKey = await resolvePublicKey(typedReceipt.attestation.keyRef);
  } catch {
    return invalid("attestation key resolution failed");
  }
  if (publicKey === null) {
    return invalid("attestation keyRef is not trusted");
  }
  try {
    const valid = verify(
      null,
      Buffer.from(expectedDigest, "utf8"),
      publicKey,
      Buffer.from(typedReceipt.attestation.signature, "base64"),
    );
    return valid
      ? Object.freeze({ valid: true, issues: Object.freeze([]) })
      : invalid("attestation signature is invalid");
  } catch {
    return invalid("attestation signature verification failed");
  }
}

export function deepFreezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeJson(nested);
  }
  return Object.freeze(value);
}

function canonicalize(
  value: unknown,
  seen: WeakSet<object>,
  path: string,
): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite numbers`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not JSON-compatible`);
  }
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (
      Object.keys(value).length !== value.length ||
      value.some((_entry, index) => !Object.hasOwn(value, index))
    ) {
      throw new TypeError(`${path} cannot contain holes or extra properties`);
    }
    const serialized = value
      .map((entry, index) => canonicalize(entry, seen, `${path}[${index}]`))
      .join(",");
    seen.delete(value);
    return `[${serialized}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects`);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    throw new TypeError(`${path} cannot contain symbol keys`);
  }
  const record = value as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(record),
  )) {
    if (
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
  }
  const serialized = Object.keys(record)
    .sort()
    .map((key) => {
      assertUnicodeScalarString(key, `${path} key`);
      return `${JSON.stringify(key)}:${canonicalize(
          record[key],
          seen,
          `${path}.${key}`,
        )}`;
    })
    .join(",");
  seen.delete(value);
  return `{${serialized}}`;
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${path} contains an unpaired Unicode surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`${path} contains an unpaired Unicode surrogate`);
    }
  }
}

function invalid(issue: string): FlowSecurityContractValidation {
  return Object.freeze({
    valid: false,
    issues: Object.freeze([issue]),
  });
}
