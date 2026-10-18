# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:685f3e30842288ebba09b5a7a64dd121a67dd0025c72b030f27c746ffc394b29` (161 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:98bceb448852d0ddf1222b2fa05ba88a2ffa3a004d5dc21bb46dc69257178ca1`
- Result digest: `sha256:8700005e1b1147d60cc411876dbfa423e40dea31f3c2394c31dde317dfdd9fa7`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:c538f7de05d03b9e1b7dbd97c5edb972c0ecc2f6adf6ee2d4248423f7c153a94` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:f308cf2f682ad71c082235a32066927897290567c1e054c16b9c7195ad5ccb38` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:f01d70b8bab61a9309def563e1dfee9c61882c27cd1ec53d8adcffb2b1c84b05` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:d8b85695e1a14e066e1ebc076976bfd1c53d9bc975370a16ed0ff5d1cf2380f6` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:e64dfdd088ccce93df8b695c9f76cb2226a55cc01f1a04935d6122226b203f3f` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:87ffcdc5cc99bece7562e4a715f36105e36e389a3e06fa06f8a3fbff9598e116` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:cf5bb5098396b3782d221160497686ae9f7e1d5f15de1c42f96d4036c4a92d81` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
