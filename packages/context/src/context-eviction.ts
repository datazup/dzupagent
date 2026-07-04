/**
 * Context eviction for large content blocks.
 *
 * Implements the 20K-token auto-eviction pattern: when a content string
 * exceeds the token threshold it is replaced with a head/tail preview
 * so the agent can decide whether to read specific sections.
 */

export interface EvictionConfig {
  /** Estimated token threshold before eviction triggers (default 20 000) */
  tokenThreshold: number;
  /** Characters per token for rough estimation (default 4) */
  charsPerToken: number;
  /** Number of lines to keep from the beginning (default 50) */
  headLines: number;
  /** Number of lines to keep from the end (default 20) */
  tailLines: number;
}

const DEFAULTS: EvictionConfig = {
  tokenThreshold: 20_000,
  charsPerToken: 4,
  headLines: 50,
  tailLines: 20,
};

export interface EvictionResult {
  /** Whether the content was truncated */
  evicted: boolean;
  /** The (possibly truncated) content */
  content: string;
  /** Original character length (only set when evicted) */
  originalLength?: number;
  /** Original line count (only set when evicted) */
  lineCount?: number;
}

/**
 * If `content` exceeds the token threshold, return a head/tail preview.
 * Otherwise return the content unchanged.
 *
 * @param content    The raw text to evaluate
 * @param identifier A file path or label used in the "read more" hint
 * @param config     Optional overrides for thresholds
 */
export function evictIfNeeded(
  content: string,
  identifier: string,
  config?: Partial<EvictionConfig>
): EvictionResult {
  const cfg = { ...DEFAULTS, ...config };
  const charThreshold = cfg.tokenThreshold * cfg.charsPerToken;

  if (content.length < charThreshold) {
    return { evicted: false, content };
  }

  return {
    evicted: true,
    content: buildPreview(content, identifier, cfg),
    originalLength: content.length,
    lineCount: content.split("\n").length,
  };
}

function buildPreview(
  content: string,
  identifier: string,
  cfg: EvictionConfig,
  recoveryHint?: string
): string {
  const lines = content.split("\n");
  const lineCount = lines.length;
  const head = lines.slice(0, cfg.headLines).join("\n");
  const tail = lines.slice(-cfg.tailLines).join("\n");
  const omitted = Math.max(0, lineCount - cfg.headLines - cfg.tailLines);

  return [
    `[Content truncated — ${lineCount} lines, ~${Math.ceil(
      content.length / cfg.charsPerToken
    )} tokens]`,
    "",
    `--- First ${cfg.headLines} lines ---`,
    head,
    "",
    `--- [${omitted} lines omitted] ---`,
    "",
    `--- Last ${cfg.tailLines} lines ---`,
    tail,
    "",
    recoveryHint ??
      `[Use read_file("${identifier}", { offset, limit }) to view specific sections]`,
  ].join("\n");
}

export interface OffloadSink {
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
}

export interface OffloadEvictionResult extends EvictionResult {
  /** Path the full content was offloaded to (unset if not evicted or sink failed) */
  offloadPath?: string;
}

let offloadCounter = 0;

function offloadFileName(identifier: string): string {
  const slug =
    identifier
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "content";
  offloadCounter += 1;
  return `${slug}-${offloadCounter}.txt`;
}

/**
 * Like `evictIfNeeded`, but writes the FULL content to `sink` before
 * truncating, so the agent can recover the evicted middle via read_file.
 * Sink failures are swallowed: the result degrades to the legacy preview.
 */
export async function evictWithOffload(
  content: string,
  identifier: string,
  sink: OffloadSink,
  config?: Partial<EvictionConfig> & { offloadDir?: string }
): Promise<OffloadEvictionResult> {
  const legacy = evictIfNeeded(content, identifier, config);
  if (!legacy.evicted) return legacy;

  const dir = config?.offloadDir ?? ".dzup/evicted";
  const path = `${dir}/${offloadFileName(identifier)}`;
  try {
    await sink.write(path, content);
  } catch {
    return legacy;
  }

  const cfg = { ...DEFAULTS, ...config };
  const hint = `[Full content offloaded to ${path} — use read_file("${path}", { offset, limit }) to recover omitted sections]`;
  return {
    ...legacy,
    content: buildPreview(content, identifier, cfg, hint),
    offloadPath: path,
  };
}
