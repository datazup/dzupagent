import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/fleet.ts",
    "src/fleet-contract.ts",
    "src/implementation.ts",
    "src/run.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  sourcemap: true,
});
