# @dzupagent/flow-compiler

Flow compiler for DzupAgent — compiles flow-ast into skill-chain, workflow-builder, or pipeline artifacts

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import { createFlowCompiler, routeTarget } from '@dzupagent/flow-compiler'
```

## Classified references and secret-flow checks

Documents may classify inputs as `public`, `internal`, `sensitive`, or
`secret`. Hosts can classify late-bound values and reviewed step ports through
`referenceClassificationBindings` and
`referencePortClassificationBindings`.

```ts
const compiler = createFlowCompiler({
  toolResolver,
  referencePolicy: 'strict',
  referenceBindings: { context: ['tenantId'], secrets: ['apiKey'] },
  referenceClassificationBindings: {
    context: { tenantId: 'internal' },
  },
  referencePortClassificationBindings: {
    loadCustomer: { result: 'sensitive' },
  },
})
```

Classifications merge monotonically; the most restrictive declaration wins,
and every declared `secrets.*` reference is automatically `secret`. The
compiler conservatively propagates classification through declared state
outputs. In `compat-v1`, unsafe provider/tool/command/event/evidence/
persistence/artifact/human-prompt flows surface as `UNSAFE_DATA_FLOW`
warnings. Under `strict`, they are Stage 3 policy errors.

`evidence.write.redact: true` is recognized as the existing reviewed v1
redaction seam. The compiler does not infer that arbitrary transforms,
filters, tools, or HTTP calls declassify data.

Built-in primitive step ports no longer require host snapshots. The compiler
generates their value types and baseline classifications from
`PrimitiveDefinitionV2`, then monotonically raises a port classification when
the concrete node output depends on more restrictive data. Explicit host port
bindings remain supported for custom or host-owned primitives and merge
conservatively with generated contracts.

This is compile-time and authoring metadata. It does not claim that a host
already persists classification envelopes in events, logs, checkpoints, or
stores.

## Primitive input admission and credential handles

Stage 3 applies the resolved built-in `PrimitiveDefinitionV2` input contract:

- raw values outside `acceptedInputClassifications` produce
  `PRIMITIVE_INPUT_CLASSIFICATION_DENIED`;
- values above `redactionRequiredAbove` require the existing reviewed
  redaction seam or produce `PRIMITIVE_REDACTION_REQUIRED`;
- `credential` inputs are automatically secret and may only be passed as
  unfiltered whole values at exact declared `credentialInputPaths`;
- whole-value `set` assignments preserve credential-handle identity, while
  interpolation, filters, and arbitrary transforms do not;
- raw `secrets.*` strings do not become credential handles merely because
  they are placed in a credential-named field.

Compatibility mode reports these as warnings. Strict mode promotes them to
Stage 3 policy errors. An authorized credential handle bypasses the raw-secret
sink diagnostic at that exact input path, while all other sensitive/secret
flows retain the existing fail-closed policy.

For unattended compilation, opt into the fail-closed admission profile:

```ts
createFlowCompiler({
  toolResolver,
  admissionProfile: 'unattended',
  referencePolicy: 'strict',
})
```

`unattended` rejects compatibility reference policy and requires every
document input to have a resolved classification. The general interactive v1
default remains unchanged.

## Compiled classification envelope

Every successful compile emits
`dzupagent.flowCompiledClassificationEnvelope/v1` both on
`CompileSuccess.classificationEnvelope` and as the immutable
`artifact.classificationEnvelope` property.

The envelope contains:

- classified value and step-port identities with their compile-time types;
- opaque-handle markers for credential values;
- resolved V2 primitive refs and accepted input classifications;
- exact credential paths and required resolver capabilities;
- redaction thresholds, versioned policies, and required receipt schemas;
- expected catalog output classifications and effective classifications after
  monotonic propagation;
- `classificationComplete` plus sorted `unclassifiedReferences`, so hosts can
  reject unresolved policy coverage without inferring meaning from omission.

Entries are deterministically sorted and deeply frozen. The envelope carries
no authored/runtime values, credential material, or redacted output. It is a
portable host obligation with its own deterministic `classificationHash`
(independent of the per-run `compileId`), not evidence that any runtime
enforces or persists the classification contract.

### Strict host security kit

Provider-free host helpers turn the envelope into a fail-closed admission
boundary:

- `admitFlowCompiledClassificationEnvelope` binds the envelope to the expected
  semantic, classification, and optional compile identities, requires complete
  classification coverage, and checks every projected primitive capability;
- `resolveFlowCredentialLeaseForEnvelope` permits only an exact primitive
  credential path, requires a nominal handle with the projected resolver
  capability, and rejects mismatched, expired, or malformed leases;
- `attestFlowRedactionReceipt` and
  `verifyFlowRedactionReceiptAttestation` use canonical JSON, SHA-256 payload
  identities, trusted key references, and Ed25519 signatures;
- `commitFlowRedactionResult` validates the classified output digest and
  signature before atomically storing the first terminal operation result;
  equivalent retries are duplicates and different late results are conflicts.

`InMemoryFlowRedactionReceiptCustodyStore` exists for provider-free
qualification only. A durable host must implement atomic `putIfAbsent` on the
operation id and must secure the classified result at rest. These helpers do
not activate a provider, secret backend, key store, or production runtime.

## Provider-free corpus qualification

`dzupagent-qualify-flow-corpus` checks an explicit manifest of DSL files. Each
entry is SHA-256 pinned, so the command fails on unreviewed source drift as well
as parser, compiler, or strict-reference failures.

```bash
dzupagent-qualify-flow-corpus \
  --manifest ./qualification.manifest.json \
  --format markdown
```

The manifest schema is:

```json
{
  "schema": "dzupagent.flowCorpusManifest/v1",
  "entries": [
    {
      "id": "hello",
      "path": "hello.dzupflow.yaml",
      "sha256": "64-character lowercase SHA-256 digest"
    }
  ]
}
```

Paths must be relative to the manifest and cannot escape its directory. The
gate uses placeholder tool and persona resolvers to isolate authoring contract
drift. A passing report is not provider, runtime, host-capability, or deployment
qualification.

## License

MIT
