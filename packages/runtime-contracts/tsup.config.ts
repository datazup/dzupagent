import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/ai-execution.ts",
    "src/ai-execution-node.ts",
    "src/ai-budget-reservation.ts",
    "src/effect-receipt.ts",
    "src/loop-economics-evidence.ts",
    "src/loop-economics-evidence-v2.ts",
    "src/execution-boundary-evidence.ts",
    "src/canonical-execution.ts",
    "src/orchestration.ts",
    "src/rag.ts",
    "src/agent-review.ts",
    "src/agent-blueprint.ts",
    "src/provider-session.ts",
    "src/recursive-scope/index.ts",
    "src/pipeline-artifact/index.ts",
  ],
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node20",
  sourcemap: true,
});
