#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITIES_V1,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1,
  PROVIDER_SESSION_EFFECTS,
  PROVIDER_SESSION_EFFECTS_V1,
  validateProviderSessionAttemptBinding,
} from "../dist/provider-session.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(root, "fixtures", "provider-session-conformance-v2.json");
const legacyFixturePath = join(root, "fixtures", "provider-session-conformance-v1.json");
const corpus = JSON.parse(await readFile(fixturePath, "utf8"));
const legacyCorpus = JSON.parse(await readFile(legacyFixturePath, "utf8"));

if (
  corpus.schema !== "dzupagent.providerSessionConformanceCorpus/v2"
  || !Array.isArray(corpus.profiles)
  || corpus.profiles.length !== 4
) {
  throw new Error("Provider-session conformance corpus schema or profiles are invalid");
}

if (
  legacyCorpus.schema !== "dzupagent.providerSessionConformanceCorpus/v1"
  || !Array.isArray(legacyCorpus.profiles)
  || legacyCorpus.profiles.length !== 4
) {
  throw new Error("Provider-session v1 compatibility corpus schema or profiles are invalid");
}

for (const profile of corpus.profiles) {
  const binding = materializeBinding(profile, corpus.authority, false);
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

for (const profile of legacyCorpus.profiles) {
  const binding = materializeBinding(profile, legacyCorpus.authority, true);
  const result = validateProviderSessionAttemptBinding(
    JSON.parse(JSON.stringify(binding)),
    profile.requiredCapabilities,
  );
  if (result.valid !== profile.expectedValid) {
    throw new Error(
      `Provider-session v1 compatibility case ${String(profile.id)} failed: `
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

console.log(
  `Provider-session conformance fixtures passed (${corpus.profiles.length} v2; `
  + `${legacyCorpus.profiles.length} v1 compatibility cases).`,
);

function materializeBinding(profile, authority, legacy) {
  const capabilities = legacy
    ? PROVIDER_SESSION_CAPABILITIES_V1
    : PROVIDER_SESSION_CAPABILITIES;
  const effects = legacy ? PROVIDER_SESSION_EFFECTS_V1 : PROVIDER_SESSION_EFFECTS;
  const native = new Set(profile.nativeCapabilities);
  return {
    schema: legacy
      ? PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1
      : PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
    bindingId: `fixture-binding-${profile.id}`,
    executionAttemptId: `fixture-attempt-${profile.id}`,
    authSourceRef: `auth-source://fixture/${profile.id}`,
    descriptor: {
      schema: legacy
        ? PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1
        : PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      descriptorId: `fixture-descriptor-${profile.id}`,
      providerId: profile.providerId,
      backend: profile.backend,
      capabilities: Object.fromEntries(capabilities.map((capability) => [
        capability,
        native.has(capability)
          ? { status: "native", emulation: "forbidden" }
          : { status: "unsupported", emulation: "forbidden", reason: "Backend fixture does not expose this capability." },
      ])),
      observedAt: "2026-08-09T00:00:00.000Z",
      evidenceRef: `evidence://provider-session/${profile.id}`,
    },
    effectAuthorities: Object.fromEntries(effects.map((effect) => [
      effect,
      { effect, ...authority },
    ])),
    boundAt: "2026-08-09T00:00:00.000Z",
  };
}
