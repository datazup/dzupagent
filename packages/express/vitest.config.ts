import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSourceEntry = fileURLToPath(
  new URL("../core/src/index.ts", import.meta.url)
);
const corePipelineEntry = fileURLToPath(
  new URL("../core/src/pipeline.ts", import.meta.url)
);
const coreUtilsEntry = fileURLToPath(
  new URL("../core/src/utils.ts", import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: [
      { find: "@dzupagent/core/pipeline", replacement: corePipelineEntry },
      { find: "@dzupagent/core/utils", replacement: coreUtilsEntry },
      { find: "@dzupagent/core", replacement: coreSourceEntry },
    ],
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // singleFork + fileParallelism:false: retained — express production code
    // imports @langchain/core/messages and @dzupagent/core (which transitively
    // pulls @modelcontextprotocol) at module-load time. Under full-Turbo
    // concurrency these heavy module inits cause Vitest RPC resolveId/
    // onTaskUpdate timeouts observed on NTFS-3g and slow CI hosts. isolate:true
    // (default) is kept so each test file gets a fresh module registry
    // (TEST-M-08 compliance); the single fork serialises that cost.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
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
