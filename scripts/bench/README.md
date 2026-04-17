# DzupAgent Benchmark Suite

Performance baselines established on 2026-04-16 (Wave 16).

## Running Benchmarks

cd into dzupagent/ and run:

```bash
yarn bench
```

Or explicitly:

```bash
yarn vitest bench --config scripts/bench/vitest.bench.config.ts
```

## Benchmark Suites

| Suite | File | What it measures |
|-------|------|-----------------|
| Server throughput | server-throughput.bench.ts | Hono route req/s overhead |
| Streaming latency | streaming-latency.bench.ts | TTFT, async generator, SSE serialization |
| Tool loop | tool-loop.bench.ts | Tool dispatch, parallel invocation |
| Memory footprint | memory-footprint.bench.ts | Map/Array ops, JSON round-trip |
| Corpus ingest | corpus-ingest.bench.ts | Chunking, ID generation, metadata |

## When to run

- **On-demand** (not in CI every commit -- too slow)
- Before and after performance-sensitive changes
- As part of release validation

## Interpreting results

vitest bench reports `median`, `p75`, `p99`, and `ops/sec`.
Focus on `ops/sec` for throughput and `median` for latency.
