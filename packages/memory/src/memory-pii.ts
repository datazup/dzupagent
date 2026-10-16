/**
 * Default PII detector and value redaction for the {@link MemoryService} write path.
 *
 * Backed by the shared `@dzupagent/security` scanner (the same one
 * `@dzupagent/core`'s `detectPII` wraps), so memory redacts by default
 * without depending on core. Matches are replaced with `[REDACTED-<TAG>]`.
 */
import { PiiDetector } from "@dzupagent/security";
import type { MemoryPIIResult } from "./memory-service-types.js";

const detector = new PiiDetector();

export function defaultMemoryPIIDetector(text: string): MemoryPIIResult {
  const scan = detector.scanDetailed(text);
  return { hasPII: scan.hasPii, redacted: scan.redacted };
}

/**
 * Run `detect` over every string leaf of a JSON-shaped value, returning a
 * copy with redacted leaves. Framework-metadata, identifier and digest keys
 * (see {@link isUnscannedKey}) and machine-token values (see
 * {@link isMachineToken}) are copied through unscanned. Throws whatever
 * `detect` throws.
 */
export function redactStringLeaves(
  value: Record<string, unknown>,
  detect: (text: string) => { hasPII: boolean; redacted: string }
): { value: Record<string, unknown>; hasPII: boolean } {
  let hasPII = false;
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (isMachineToken(node)) return node;
      const result = detect(node);
      if (!result.hasPII) return node;
      hasPII = true;
      return result.redacted;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object" && isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = isUnscannedKey(k) ? v : visit(v);
      }
      return out;
    }
    return node;
  };
  const redacted = visit(value) as Record<string, unknown>;
  return { value: hasPII ? redacted : value, hasPII };
}

/**
 * `_`-prefixed framework metadata (`_decay`, `_encrypted_value`, ...) and
 * identifier/digest/reference-named fields are copied through: the scanner's
 * PHONE pattern matches digit runs inside UUIDs and hex digests, and
 * rewriting an id or digest breaks lookups and integrity checks.
 */
const MACHINE_KEY =
  /^(id|key|ref|digest|hash)$|(Id|Ids|_id|_ids|Key|Keys|Ref|Refs|Digest|Hash)$/;

function isUnscannedKey(key: string): boolean {
  return key.startsWith("_") || MACHINE_KEY.test(key);
}

/** UUIDs and (optionally `sha256:`-prefixed) hex digests are never PII. */
const UUID_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_ALGORITHM_PREFIX = /^sha\d+:/i;
const HEX_DIGEST = /^[0-9a-f]{16,}$/i;

function isMachineToken(value: string): boolean {
  return (
    UUID_TOKEN.test(value) ||
    HEX_DIGEST.test(value.replace(DIGEST_ALGORITHM_PREFIX, ""))
  );
}

function isPlainObject(node: object): boolean {
  const proto = Object.getPrototypeOf(node);
  return proto === Object.prototype || proto === null;
}
