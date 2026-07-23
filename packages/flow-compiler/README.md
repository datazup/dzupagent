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
