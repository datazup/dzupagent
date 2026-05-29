import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

function locatePresetDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src layout (vitest / dev): YAMLs live next to this file.
  // dist layout: fall back to the source tree when running from dist, since the
  //   build does not currently copy non-TS assets alongside the compiled output.
  const candidates = [
    here,
    path.join(here, "..", "..", "src", "presets", "fleet"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "audit-fanout.flow.yaml"))) {
      return candidate;
    }
  }
  throw new Error("fleet presets directory not found");
}

const dir = locatePresetDir();

export const FLEET_PRESETS = {
  "audit-fanout": path.join(dir, "audit-fanout.flow.yaml"),
  "continuous-fleet": path.join(dir, "continuous-fleet.flow.yaml"),
  "coordinated-feature": path.join(dir, "coordinated-feature.flow.yaml"),
  "independent-tasks": path.join(dir, "independent-tasks.flow.yaml"),
} as const;

export type FleetPresetName = keyof typeof FLEET_PRESETS;
