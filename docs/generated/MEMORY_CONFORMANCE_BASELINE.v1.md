# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:67fd460b66e34d7c5722405b54ee90cb206d418c6b3b13eccc0eda49cca411b4` (139 files)
- Config digest: `sha256:55f4858fd5d6e73cfc2f57988f8e8f5995e6009a0f6aa229799dfff5510e231a`
- Profile digest: `sha256:895f207f952ebd3276858f13e35e97cba74d7fe87946b2c3a3dd18a5e8f70292`
- Result digest: `sha256:fc862d912e09fdb115c14291de88115be3f36ff9cdeaf7e613051e80232cf4c3`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:30a3a6e12b80bd416aa25ea650fb92ca39df375690ba4c462803441d817a726f` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:7e57c985f420686eed8172b84a8e1db6afb170c98423df053b252fd8d920eb1c` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:9fec2e2925e5c37432a03e89e252839516936d22bce43cfe959b0fea3ac4076a` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:41ca0c6e97b8f38bc9bf80ef5486db03b3deed8984827d1a3f4a107cd73db8bf` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:e580cd62328c3e3a87e4b353a6a017bf71672d39a25e7d4bd7d886483b7a8541` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:a554bdd18b9c0e1058f0224fe6ffe30d750653afc5158e710f690e132845a349` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:eaea46dbbb4e3635e9f355db7369c7cede8ff8cdf1a3e3f5111a6197054c81dc` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
