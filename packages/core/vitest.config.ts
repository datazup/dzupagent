import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    hookTimeout: 60_000,
    testTimeout: 120_000,
    // singleFork: retained — core pulls in @langchain/core, @modelcontextprotocol,
    // and vector-store modules whose module-init cost is ~2-4 s each. Spawning N
    // parallel forks multiplies that overhead and causes Vitest RPC
    // fetch/onTaskUpdate timeouts under full-Turbo concurrency. Each test file
    // still runs in its own isolated module registry (isolate:true default) inside
    // the single fork, so cross-file state bleed is not a risk.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
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
      // Thresholds managed centrally in coverage-thresholds.json.
    },
  },
});
