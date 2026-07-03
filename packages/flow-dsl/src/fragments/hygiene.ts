const STATE_KEY_FIELDS = new Set(["output", "outputKey", "outputVar", "source"]);

export function privateKey(instanceId: string, key: string): string {
  return `${instanceId}__${key}`;
}

function substituteParams(value: string, params: Record<string, unknown>): string {
  return value.replace(/\{\{\s*params\.([A-Za-z0-9_]+)\s*\}\}/g, (_match, key) => {
    const replacement = params[key];
    return replacement === undefined ? "" : String(replacement);
  });
}

export function rewriteFragmentValue(
  value: unknown,
  instanceId: string,
  params: Record<string, unknown> = {},
): unknown {
  if (typeof value === "string") return substituteParams(value, params);
  if (Array.isArray(value)) {
    return value.map((item) => rewriteFragmentValue(item, instanceId, params));
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "id" && typeof child === "string") {
      output[key] = privateKey(instanceId, child);
      continue;
    }
    if (STATE_KEY_FIELDS.has(key) && typeof child === "string") {
      output[key] = privateKey(instanceId, child);
      continue;
    }
    if (key === "output" && child && typeof child === "object" && !Array.isArray(child)) {
      const outputObj = child as Record<string, unknown>;
      output[key] =
        typeof outputObj.key === "string"
          ? { ...outputObj, key: privateKey(instanceId, outputObj.key) }
          : rewriteFragmentValue(child, instanceId, params);
      continue;
    }
    output[key] = rewriteFragmentValue(child, instanceId, params);
  }
  return output;
}
