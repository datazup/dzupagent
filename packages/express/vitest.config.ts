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
    // TEST-M-09: singleFork + fileParallelism:false retained — now MEASURED, not
    // merely asserted. express is a tiny suite (7 files / 75 tests): parallelism
    // yields no meaningful speedup because per-fork init of @langchain/core and
    // @dzupagent/core (transitively @modelcontextprotocol) cancels the gain.
    // Benchmarks (INDICATIVE — dev workstation, Linux 6.17 / Node v22.17, NOT a
    // CI host; relative, not CI-authoritative):
    //   - singleFork (this):   3.09s  EXIT 0
    //   - parallel forks:      3.12s  EXIT 0  (statistical tie — no benefit)
    // Serial also keeps the original RPC-timeout hedge for slow/NTFS CI hosts at
    // zero cost. isolate:true (default) gives each test file a fresh module
    // registry (TEST-M-08 compliance); the single fork serialises that cost.
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
