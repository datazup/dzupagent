import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 30_000,
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    exclude: [
      "src/__tests__/chunker.test.ts",
      "src/__tests__/minimal-chunker.test.ts",
    ],
    maxConcurrency: 1,
    fileParallelism: false,
    // singleFork: retained — @langchain/core graph module load measured at
    // 300-400 MB heap. Parallel forks each pay this cost independently and
    // exhaust the default 4 GB heap on CI. singleFork serialises files in one
    // process that already has --max-old-space-size=4096; fileParallelism:false
    // prevents Vitest from attempting concurrent file runs inside that fork.
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--max-old-space-size=4096"],
        singleFork: true,
      },
    },
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
        statements: 70,
        branches: 60,
        functions: 60,
        lines: 70,
      },
    },
  },
});
