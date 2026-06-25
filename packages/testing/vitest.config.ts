import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // singleThread: retained — the architecture/boundary test scans all app
    // workspaces and takes ~58 s under full-Turbo load. Using vmThreads with a
    // single thread avoids spawning multiple worker processes and keeps IPC
    // heartbeat latency well below Vitest's "Timeout calling onTaskUpdate" RPC
    // threshold. vmThreads (not forks) is chosen because the workspace scan
    // uses Node.js built-in fs APIs that are thread-safe and avoid the fork
    // startup overhead.
    pool: "vmThreads",
    poolOptions: { vmThreads: { singleThread: true } },
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/__tests__/**",
        "src/**/__fixtures__/**",
        "src/**/index.ts",
      ],
      thresholds: {
        statements: 40,
        branches: 30,
        functions: 30,
        lines: 40,
      },
    },
  },
});
