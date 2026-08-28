/**
 * ARCH27-T-09: `AgentSignedExecutionPolicy` is a hand-written structural
 * transport for the canonical `SignedExecutionPolicy` in
 * `@dzupagent/execution-contracts` (a dev-only dependency here — adapter-types
 * stays a layer-0 leaf with no production edge). Before this pin the canonical
 * side had already drifted (the V2 temporal-validity change added
 * `issuedAt`/`expiresAt`/`maxCostUsd`) with nothing failing.
 *
 * The type-level pins below make the next drift a `tsc --noEmit` error in this
 * package: every canonical value must stay assignable to the mirror, and the
 * key sets must match exactly at every nesting level.
 */

import { describe, expect, it } from "vitest";
import {
  buildCommandCatalog,
  buildSignedExecutionPolicy,
  RESOURCE_POLICY_VERSION,
  type CatalogEntry,
  type CommandCatalog,
  type EgressGrant,
  type ResourcePolicy,
  type SignedExecutionPolicy,
} from "@dzupagent/execution-contracts";

import type { AgentSignedExecutionPolicy } from "../contracts/execution.js";

type Assert<T extends true> = T;
type MirrorAccepts<Canonical, Mirror> = [Canonical] extends [Mirror]
  ? true
  : false;
type SameKeys<A, B> = [Exclude<keyof A, keyof B>] extends [never]
  ? [Exclude<keyof B, keyof A>] extends [never]
    ? true
    : false
  : false;

type MirrorPolicy = AgentSignedExecutionPolicy["policy"];
type MirrorCatalog = AgentSignedExecutionPolicy["catalog"];
type MirrorEntry = MirrorCatalog["entries"][number];
type MirrorGrant = MirrorPolicy["egressGrants"][number];

// Compile-time conformance pins. A canonical field rename/addition/removal, or
// a mirror shape the canonical value can no longer satisfy, fails typecheck.
export type SignedExecutionPolicyConformancePins = [
  Assert<MirrorAccepts<SignedExecutionPolicy, AgentSignedExecutionPolicy>>,
  Assert<SameKeys<SignedExecutionPolicy, AgentSignedExecutionPolicy>>,
  Assert<SameKeys<ResourcePolicy, MirrorPolicy>>,
  Assert<SameKeys<CommandCatalog, MirrorCatalog>>,
  Assert<SameKeys<CatalogEntry, MirrorEntry>>,
  Assert<SameKeys<EgressGrant, MirrorGrant>>,
];

describe("AgentSignedExecutionPolicy conformance (ARCH27-T-09)", () => {
  it("accepts a canonically built signed policy verbatim", () => {
    const catalog = buildCommandCatalog([
      {
        binary: "git",
        allowedArgs: ["status"],
        workdirPolicy: "checkout-only",
      },
    ]);
    const policy: ResourcePolicy = {
      version: RESOURCE_POLICY_VERSION,
      policyId: "conformance-probe",
      wallTimeSec: 60,
      egressGrants: [{ provider: "mcp-gateway", label: "gateway" }],
    };
    const canonical = buildSignedExecutionPolicy(policy, catalog);
    const transported: AgentSignedExecutionPolicy = canonical;
    expect(transported.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(transported.policy.policyId).toBe("conformance-probe");
    expect(transported.catalog.digest).toBe(catalog.digest);
  });
});
