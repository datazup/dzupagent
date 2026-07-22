/**
 * Ed25519 crypto primitives for cross-agent authentication —
 * canonical serialization, Base64URL codec, and raw-key DER wrapping.
 *
 * Uses `node:crypto` exclusively (same pattern as core key-manager).
 *
 * @module security/agent-auth/crypto
 */
import { createPrivateKey, createPublicKey } from "node:crypto";

/** Canonical JSON serialization with sorted keys for deterministic signing. */
export function canonicalize(data: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(data, (_key, value: unknown) => {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date)
      ) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
          sorted[k] = (value as Record<string, unknown>)[k];
        }
        return sorted;
      }
      return value;
    }),
    "utf-8"
  );
}

/** Encode a Buffer as Base64URL (no padding). */
export function toBase64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode a Base64URL string to a Buffer. */
export function fromBase64Url(str: string): Buffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (base64.length % 4);
  if (pad !== 4) {
    base64 += "=".repeat(pad);
  }
  return Buffer.from(base64, "base64");
}

/** Build a PKCS8 DER key object from 32-byte Ed25519 private key seed. */
export function privateKeyFromRaw(
  raw: Uint8Array
): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(raw),
    ]),
    format: "der",
    type: "pkcs8",
  });
}

/** Build an SPKI DER key object from 32-byte Ed25519 public key. */
export function publicKeyFromRaw(
  raw: Uint8Array
): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(raw),
    ]),
    format: "der",
    type: "spki",
  });
}
