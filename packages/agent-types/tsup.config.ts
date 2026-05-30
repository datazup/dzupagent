import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/fleet.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  sourcemap: true,
});
