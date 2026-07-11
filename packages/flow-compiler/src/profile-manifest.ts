import { createHash } from "node:crypto";

import { FLOW_NODE_KINDS, type FlowNodeKind } from "@dzupagent/flow-ast";

import {
  FLOW_NODE_CAPABILITY_REGISTRY,
  type FlowCapabilityOwner,
  type RecommendedFlowProfile,
} from "./capability-manifest.js";

export type FlowProfileKind = "kernel" | "extension";
export type FlowProfileLowering = "core-ir" | "opaque-host-action";

export interface FlowProfileManifest {
  schema: "dzupagent.flowProfileManifest/v1";
  ref: string;
  namespace: string;
  name: string;
  version: string;
  kind: FlowProfileKind;
  owner: FlowCapabilityOwner;
  lowering: FlowProfileLowering;
  portable: boolean;
  nodeKinds: FlowNodeKind[];
  capabilities: string[];
  dependencies: string[];
}

export interface FlowProfileLockEntry {
  ref: string;
  version: string;
  manifestHash: string;
}

export interface FlowProfileLock {
  schema: "dzupagent.flowProfileLock/v1";
  profiles: FlowProfileLockEntry[];
}

export type FlowProfileDiagnosticCode =
  | "INVALID_SCHEMA"
  | "INVALID_PROFILE_REF"
  | "INVALID_NAMESPACE"
  | "INVALID_VERSION"
  | "PROFILE_MAJOR_MISMATCH"
  | "RESERVED_NAMESPACE_OWNER_MISMATCH"
  | "INVALID_KERNEL_PROFILE"
  | "MISSING_CORE_DEPENDENCY"
  | "DUPLICATE_NODE_KIND"
  | "UNKNOWN_NODE_KIND"
  | "DUPLICATE_CAPABILITY"
  | "DUPLICATE_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "DUPLICATE_LOCK_ENTRY"
  | "UNKNOWN_LOCK_PROFILE"
  | "LOCK_VERSION_MISMATCH"
  | "INVALID_MANIFEST_HASH"
  | "MANIFEST_HASH_MISMATCH";

export interface FlowProfileDiagnostic {
  code: FlowProfileDiagnosticCode;
  path: string;
  message: string;
}

export interface FlowProfileValidationResult {
  valid: boolean;
  diagnostics: FlowProfileDiagnostic[];
}

interface ProfileDefinition {
  namespace: string;
  name: string;
  owner: FlowCapabilityOwner;
  lowering: FlowProfileLowering;
  portable: boolean;
}

export const FLOW_PROFILE_MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "dzupagent.flowProfileManifest/v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "ref",
    "namespace",
    "name",
    "version",
    "kind",
    "owner",
    "lowering",
    "portable",
    "nodeKinds",
    "capabilities",
    "dependencies",
  ],
  properties: {
    schema: { const: "dzupagent.flowProfileManifest/v1" },
    ref: { type: "string", pattern: "^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*@[1-9][0-9]*$" },
    namespace: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    name: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    version: {
      type: "string",
      pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
    },
    kind: { enum: ["kernel", "extension"] },
    owner: { enum: ["dzupagent", "host", "codev"] },
    lowering: { enum: ["core-ir", "opaque-host-action"] },
    portable: { type: "boolean" },
    nodeKinds: { type: "array", uniqueItems: true, items: { enum: FLOW_NODE_KINDS } },
    capabilities: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    dependencies: { type: "array", uniqueItems: true, items: { type: "string" } },
  },
} as const;

export const FLOW_PROFILE_LOCK_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "dzupagent.flowProfileLock/v1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "profiles"],
  properties: {
    schema: { const: "dzupagent.flowProfileLock/v1" },
    profiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "version", "manifestHash"],
        properties: {
          ref: { type: "string", pattern: "^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*@[1-9][0-9]*$" },
          version: { type: "string" },
          manifestHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        },
      },
    },
  },
} as const;

const PROFILE_DEFINITIONS = {
  "dzup.core@1": {
    namespace: "dzup",
    name: "core",
    owner: "dzupagent",
    lowering: "core-ir",
    portable: true,
  },
  "dzup.llm@1": {
    namespace: "dzup",
    name: "llm",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.agent@1": {
    namespace: "dzup",
    name: "agent",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.adapters@1": {
    namespace: "dzup",
    name: "adapters",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.sdlc@1": {
    namespace: "dzup",
    name: "sdlc",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.rag@1": {
    namespace: "dzup",
    name: "rag",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "dzup.fleet@1": {
    namespace: "dzup",
    name: "fleet",
    owner: "dzupagent",
    lowering: "opaque-host-action",
    portable: false,
  },
  "codev.spdd@1": {
    namespace: "codev",
    name: "spdd",
    owner: "codev",
    lowering: "opaque-host-action",
    portable: false,
  },
} as const satisfies Record<RecommendedFlowProfile, ProfileDefinition>;

export const FLOW_PROFILE_MANIFESTS = Object.fromEntries(
  Object.entries(PROFILE_DEFINITIONS).map(([ref, definition]) => {
    const profileRef = ref as RecommendedFlowProfile;
    const descriptors = Object.values(FLOW_NODE_CAPABILITY_REGISTRY).filter(
      (descriptor) => descriptor.recommendedProfile === profileRef,
    );
    const manifest: FlowProfileManifest = {
      schema: "dzupagent.flowProfileManifest/v1",
      ref: profileRef,
      namespace: definition.namespace,
      name: definition.name,
      version: "1.0.0",
      kind: profileRef === "dzup.core@1" ? "kernel" : "extension",
      owner: definition.owner,
      lowering: definition.lowering,
      portable: definition.portable,
      nodeKinds: descriptors.map((descriptor) => descriptor.kind).sort(),
      capabilities: [
        ...new Set(descriptors.flatMap((descriptor) => descriptor.runtimeCapabilities)),
      ].sort(),
      dependencies: profileRef === "dzup.core@1" ? [] : ["dzup.core@1"],
    };
    return [profileRef, manifest];
  }),
) as Record<RecommendedFlowProfile, FlowProfileManifest>;

export function validateFlowProfileManifest(
  manifest: unknown,
): FlowProfileValidationResult {
  const diagnostics: FlowProfileDiagnostic[] = [];
  if (!isRecord(manifest)) {
    return invalid("INVALID_SCHEMA", "root", "Profile manifest must be an object.");
  }

  if (manifest.schema !== "dzupagent.flowProfileManifest/v1") {
    diagnostics.push(diag("INVALID_SCHEMA", "schema", "Unsupported flow profile manifest schema."));
  }

  const parsedRef = typeof manifest.ref === "string" ? parseProfileRef(manifest.ref) : null;
  if (!parsedRef) {
    diagnostics.push(diag("INVALID_PROFILE_REF", "ref", "Profile ref must use namespace.name@major."));
  }

  if (typeof manifest.namespace !== "string" || !PROFILE_NAMESPACE_PATTERN.test(manifest.namespace)) {
    diagnostics.push(diag("INVALID_NAMESPACE", "namespace", "Namespace must be lowercase kebab-case."));
  }
  if (typeof manifest.name !== "string" || !PROFILE_NAMESPACE_PATTERN.test(manifest.name)) {
    diagnostics.push(diag("INVALID_SCHEMA", "name", "Profile name must be lowercase kebab-case."));
  }
  if (!isFlowCapabilityOwner(manifest.owner)) {
    diagnostics.push(diag("INVALID_SCHEMA", "owner", "Profile owner is not recognized."));
  }
  if (manifest.kind !== "kernel" && manifest.kind !== "extension") {
    diagnostics.push(diag("INVALID_SCHEMA", "kind", "Profile kind must be kernel or extension."));
  }
  if (manifest.lowering !== "core-ir" && manifest.lowering !== "opaque-host-action") {
    diagnostics.push(diag("INVALID_SCHEMA", "lowering", "Profile lowering mode is not recognized."));
  }
  if (typeof manifest.portable !== "boolean") {
    diagnostics.push(diag("INVALID_SCHEMA", "portable", "Profile portable must be boolean."));
  }

  if (
    parsedRef &&
    (manifest.namespace !== parsedRef.namespace || manifest.name !== parsedRef.name)
  ) {
    diagnostics.push(diag("INVALID_PROFILE_REF", "ref", "Profile ref must match namespace and name fields."));
  }

  const version = typeof manifest.version === "string" ? parseExactSemver(manifest.version) : null;
  if (!version) {
    diagnostics.push(diag("INVALID_VERSION", "version", "Profile version must be an exact semantic version."));
  } else if (parsedRef && version.major !== parsedRef.major) {
    diagnostics.push(
      diag("PROFILE_MAJOR_MISMATCH", "version", "Profile version major must match the @major ref suffix."),
    );
  }

  if (manifest.namespace === "dzup" && manifest.owner !== "dzupagent") {
    diagnostics.push(
      diag(
        "RESERVED_NAMESPACE_OWNER_MISMATCH",
        "owner",
        "The dzup namespace is reserved for the DzupAgent owner.",
      ),
    );
  }
  if (manifest.namespace === "codev" && manifest.owner !== "codev") {
    diagnostics.push(
      diag(
        "RESERVED_NAMESPACE_OWNER_MISMATCH",
        "owner",
        "The codev namespace is reserved for the Codev owner.",
      ),
    );
  }

  if (manifest.kind === "kernel" && manifest.ref !== "dzup.core@1") {
    diagnostics.push(
      diag("INVALID_KERNEL_PROFILE", "kind", "Only dzup.core@1 may declare kernel profile kind."),
    );
  }
  if (manifest.ref === "dzup.core@1" && manifest.kind !== "kernel") {
    diagnostics.push(
      diag("INVALID_KERNEL_PROFILE", "kind", "dzup.core@1 must declare kernel profile kind."),
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
        "dzup.core@1 must use portable core-ir lowering.",
      ),
    );
  }

  const nodeKinds = Array.isArray(manifest.nodeKinds) ? manifest.nodeKinds : [];
  if (!Array.isArray(manifest.nodeKinds)) {
    diagnostics.push(diag("INVALID_SCHEMA", "nodeKinds", "Profile nodeKinds must be an array."));
  }
  addDuplicateDiagnostics(nodeKinds, "nodeKinds", "DUPLICATE_NODE_KIND", diagnostics);
  const knownNodeKinds = new Set<string>(FLOW_NODE_KINDS);
  nodeKinds.forEach((kind, index) => {
    if (typeof kind !== "string" || !knownNodeKinds.has(kind)) {
      diagnostics.push(diag("UNKNOWN_NODE_KIND", `nodeKinds[${index}]`, `Unknown flow node kind: ${String(kind)}`));
    }
  });

  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (!Array.isArray(manifest.capabilities)) {
    diagnostics.push(diag("INVALID_SCHEMA", "capabilities", "Profile capabilities must be an array."));
  }
  addDuplicateDiagnostics(capabilities, "capabilities", "DUPLICATE_CAPABILITY", diagnostics);
  capabilities.forEach((capability, index) => {
    if (typeof capability !== "string" || capability.length === 0) {
      diagnostics.push(
        diag("INVALID_SCHEMA", `capabilities[${index}]`, "Capability ids must be non-empty strings."),
      );
    }
  });

  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  if (!Array.isArray(manifest.dependencies)) {
    diagnostics.push(diag("INVALID_SCHEMA", "dependencies", "Profile dependencies must be an array."));
  }
  addDuplicateDiagnostics(dependencies, "dependencies", "DUPLICATE_DEPENDENCY", diagnostics);
  dependencies.forEach((dependency, index) => {
    if (dependency === manifest.ref) {
      diagnostics.push(diag("SELF_DEPENDENCY", `dependencies[${index}]`, "A profile cannot depend on itself."));
    }
    if (typeof dependency !== "string" || !parseProfileRef(dependency)) {
      diagnostics.push(
        diag("INVALID_PROFILE_REF", `dependencies[${index}]`, "Dependency must use namespace.name@major."),
      );
    }
  });
  if (
    manifest.kind === "extension" &&
    !dependencies.includes("dzup.core@1")
  ) {
    diagnostics.push(
      diag(
        "MISSING_CORE_DEPENDENCY",
        "dependencies",
        "Extension profiles must depend on dzup.core@1.",
      ),
    );
  }
  if (manifest.ref === "dzup.core@1" && dependencies.length > 0) {
    diagnostics.push(
      diag(
        "INVALID_KERNEL_PROFILE",
        "dependencies",
        "dzup.core@1 cannot depend on extension profiles.",
      ),
    );
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

export function createFlowProfileLock(
  manifests: FlowProfileManifest[] = Object.values(FLOW_PROFILE_MANIFESTS),
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
  manifests: Record<string, FlowProfileManifest> = FLOW_PROFILE_MANIFESTS,
): FlowProfileValidationResult {
  const diagnostics: FlowProfileDiagnostic[] = [];
  if (!isRecord(lock) || lock.schema !== "dzupagent.flowProfileLock/v1" || !Array.isArray(lock.profiles)) {
    return invalid("INVALID_SCHEMA", "root", "Profile lock must use dzupagent.flowProfileLock/v1.");
  }

  const seen = new Set<string>();
  lock.profiles.forEach((entry, index) => {
    const path = `profiles[${index}]`;
    if (!isRecord(entry) || typeof entry.ref !== "string") {
      diagnostics.push(diag("INVALID_PROFILE_REF", `${path}.ref`, "Lock entry requires a profile ref."));
      return;
    }
    if (seen.has(entry.ref)) {
      diagnostics.push(diag("DUPLICATE_LOCK_ENTRY", `${path}.ref`, `Duplicate lock entry: ${entry.ref}`));
    }
    seen.add(entry.ref);

    const manifest = manifests[entry.ref];
    if (!manifest) {
      diagnostics.push(diag("UNKNOWN_LOCK_PROFILE", `${path}.ref`, `Unknown locked profile: ${entry.ref}`));
      return;
    }
    if (entry.version !== manifest.version || !parseExactSemver(String(entry.version ?? ""))) {
      diagnostics.push(
        diag("LOCK_VERSION_MISMATCH", `${path}.version`, `Locked version must equal ${manifest.version}.`),
      );
    }
    if (typeof entry.manifestHash !== "string" || !SHA256_PATTERN.test(entry.manifestHash)) {
      diagnostics.push(
        diag("INVALID_MANIFEST_HASH", `${path}.manifestHash`, "Manifest hash must use sha256:<64 lowercase hex>."),
      );
    } else if (entry.manifestHash !== hashFlowProfileManifest(manifest)) {
      diagnostics.push(
        diag("MANIFEST_HASH_MISMATCH", `${path}.manifestHash`, "Locked manifest hash does not match the manifest."),
      );
    }
  });

  return { valid: diagnostics.length === 0, diagnostics };
}

export function hashFlowProfileManifest(manifest: FlowProfileManifest): string {
  const normalized = {
    ...manifest,
    nodeKinds: [...manifest.nodeKinds].sort(),
    capabilities: [...manifest.capabilities].sort(),
    dependencies: [...manifest.dependencies].sort(),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(normalized))).digest("hex")}`;
}

const PROFILE_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
const PROFILE_REF_PATTERN = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;
const EXACT_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function parseProfileRef(ref: string): { namespace: string; name: string; major: number } | null {
  const match = PROFILE_REF_PATTERN.exec(ref);
  return match && match[1] && match[2] && match[3]
    ? { namespace: match[1], name: match[2], major: Number(match[3]) }
    : null;
}

function parseExactSemver(version: string): { major: number } | null {
  const match = EXACT_SEMVER_PATTERN.exec(version);
  return match && match[1] ? { major: Number(match[1]) } : null;
}

function addDuplicateDiagnostics(
  values: unknown[],
  path: string,
  code:
    | "DUPLICATE_NODE_KIND"
    | "DUPLICATE_CAPABILITY"
    | "DUPLICATE_DEPENDENCY",
  diagnostics: FlowProfileDiagnostic[],
): void {
  const seen = new Set<unknown>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      diagnostics.push(diag(code, `${path}[${index}]`, `Duplicate value: ${String(value)}`));
    }
    seen.add(value);
  });
}

function isFlowCapabilityOwner(value: unknown): value is FlowCapabilityOwner {
  return value === "dzupagent" || value === "host" || value === "codev";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diag(code: FlowProfileDiagnosticCode, path: string, message: string): FlowProfileDiagnostic {
  return { code, path, message };
}

function invalid(code: FlowProfileDiagnosticCode, path: string, message: string): FlowProfileValidationResult {
  return { valid: false, diagnostics: [diag(code, path, message)] };
}
