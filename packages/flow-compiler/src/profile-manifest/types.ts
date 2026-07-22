import { type FlowNodeKind } from "@dzupagent/flow-ast";

import { type FlowCapabilityOwner } from "../capability-manifest.js";

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
