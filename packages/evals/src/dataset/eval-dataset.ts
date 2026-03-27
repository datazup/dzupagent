/**
 * ECO-114: Eval Dataset — immutable, filterable, sampleable dataset for evaluations.
 */

export interface EvalEntry {
  id: string;
  input: string;
  expectedOutput?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface DatasetMetadata {
  name: string;
  description?: string;
  version?: string;
  createdAt?: string;
  totalEntries: number;
  tags: string[];
}

/**
 * Mulberry32 seeded PRNG — deterministic 32-bit random number generator.
 * Returns values in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Parse CSV with support for quoted fields containing commas.
 * Expected columns: id,input,expectedOutput,tags (tags are semicolon-separated).
 */
function parseCSV(csv: string): EvalEntry[] {
  const lines = csv.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Skip header line
  const entries: EvalEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const fields = parseCSVLine(line);
    if (fields.length < 2) continue;

    const id = fields[0]!.trim();
    const input = fields[1]!.trim();
    const expectedOutput = fields[2]?.trim() || undefined;
    const tagsField = fields[3]?.trim();
    const tags = tagsField
      ? tagsField.split(';').map((t) => t.trim()).filter((t) => t.length > 0)
      : undefined;

    entries.push({ id, input, expectedOutput, tags });
  }

  return entries;
}

/**
 * Parse a single CSV line, handling quoted fields with commas.
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ""
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Immutable evaluation dataset with filtering, sampling, and format parsing.
 */
export class EvalDataset {
  readonly metadata: DatasetMetadata;
  readonly entries: readonly EvalEntry[];

  private constructor(entries: EvalEntry[], metadata: Partial<DatasetMetadata>) {
    const allTags = collectTags(entries);
    this.metadata = {
      name: metadata.name ?? 'unnamed',
      description: metadata.description,
      version: metadata.version,
      createdAt: metadata.createdAt,
      totalEntries: entries.length,
      tags: allTags,
    };
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }

  /**
   * Create a dataset from an array of entries.
   */
  static from(entries: EvalEntry[], metadata?: Partial<DatasetMetadata>): EvalDataset {
    return new EvalDataset(entries, metadata ?? {});
  }

  /**
   * Parse a dataset from a JSON string (array of EvalEntry objects).
   */
  static fromJSON(json: string): EvalDataset {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error('EvalDataset.fromJSON expects a JSON array of entries');
    }
    const entries = parsed as EvalEntry[];
    return new EvalDataset(entries, {});
  }

  /**
   * Parse a dataset from JSONL (one JSON object per line).
   */
  static fromJSONL(jsonl: string): EvalDataset {
    const lines = jsonl.split('\n').filter((l) => l.trim().length > 0);
    const entries: EvalEntry[] = lines.map((line) => JSON.parse(line) as EvalEntry);
    return new EvalDataset(entries, {});
  }

  /**
   * Parse a dataset from CSV with headers: id,input,expectedOutput,tags.
   * Handles quoted fields containing commas. Tags are semicolon-separated.
   */
  static fromCSV(csv: string): EvalDataset {
    const entries = parseCSV(csv);
    return new EvalDataset(entries, {});
  }

  /**
   * Filter entries by tags (AND logic — entry must have ALL specified tags)
   * and/or by IDs.
   */
  filter(options: { tags?: string[]; ids?: string[] }): EvalDataset {
    let filtered = [...this.entries];

    if (options.tags && options.tags.length > 0) {
      const requiredTags = options.tags;
      filtered = filtered.filter((entry) =>
        requiredTags.every((tag) => entry.tags?.includes(tag) ?? false),
      );
    }

    if (options.ids && options.ids.length > 0) {
      const idSet = new Set(options.ids);
      filtered = filtered.filter((entry) => idSet.has(entry.id));
    }

    return new EvalDataset(filtered, {
      name: this.metadata.name,
      description: this.metadata.description,
      version: this.metadata.version,
    });
  }

  /**
   * Sample `count` entries using a seeded PRNG for reproducibility.
   * Uses Fisher-Yates shuffle with mulberry32 PRNG.
   */
  sample(count: number, seed?: number): EvalDataset {
    const rng = mulberry32(seed ?? 42);
    const pool = [...this.entries];
    const n = Math.min(count, pool.length);

    // Fisher-Yates partial shuffle
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }

    return new EvalDataset(pool.slice(0, n), {
      name: this.metadata.name,
      description: this.metadata.description,
      version: this.metadata.version,
    });
  }

  /**
   * Return sorted unique tags across all entries.
   */
  allTags(): string[] {
    return collectTags([...this.entries]);
  }

  /**
   * Number of entries in the dataset.
   */
  get size(): number {
    return this.entries.length;
  }
}

function collectTags(entries: EvalEntry[]): string[] {
  const tagSet = new Set<string>();
  for (const entry of entries) {
    if (entry.tags) {
      for (const tag of entry.tags) {
        tagSet.add(tag);
      }
    }
  }
  return [...tagSet].sort();
}
