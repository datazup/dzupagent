#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_EFFECTS,
  validateProviderSessionAttemptBinding,
} from "../dist/provider-session.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(root, "fixtures", "provider-session-conformance-v1.json");
const corpus = JSON.parse(await readFile(fixturePath, "utf8"));

if (
  corpus.schema !== "dzupagent.providerSessionConformanceCorpus/v1"
  || !Array.isArray(corpus.profiles)
  || corpus.profiles.length !== 4
) {
  throw new Error("Provider-session conformance corpus schema or profiles are invalid");
}

for (const profile of corpus.profiles) {
  const binding = materializeBinding(profile, corpus.authority);
  const roundTripped = JSON.parse(JSON.stringify(binding));
  const result = validateProviderSessionAttemptBinding(
    roundTripped,
    profile.requiredCapabilities,
  );
  if (result.valid !== profile.expectedValid) {
    throw new Error(
      `Provider-session conformance case ${String(profile.id)} failed: `
      + result.diagnostics.map(({ code }) => code).join(", "),
    );
  }
}

if (
  corpus.boundaries?.providerCalls !== 0
  || corpus.boundaries?.credentialsIncluded !== false
  || corpus.boundaries?.protocolObjectsIncluded !== false
) {
  throw new Error("Provider-session conformance boundary is unsafe");
}

console.log(`Provider-session conformance fixture passed (${corpus.profiles.length} cases).`);

function materializeBinding(profile, authority) {
  const native = new Set(profile.nativeCapabilities);
  return {
    schema: PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
    bindingId: `fixture-binding-${profile.id}`,
    executionAttemptId: `fixture-attempt-${profile.id}`,
    authSourceRef: `auth-source://fixture/${profile.id}`,
    descriptor: {
      schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      descriptorId: `fixture-descriptor-${profile.id}`,
      providerId: profile.providerId,
      backend: profile.backend,
      capabilities: Object.fromEntries(PROVIDER_SESSION_CAPABILITIES.map((capability) => [
        capability,
        native.has(capability)
          ? { status: "native", emulation: "forbidden" }
          : { status: "unsupported", emulation: "forbidden", reason: "Backend fixture does not expose this capability." },
      ])),
      observedAt: "2026-08-09T00:00:00.000Z",
      evidenceRef: `evidence://provider-session/${profile.id}`,
    },
    effectAuthorities: Object.fromEntries(PROVIDER_SESSION_EFFECTS.map((effect) => [
      effect,
      { effect, ...authority },
    ])),
    boundAt: "2026-08-09T00:00:00.000Z",
  };
}
