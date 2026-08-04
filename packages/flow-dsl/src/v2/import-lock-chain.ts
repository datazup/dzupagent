import { createHash } from "node:crypto";

import type { DslDiagnostic } from "../diagnostic-types.js";
import type {
  DslV2ImportLockChainEntry,
  DslV2ResolvedImportLock,
} from "./types.js";

/**
 * Revision-chain lineage over the v2 resolved import lock (ADR-0001 C2 / L1).
 *
 * The lock itself stays a pure function of resolved content: the same document
 * against the same catalogs always yields the same `lockSha256`. That is what
 * makes it a usable content address, but it also means a lock cannot record
 * *which* lock it superseded. This sibling contract carries that lineage, so a
 * lock change is verifiable as an ordered revision rather than a silent swap.
 *
 * The entry shape itself lives in `./types.js` (the leaf type module for v2) so
 * that `types.ts` — which embeds it in `DslV2FrontendMetadata` — does not have
 * to import this implementation module back. It is re-exported here so the
 * `@dzupagent/flow-dsl/v2-import-lock-chain` subpath surface is unchanged.
 */
export type { DslV2ImportLockChainEntry } from "./types.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

/** Link one resolved lock to its predecessor, producing the next chain entry. */
export function createV2ImportLockChainEntry(
  lock: DslV2ResolvedImportLock,
  parent?: DslV2ImportLockChainEntry
): DslV2ImportLockChainEntry {
  const core = {
    schema: "dzupagent.dslV2ImportLockChain/v1" as const,
    lockSha256: lock.lockSha256,
    parentLockSha256: parent?.lockSha256 ?? null,
    revision: parent === undefined ? 0 : parent.revision + 1,
  };
  return Object.freeze({
    ...core,
    // Fold the parent's chain digest in, so the digest commits to the whole
    // history rather than just this entry. Without it, two identical locks at
    // different chain positions would be indistinguishable.
    chainSha256: sha256(
      stableStringify({
        ...core,
        parentChainSha256: parent?.chainSha256 ?? null,
      })
    ),
  });
}

/**
 * Verify an import-lock chain is a single, ordered, unbroken revision line.
 *
 * Returns one diagnostic per defect; an empty array means the chain is intact.
 * An empty chain is vacuously valid — absence of lineage is not a defect.
 */
export function verifyV2ImportLockChain(
  entries: readonly DslV2ImportLockChainEntry[]
): readonly DslDiagnostic[] {
  const diagnostics: DslDiagnostic[] = [];
  const seenLocks = new Set<string>();
  let previous: DslV2ImportLockChainEntry | undefined;

  entries.forEach((entry, index) => {
    const path = `importLockChain[${index}]`;

    if (entry.schema !== "dzupagent.dslV2ImportLockChain/v1") {
      diagnostics.push(
        invalid("unsupported import lock chain schema", `${path}.schema`)
      );
      return;
    }
    if (!SHA256.test(entry.lockSha256)) {
      diagnostics.push(
        invalid(
          "chain entry lockSha256 must be an exact lowercase SHA-256 digest",
          `${path}.lockSha256`
        )
      );
      return;
    }

    const expectedParent = previous?.lockSha256 ?? null;
    if (entry.parentLockSha256 !== expectedParent) {
      diagnostics.push(
        invalid(
          expectedParent === null
            ? "first chain entry must be a root with parentLockSha256 null"
            : `chain entry parent ${String(
                entry.parentLockSha256
              )} does not match the preceding lock ${expectedParent}`,
          `${path}.parentLockSha256`
        )
      );
    }

    const expectedRevision = previous === undefined ? 0 : previous.revision + 1;
    if (entry.revision !== expectedRevision) {
      diagnostics.push(
        invalid(
          `chain entry revision must be ${expectedRevision}, found ${entry.revision}`,
          `${path}.revision`
        )
      );
    }

    // Recompute rather than trust: catches a tampered digest, and (because the
    // parent's chain digest is folded in) any reordering upstream of here.
    const recomputed = createV2ImportLockChainEntry(
      { lockSha256: entry.lockSha256 } as DslV2ResolvedImportLock,
      previous
    );
    if (entry.chainSha256 !== recomputed.chainSha256) {
      diagnostics.push(
        invalid(
          "chain entry chainSha256 does not match its recomputed lineage digest",
          `${path}.chainSha256`
        )
      );
    }

    // A lock may legitimately recur (a revert restores earlier content), but it
    // may not appear twice as the *parent* of divergent successors — that is a
    // fork, not a line. Duplicate entries are caught here.
    if (seenLocks.has(entry.chainSha256)) {
      diagnostics.push(
        invalid(
          `duplicate chain entry ${entry.chainSha256}`,
          `${path}.chainSha256`
        )
      );
    }
    seenLocks.add(entry.chainSha256);

    previous = entry;
  });

  return Object.freeze(diagnostics);
}

function invalid(message: string, path: string): DslDiagnostic {
  return {
    phase: "normalize",
    code: "V2_INVALID_IMPORT_LOCK_CHAIN",
    message,
    path,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
