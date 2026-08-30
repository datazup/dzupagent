import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    unstubEnvs: true,
    unstubGlobals: true,
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
  },
});
