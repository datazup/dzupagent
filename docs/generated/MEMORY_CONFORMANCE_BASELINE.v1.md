# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:451d546bbd167d6924aa9d80d8d7d1f663753f3bda9a4fb034b9e3df7d777212` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:cb42ec6d5d46ee3c3f1beb1b90f8fba099541c54ce8d1f3f6ccdd8f42fa21a53`
- Result digest: `sha256:e1f296038dfd4b19c968f933648bdb8399168de267cfa76253625017de742d1c`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:2c7c417624731a9fe47dab02a8d21c5532704f2af271f4d7eca8ad44fe37f516` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:b54518d069e2935b2e05efb1ba01741306c24a17b2ad34caf1787a5c298d4772` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:185681837f0b244016699c352a504749ee7a4ba06ef88eba2cb22f9d9907b753` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:c7a799535775103f0075728a573a950ba07353bd78c572511e9676897b57ac80` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:d4c4d6b41bfb6c95415eebf233cf1906ef9cfaf3a211efdb525bbb1ab9373164` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:0331ff820281843a9eec4dbf619603fac2d6342fe007b4142643adb7f301b5db` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:1bf9c5539f7ae4f234f06ac6ce266bbf1966bb3ba11138f658ee03e3a8dc4fb5` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
