export const FLOW_CREDENTIAL_HANDLE_SCHEMA =
  "dzupagent.flowCredentialHandle/v1" as const;
export const FLOW_CREDENTIAL_LEASE_SCHEMA =
  "dzupagent.flowCredentialLease/v1" as const;

export type FlowCredentialResolutionStatus =
  | "resolved"
  | "denied"
  | "unavailable"
  | "expired";

const credentialHandleBrand: unique symbol = Symbol(
  "dzupagent.flowCredentialHandle",
);

export interface FlowCredentialHandleDescriptor {
  readonly schema: typeof FLOW_CREDENTIAL_HANDLE_SCHEMA;
  readonly handleId: string;
  readonly bindingRef: string;
  readonly capabilityRef: string;
  readonly provider?: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string;
}

/**
 * Host-created credential identity. It contains routing metadata only, never
 * secret material. The private symbol prevents plain authored objects from
 * satisfying the runtime handle contract.
 */
export type FlowCredentialHandle = Readonly<FlowCredentialHandleDescriptor> & {
  readonly [credentialHandleBrand]: true;
};

interface FlowCredentialUseBase {
  readonly inputPath: string;
  readonly capabilityRef: string;
  readonly runId?: string;
  readonly attemptId?: string;
}

/** Exact portable subject that is authorized to consume one credential lease. */
export type FlowCredentialUse = FlowCredentialUseBase &
  (
    | {
        readonly primitiveRef: `primitive://${string}@${string}`;
        readonly toolRef?: never;
      }
    | {
        readonly toolRef: string;
        readonly primitiveRef?: never;
      }
  );

export interface FlowCredentialLease {
  readonly schema: typeof FLOW_CREDENTIAL_LEASE_SCHEMA;
  readonly leaseId: string;
  readonly handleId: string;
  readonly capabilityRef: string;
  readonly expiresAt?: string;
}

export type FlowCredentialResolution =
  | {
      readonly status: "resolved";
      readonly lease: FlowCredentialLease;
    }
  | {
      readonly status: Exclude<FlowCredentialResolutionStatus, "resolved">;
      readonly code: string;
      readonly message?: string;
    };

/**
 * The portable resolver boundary returns a lease reference only. Provider or
 * connector hosts may dereference that lease internally, but raw credential
 * material never crosses this interface.
 */
export interface FlowCredentialHandleResolver {
  resolve(
    handle: FlowCredentialHandle,
    use: FlowCredentialUse,
  ): Promise<FlowCredentialResolution>;
  release?(lease: FlowCredentialLease): Promise<void>;
}

/** Create a frozen nominal handle while copying routing metadata only. */
export function createFlowCredentialHandle(
  descriptor: FlowCredentialHandleDescriptor,
): FlowCredentialHandle {
  const issues = validateCredentialDescriptor(descriptor);
  if (issues.length > 0) {
    throw new TypeError(`invalid credential handle: ${issues.join("; ")}`);
  }
  const handle = {
    schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
    handleId: descriptor.handleId,
    bindingRef: descriptor.bindingRef,
    capabilityRef: descriptor.capabilityRef,
    ...(descriptor.provider === undefined
      ? {}
      : { provider: descriptor.provider }),
    scopes: Object.freeze([...descriptor.scopes]),
    ...(descriptor.expiresAt === undefined
      ? {}
      : { expiresAt: descriptor.expiresAt }),
  };
  Object.defineProperty(handle, credentialHandleBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(handle) as FlowCredentialHandle;
}

export function isFlowCredentialHandle(
  value: unknown,
): value is FlowCredentialHandle {
  return (
    isRecord(value) &&
    value[credentialHandleBrand] === true &&
    validateCredentialDescriptor(value).length === 0
  );
}

function validateCredentialDescriptor(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["descriptor must be an object"];
  if (value.schema !== FLOW_CREDENTIAL_HANDLE_SCHEMA) {
    issues.push(`schema must be ${FLOW_CREDENTIAL_HANDLE_SCHEMA}`);
  }
  requireString(value, "handleId", issues);
  requireString(value, "bindingRef", issues);
  requireString(value, "capabilityRef", issues);
  if (
    nonEmptyString(value.bindingRef) &&
    !value.bindingRef.startsWith("binding://")
  ) {
    issues.push("bindingRef must be a binding URI");
  }
  if (value.provider !== undefined && !nonEmptyString(value.provider)) {
    issues.push("provider must be a non-empty string when present");
  }
  if (
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => !nonEmptyString(scope))
  ) {
    issues.push("scopes must contain only non-empty strings");
  } else if (new Set(value.scopes).size !== value.scopes.length) {
    issues.push("scopes cannot contain duplicates");
  }
  if (value.expiresAt !== undefined && !validDate(value.expiresAt)) {
    issues.push("expiresAt must be an RFC 3339 date-time when present");
  }
  return issues;
}

function requireString(
  value: Record<PropertyKey, unknown>,
  key: string,
  issues: string[],
): void {
  if (!nonEmptyString(value[key])) {
    issues.push(`${key} must be a non-empty string`);
  }
}

function validDate(value: unknown): boolean {
  return (
    nonEmptyString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
