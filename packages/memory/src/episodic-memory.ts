/**
 * EpisodicMemory — an in-process episodic event log with:
 *
 * - Event logging: timestamped events with type and payload
 * - Episode boundaries: explicit start/end or inactivity-gap detection
 * - Timeline reconstruction: chronological full log across episodes
 * - Retrieval: filter by type, time range, episode, or cross-episode search
 * - Serialization: JSON round-trip preserving all events
 *
 * @example
 * ```ts
 * const mem = new EpisodicMemory({ inactivityGapMs: 30_000 })
 * mem.startEpisode('session-1')
 * mem.logEvent({ type: 'user_message', payload: { text: 'hello' } })
 * mem.endEpisode()
 * const events = mem.getEpisodeEvents('session-1')
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpisodicEvent {
  /** Unique event identifier */
  id: string;
  /** ISO-8601 / epoch ms timestamp */
  timestamp: number;
  /** Discriminator for filtering (e.g. "user_message", "tool_call") */
  type: string;
  /** Arbitrary structured payload */
  payload: Record<string, unknown>;
  /** Episode this event belongs to */
  episodeId: string;
}

export interface Episode {
  /** Unique identifier for this episode */
  id: string;
  /** Epoch ms when the episode started */
  startedAt: number;
  /** Epoch ms when the episode ended (undefined = still open) */
  endedAt?: number | undefined;
  /** Ordered list of events within this episode */
  events: EpisodicEvent[];
}

export interface EpisodicMemoryConfig {
  /**
   * Inactivity gap in ms: if no event is logged for this long,
   * the current episode is automatically closed.  Default: 30 minutes.
   */
  inactivityGapMs?: number | undefined;
  /**
   * Factory for generating unique IDs.  Defaults to a simple counter.
   */
  idFactory?: (() => string) | undefined;
}

export interface TimelineGap {
  /** Episode that ended */
  afterEpisodeId: string;
  /** Episode that began next */
  beforeEpisodeId: string;
  /** Duration of the gap in ms */
  gapMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class EpisodicMemory {
  private readonly episodes: Map<string, Episode> = new Map();
  /** Ordered list of episode IDs (insertion order = start order) */
  private readonly episodeOrder: string[] = [];
  private currentEpisodeId: string | null = null;
  private readonly inactivityGapMs: number;
  private readonly idFactory: () => string;
  private lastEventAt: number | null = null;
  private eventCounter = 0;
  private episodeCounter = 0;

  constructor(config: EpisodicMemoryConfig = {}) {
    this.inactivityGapMs = config.inactivityGapMs ?? 30 * 60 * 1000;
    this.idFactory = config.idFactory ?? (() => `evt-${++this.eventCounter}`);
  }

  // ---------------------------------------------------------------------------
  // Episode management
  // ---------------------------------------------------------------------------

  /**
   * Start a new named episode.  Any currently open episode is ended first.
   */
  startEpisode(id?: string): Episode {
    if (this.currentEpisodeId !== null) {
      this._closeCurrentEpisode();
    }
    const episodeId = id ?? `episode-${++this.episodeCounter}`;
    const episode: Episode = {
      id: episodeId,
      startedAt: Date.now(),
      events: [],
    };
    this.episodes.set(episodeId, episode);
    this.episodeOrder.push(episodeId);
    this.currentEpisodeId = episodeId;
    return episode;
  }

  /**
   * Explicitly end the current episode.
   */
  endEpisode(): void {
    if (this.currentEpisodeId === null) return;
    this._closeCurrentEpisode();
  }

  private _closeCurrentEpisode(): void {
    if (this.currentEpisodeId === null) return;
    const ep = this.episodes.get(this.currentEpisodeId);
    if (ep && ep.endedAt === undefined) {
      ep.endedAt = Date.now();
    }
    this.currentEpisodeId = null;
  }

  // ---------------------------------------------------------------------------
  // Event logging
  // ---------------------------------------------------------------------------

  /**
   * Log an event in the current episode.
   * If no episode is open, one is created automatically.
   * If the inactivity gap has elapsed since the last event, the current episode
   * is closed and a new one is started automatically.
   */
  logEvent(event: {
    type: string;
    payload?: Record<string, unknown>;
    timestamp?: number;
  }): EpisodicEvent {
    const now = event.timestamp ?? Date.now();

    // Auto-close stale episode
    if (this.currentEpisodeId !== null && this.lastEventAt !== null) {
      if (now - this.lastEventAt >= this.inactivityGapMs) {
        this._closeCurrentEpisode();
      }
    }

    // Auto-start episode if none is open
    if (this.currentEpisodeId === null) {
      this.startEpisode();
      // Backdate startedAt to event timestamp for accuracy
      const ep = this.episodes.get(this.currentEpisodeId!)!;
      ep.startedAt = now;
    }

    const ep = this.episodes.get(this.currentEpisodeId!)!;
    const entry: EpisodicEvent = {
      id: this.idFactory(),
      timestamp: now,
      type: event.type,
      payload: event.payload ?? {},
      episodeId: ep.id,
    };
    ep.events.push(entry);
    this.lastEventAt = now;
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Retrieval
  // ---------------------------------------------------------------------------

  /**
   * Return all events for a given episode in chronological order.
   */
  getEpisodeEvents(episodeId: string): EpisodicEvent[] {
    return [...(this.episodes.get(episodeId)?.events ?? [])];
  }

  /**
   * Return all events across all episodes sorted by timestamp (timeline).
   */
  getTimeline(): EpisodicEvent[] {
    const all: EpisodicEvent[] = [];
    for (const id of this.episodeOrder) {
      all.push(...(this.episodes.get(id)?.events ?? []));
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Return all events whose type matches the given string (across all episodes).
   */
  filterByType(type: string): EpisodicEvent[] {
    return this.getTimeline().filter((e) => e.type === type);
  }

  /**
   * Return all events whose timestamp falls within [start, end] (inclusive).
   */
  filterByTimeRange(start: number, end: number): EpisodicEvent[] {
    return this.getTimeline().filter(
      (e) => e.timestamp >= start && e.timestamp <= end,
    );
  }

  /**
   * Cross-episode search: return events matching a predicate.
   */
  search(predicate: (event: EpisodicEvent) => boolean): EpisodicEvent[] {
    return this.getTimeline().filter(predicate);
  }

  /**
   * Count events grouped by type across all episodes.
   */
  countByType(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const ev of this.getTimeline()) {
      counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Return the last N episodes (most-recent-first).
   */
  getRecentEpisodes(n: number): Episode[] {
    if (n <= 0) return [];
    const ids = this.episodeOrder.slice(-n).reverse();
    return ids.map((id) => this.episodes.get(id)!).filter(Boolean);
  }

  /**
   * List all episode IDs in start order.
   */
  listEpisodeIds(): string[] {
    return [...this.episodeOrder];
  }

  /**
   * Get a specific episode by ID, or undefined.
   */
  getEpisode(id: string): Episode | undefined {
    return this.episodes.get(id);
  }

  /**
   * Return a summary of an episode: id, startedAt, endedAt, event count,
   * and a map of event-type frequencies.
   */
  summarizeEpisode(episodeId: string):
    | {
        id: string;
        startedAt: number;
        endedAt: number | undefined;
        eventCount: number;
        typeCounts: Record<string, number>;
      }
    | undefined {
    const ep = this.episodes.get(episodeId);
    if (!ep) return undefined;
    const typeCounts: Record<string, number> = {};
    for (const ev of ep.events) {
      typeCounts[ev.type] = (typeCounts[ev.type] ?? 0) + 1;
    }
    return {
      id: ep.id,
      startedAt: ep.startedAt,
      endedAt: ep.endedAt,
      eventCount: ep.events.length,
      typeCounts,
    };
  }

  /**
   * Identify gaps between consecutive closed episodes.
   */
  getTimelineGaps(): TimelineGap[] {
    const gaps: TimelineGap[] = [];
    const closed = this.episodeOrder
      .map((id) => this.episodes.get(id)!)
      .filter((ep) => ep.endedAt !== undefined);

    for (let i = 0; i < closed.length - 1; i++) {
      const prev = closed[i]!;
      const next = closed[i + 1]!;
      const gapMs = next.startedAt - prev.endedAt!;
      if (gapMs > 0) {
        gaps.push({ afterEpisodeId: prev.id, beforeEpisodeId: next.id, gapMs });
      }
    }
    return gaps;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Serialize the entire episodic memory to a plain JSON-safe object.
   */
  serialize(): {
    episodes: Episode[];
    currentEpisodeId: string | null;
    lastEventAt: number | null;
  } {
    return {
      episodes: this.episodeOrder.map((id) =>
        structuredClone(this.episodes.get(id)!),
      ),
      currentEpisodeId: this.currentEpisodeId,
      lastEventAt: this.lastEventAt,
    };
  }

  /**
   * Restore an EpisodicMemory from a serialized snapshot.
   */
  static deserialize(
    data: ReturnType<EpisodicMemory["serialize"]>,
    config?: EpisodicMemoryConfig,
  ): EpisodicMemory {
    const mem = new EpisodicMemory(config);
    for (const ep of data.episodes) {
      const clone = structuredClone(ep);
      mem.episodes.set(clone.id, clone);
      mem.episodeOrder.push(clone.id);
      // Restore event counter ceiling
      for (const ev of clone.events) {
        const num = parseInt(ev.id.replace("evt-", ""), 10);
        if (!isNaN(num) && num > mem.eventCounter) mem.eventCounter = num;
      }
    }
    mem.currentEpisodeId = data.currentEpisodeId;
    mem.lastEventAt = data.lastEventAt;
    return mem;
  }
}
