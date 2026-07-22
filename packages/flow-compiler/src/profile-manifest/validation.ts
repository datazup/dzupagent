import { FLOW_NODE_KINDS } from "@dzupagent/flow-ast";

import { FLOW_PROFILE_MANIFESTS } from "./definitions.js";
import { hashFlowProfileManifest } from "./hashing.js";
import {
  PROFILE_NAMESPACE_PATTERN,
  SHA256_PATTERN,
  addDuplicateDiagnostics,
  diag,
  invalid,
  isFlowCapabilityOwner,
  isRecord,
  parseExactSemver,
  parseProfileRef,
} from "./internal.js";
import {
  type FlowProfileDiagnostic,
  type FlowProfileLock,
  type FlowProfileManifest,
  type FlowProfileValidationResult,
} from "./types.js";

export function validateFlowProfileManifest(
  manifest: unknown
): FlowProfileValidationResult {
  const diagnostics: FlowProfileDiagnostic[] = [];
  if (!isRecord(manifest)) {
    return invalid(
      "INVALID_SCHEMA",
      "root",
      "Profile manifest must be an object."
    );
  }

  if (manifest.schema !== "dzupagent.flowProfileManifest/v1") {
    diagnostics.push(
      diag(
        "INVALID_SCHEMA",
        "schema",
        "Unsupported flow profile manifest schema."
      )
    );
  }

  const parsedRef =
    typeof manifest.ref === "string" ? parseProfileRef(manifest.ref) : null;
  if (!parsedRef) {
    diagnostics.push(
      diag(
        "INVALID_PROFILE_REF",
        "ref",
        "Profile ref must use namespace.name@major."
      )
    );
  }

  if (
    typeof manifest.namespace !== "string" ||
    !PROFILE_NAMESPACE_PATTERN.test(manifest.namespace)
  ) {
    diagnostics.push(
      diag(
        "INVALID_NAMESPACE",
        "namespace",
        "Namespace must be lowercase kebab-case."
      )
    );
  }
  if (
    typeof manifest.name !== "string" ||
    !PROFILE_NAMESPACE_PATTERN.test(manifest.name)
  ) {
    diagnostics.push(
      diag(
        "INVALID_SCHEMA",
        "name",
        "Profile name must be lowercase kebab-case."
      )
    );
  }
  if (!isFlowCapabilityOwner(manifest.owner)) {
    diagnostics.push(
      diag("INVALID_SCHEMA", "owner", "Profile owner is not recognized.")
    );
  }
  if (manifest.kind !== "kernel" && manifest.kind !== "extension") {
    diagnostics.push(
      diag(
        "INVALID_SCHEMA",
        "kind",
        "Profile kind must be kernel or extension."
      )
    );
  }
  if (
    manifest.lowering !== "core-ir" &&
    manifest.lowering !== "opaque-host-action"
  ) {
    diagnostics.push(
      diag(
        "INVALID_SCHEMA",
        "lowering",
        "Profile lowering mode is not recognized."
      )
    );
  }
  if (typeof manifest.portable !== "boolean") {
    diagnostics.push(
      diag("INVALID_SCHEMA", "portable", "Profile portable must be boolean.")
    );
  }

  if (
    parsedRef &&
    (manifest.namespace !== parsedRef.namespace ||
      manifest.name !== parsedRef.name)
  ) {
    diagnostics.push(
      diag(
        "INVALID_PROFILE_REF",
        "ref",
        "Profile ref must match namespace and name fields."
      )
    );
  }

  const version =
    typeof manifest.version === "string"
      ? parseExactSemver(manifest.version)
      : null;
  if (!version) {
    diagnostics.push(
      diag(
        "INVALID_VERSION",
        "version",
        "Profile version must be an exact semantic version."
      )
    );
  } else if (parsedRef && version.major !== parsedRef.major) {
    diagnostics.push(
      diag(
        "PROFILE_MAJOR_MISMATCH",
        "version",
        "Profile version major must match the @major ref suffix."
      )
    );
  }

  if (manifest.namespace === "dzup" && manifest.owner !== "dzupagent") {
    diagnostics.push(
      diag(
        "RESERVED_NAMESPACE_OWNER_MISMATCH",
        "owner",
        "The dzup namespace is reserved for the DzupAgent owner."
      )
    );
  }
  if (manifest.namespace === "codev" && manifest.owner !== "codev") {
    diagnostics.push(
      diag(
        "RESERVED_NAMESPACE_OWNER_MISMATCH",
        "owner",
        "The codev namespace is reserved for the Codev owner."
      )
    );
  }

  if (manifest.kind === "kernel" && manifest.ref !== "dzup.core@1") {
    diagnostics.push(
      diag(
        "INVALID_KERNEL_PROFILE",
        "kind",
        "Only dzup.core@1 may declare kernel profile kind."
      )
    );
  }
  if (manifest.ref === "dzup.core@1" && manifest.kind !== "kernel") {
    diagnostics.push(
      diag(
        "INVALID_KERNEL_PROFILE",
        "kind",
        "dzup.core@1 must declare kernel profile kind."
      )
    );
  }
  if (
    manifest.ref === "dzup.core@1" &&
    (manifest.lowering !== "core-ir" || manifest.portable !== true)
  ) {
    diagnostics.push(
      diag(
        "INVALID_KERNEL_PROFILE",
        "lowering",
        "dzup.core@1 must use portable core-ir lowering."
      )
    );
  }

  const nodeKinds = Array.isArray(manifest.nodeKinds) ? manifest.nodeKinds : [];
  if (!Array.isArray(manifest.nodeKinds)) {
    diagnostics.push(
      diag("INVALID_SCHEMA", "nodeKinds", "Profile nodeKinds must be an array.")
    );
  }
  addDuplicateDiagnostics(
    nodeKinds,
    "nodeKinds",
    "DUPLICATE_NODE_KIND",
    diagnostics
  );
  const knownNodeKinds = new Set<string>(FLOW_NODE_KINDS);
  nodeKinds.forEach((kind, index) => {
    if (typeof kind !== "string" || !knownNodeKinds.has(kind)) {
      diagnostics.push(
        diag(
          "UNKNOWN_NODE_KIND",
          `nodeKinds[${index}]`,
          `Unknown flow node kind: ${String(kind)}`
        )
      );
    }
  });

  const capabilities = Array.isArray(manifest.capabilities)
    ? manifest.capabilities
    : [];
  if (!Array.isArray(manifest.capabilities)) {
    diagnostics.push(
      diag(
        "INVALID_SCHEMA",
        "capabilities",
        "Profile capabilities must be an array."
      )
    );
  }
  addDuplicateDiagnostics(
    capabilities,
    "capabilities",
    "DUPLICATE_CAPABILITY",
    diagnostics
  );
  capabilities.forEach((capability, index) => {
    if (typeof capability !== "string" || capability.length === 0) {
      diagnostics.push(
        diag(
          "INVALID_SCHEMA",
          `capabilities[${index}]`,
          "Capability ids must be non-empty strings."
        )
      );
    }
  });

  const dependencies = Array.isArray(manifest.dependencies)
    ? manifest.dependencies
    : [];
  if (!Array.isArray(manifest.dependencies)) {
    diagnostics.push(
      diag(
        "INVALID_SCHEMA",
        "dependencies",
        "Profile dependencies must be an array."
      )
    );
  }
  addDuplicateDiagnostics(
    dependencies,
    "dependencies",
    "DUPLICATE_DEPENDENCY",
    diagnostics
  );
  dependencies.forEach((dependency, index) => {
    if (dependency === manifest.ref) {
      diagnostics.push(
        diag(
          "SELF_DEPENDENCY",
          `dependencies[${index}]`,
          "A profile cannot depend on itself."
        )
      );
    }
    if (typeof dependency !== "string" || !parseProfileRef(dependency)) {
      diagnostics.push(
        diag(
          "INVALID_PROFILE_REF",
          `dependencies[${index}]`,
          "Dependency must use namespace.name@major."
        )
      );
    }
  });
  if (manifest.kind === "extension" && !dependencies.includes("dzup.core@1")) {
    diagnostics.push(
      diag(
        "MISSING_CORE_DEPENDENCY",
        "dependencies",
        "Extension profiles must depend on dzup.core@1."
      )
    );
  }
  if (manifest.ref === "dzup.core@1" && dependencies.length > 0) {
    diagnostics.push(
      diag(
        "INVALID_KERNEL_PROFILE",
        "dependencies",
        "dzup.core@1 cannot depend on extension profiles."
      )
    );
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

export function createFlowProfileLock(
  manifests: FlowProfileManifest[] = Object.values(FLOW_PROFILE_MANIFESTS)
): FlowProfileLock {
  return {
    schema: "dzupagent.flowProfileLock/v1",
    profiles: [...manifests]
      .sort((left, right) => left.ref.localeCompare(right.ref))
      .map((manifest) => ({
        ref: manifest.ref,
        version: manifest.version,
        manifestHash: hashFlowProfileManifest(manifest),
      })),
  };
}

export function validateFlowProfileLock(
  lock: unknown,
  manifests: Record<string, FlowProfileManifest> = FLOW_PROFILE_MANIFESTS
): FlowProfileValidationResult {
  const diagnostics: FlowProfileDiagnostic[] = [];
  if (
    !isRecord(lock) ||
    lock.schema !== "dzupagent.flowProfileLock/v1" ||
    !Array.isArray(lock.profiles)
  ) {
    return invalid(
      "INVALID_SCHEMA",
      "root",
      "Profile lock must use dzupagent.flowProfileLock/v1."
    );
  }

  const seen = new Set<string>();
  lock.profiles.forEach((entry, index) => {
    const path = `profiles[${index}]`;
    if (!isRecord(entry) || typeof entry.ref !== "string") {
      diagnostics.push(
        diag(
          "INVALID_PROFILE_REF",
          `${path}.ref`,
          "Lock entry requires a profile ref."
        )
      );
      return;
    }
    if (seen.has(entry.ref)) {
      diagnostics.push(
        diag(
          "DUPLICATE_LOCK_ENTRY",
          `${path}.ref`,
          `Duplicate lock entry: ${entry.ref}`
        )
      );
    }
    seen.add(entry.ref);

    const manifest = manifests[entry.ref];
    if (!manifest) {
      diagnostics.push(
        diag(
          "UNKNOWN_LOCK_PROFILE",
          `${path}.ref`,
          `Unknown locked profile: ${entry.ref}`
        )
      );
      return;
    }
    if (
      entry.version !== manifest.version ||
      !parseExactSemver(String(entry.version ?? ""))
    ) {
      diagnostics.push(
        diag(
          "LOCK_VERSION_MISMATCH",
          `${path}.version`,
          `Locked version must equal ${manifest.version}.`
        )
      );
    }
    if (
      typeof entry.manifestHash !== "string" ||
      !SHA256_PATTERN.test(entry.manifestHash)
    ) {
      diagnostics.push(
        diag(
          "INVALID_MANIFEST_HASH",
          `${path}.manifestHash`,
          "Manifest hash must use sha256:<64 lowercase hex>."
        )
      );
    } else if (entry.manifestHash !== hashFlowProfileManifest(manifest)) {
      diagnostics.push(
        diag(
          "MANIFEST_HASH_MISMATCH",
          `${path}.manifestHash`,
          "Locked manifest hash does not match the manifest."
        )
      );
    }
  });

  return { valid: diagnostics.length === 0, diagnostics };
}
