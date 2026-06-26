/**
 * Calendar connector tests — comprehensive coverage of event creation,
 * retrieval, listing, update, deletion, RSVP handling, conflict detection,
 * and all-day event handling.
 *
 * This test file exercises a self-contained in-memory CalendarConnector
 * implementation. No real network calls are made.
 */
import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RsvpStatus = "accepted" | "declined" | "tentative" | "pending";

interface Attendee {
  email: string;
  name?: string;
  rsvp: RsvpStatus;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  attendees: Attendee[];
  allDay?: boolean;
  description?: string;
}

interface ConflictReport {
  eventA: string;
  eventB: string;
  overlapStart: Date;
  overlapEnd: Date;
}

// ---------------------------------------------------------------------------
// In-memory CalendarConnector (the unit under test)
// ---------------------------------------------------------------------------

class CalendarConnector {
  private events: Map<string, CalendarEvent> = new Map();
  private idCounter = 0;

  private nextId(): string {
    return `evt-${++this.idCounter}`;
  }

  createEvent(params: {
    title: string;
    start: Date;
    end: Date;
    attendees?: Omit<Attendee, "rsvp">[];
    allDay?: boolean;
    description?: string;
  }): CalendarEvent {
    const id = this.nextId();
    const event: CalendarEvent = {
      id,
      title: params.title,
      start: params.start,
      end: params.end,
      attendees: (params.attendees ?? []).map((a) => ({
        ...a,
        rsvp: "pending" as RsvpStatus,
      })),
      allDay: params.allDay,
      description: params.description,
    };
    this.events.set(id, event);
    return event;
  }

  getEvent(id: string): CalendarEvent | undefined {
    return this.events.get(id);
  }

  listEvents(rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
    return [...this.events.values()].filter(
      (e) => e.start < rangeEnd && e.end > rangeStart
    );
  }

  updateEvent(
    id: string,
    updates: Partial<
      Pick<CalendarEvent, "title" | "start" | "end" | "description">
    >
  ): CalendarEvent {
    const event = this.events.get(id);
    if (!event) throw new Error(`Event ${id} not found`);
    const updated: CalendarEvent = { ...event, ...updates };
    this.events.set(id, updated);
    return updated;
  }

  deleteEvent(id: string): boolean {
    return this.events.delete(id);
  }

  rsvp(eventId: string, email: string, status: RsvpStatus): CalendarEvent {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`Event ${eventId} not found`);
    const attendee = event.attendees.find((a) => a.email === email);
    if (!attendee)
      throw new Error(`Attendee ${email} not found in event ${eventId}`);
    attendee.rsvp = status;
    return event;
  }

  getAttendees(eventId: string): Attendee[] {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`Event ${eventId} not found`);
    return event.attendees.map((a) => ({ ...a }));
  }

  detectConflicts(eventIdA: string, eventIdB: string): ConflictReport | null {
    const a = this.events.get(eventIdA);
    const b = this.events.get(eventIdB);
    if (!a || !b) throw new Error("Event not found");

    const overlapStart = a.start > b.start ? a.start : b.start;
    const overlapEnd = a.end < b.end ? a.end : b.end;

    if (overlapStart < overlapEnd) {
      return { eventA: eventIdA, eventB: eventIdB, overlapStart, overlapEnd };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CalendarConnector", () => {
  let connector: CalendarConnector;

  beforeEach(() => {
    connector = new CalendarConnector();
  });

  // ── Event creation ─────────────────────────────────────────────────────────

  describe("event creation", () => {
    it("creates an event with title, start, end, and attendees", () => {
      const start = new Date("2026-07-01T09:00:00Z");
      const end = new Date("2026-07-01T10:00:00Z");
      const event = connector.createEvent({
        title: "Team Standup",
        start,
        end,
        attendees: [
          { email: "alice@example.com", name: "Alice" },
          { email: "bob@example.com", name: "Bob" },
        ],
      });

      expect(event.title).toBe("Team Standup");
      expect(event.start).toEqual(start);
      expect(event.end).toEqual(end);
      expect(event.attendees).toHaveLength(2);
      expect(event.attendees[0]!.email).toBe("alice@example.com");
      expect(event.attendees[1]!.email).toBe("bob@example.com");
    });

    it("created event has a unique id", () => {
      const start = new Date("2026-07-01T09:00:00Z");
      const end = new Date("2026-07-01T10:00:00Z");
      const a = connector.createEvent({ title: "A", start, end });
      const b = connector.createEvent({ title: "B", start, end });

      expect(a.id).toBeTruthy();
      expect(b.id).toBeTruthy();
      expect(a.id).not.toBe(b.id);
    });

    it("new attendees are initialized with pending RSVP status", () => {
      const event = connector.createEvent({
        title: "Kickoff",
        start: new Date("2026-07-01T10:00:00Z"),
        end: new Date("2026-07-01T11:00:00Z"),
        attendees: [{ email: "carol@example.com" }],
      });

      expect(event.attendees[0]!.rsvp).toBe("pending");
    });

    it("creates event with no attendees when none provided", () => {
      const event = connector.createEvent({
        title: "Focus Time",
        start: new Date("2026-07-01T14:00:00Z"),
        end: new Date("2026-07-01T15:00:00Z"),
      });

      expect(event.attendees).toHaveLength(0);
    });

    it("creates event with a description", () => {
      const event = connector.createEvent({
        title: "Sync",
        start: new Date("2026-07-02T09:00:00Z"),
        end: new Date("2026-07-02T09:30:00Z"),
        description: "Weekly team sync meeting",
      });

      expect(event.description).toBe("Weekly team sync meeting");
    });
  });

  // ── Event retrieval ────────────────────────────────────────────────────────

  describe("event retrieval", () => {
    it("retrieves an existing event by id", () => {
      const created = connector.createEvent({
        title: "Design Review",
        start: new Date("2026-07-02T14:00:00Z"),
        end: new Date("2026-07-02T15:00:00Z"),
      });

      const fetched = connector.getEvent(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.title).toBe("Design Review");
    });

    it("returns undefined for a non-existent event id", () => {
      const result = connector.getEvent("does-not-exist");
      expect(result).toBeUndefined();
    });
  });

  // ── Event listing ──────────────────────────────────────────────────────────

  describe("event listing", () => {
    it("lists events that overlap the given date range", () => {
      connector.createEvent({
        title: "Morning Meeting",
        start: new Date("2026-07-05T08:00:00Z"),
        end: new Date("2026-07-05T09:00:00Z"),
      });
      connector.createEvent({
        title: "Afternoon Review",
        start: new Date("2026-07-05T14:00:00Z"),
        end: new Date("2026-07-05T15:00:00Z"),
      });
      connector.createEvent({
        title: "Next Day Event",
        start: new Date("2026-07-06T09:00:00Z"),
        end: new Date("2026-07-06T10:00:00Z"),
      });

      const results = connector.listEvents(
        new Date("2026-07-05T00:00:00Z"),
        new Date("2026-07-06T00:00:00Z")
      );

      expect(results).toHaveLength(2);
      const titles = results.map((e) => e.title);
      expect(titles).toContain("Morning Meeting");
      expect(titles).toContain("Afternoon Review");
    });

    it("returns empty array when no events fall in the range", () => {
      connector.createEvent({
        title: "Way Later",
        start: new Date("2026-08-01T09:00:00Z"),
        end: new Date("2026-08-01T10:00:00Z"),
      });

      const results = connector.listEvents(
        new Date("2026-07-01T00:00:00Z"),
        new Date("2026-07-31T23:59:59Z")
      );

      expect(results).toHaveLength(0);
    });

    it("includes events that partially overlap the range boundary", () => {
      // Event starts before range but ends inside it
      connector.createEvent({
        title: "Spanning Event",
        start: new Date("2026-07-04T22:00:00Z"),
        end: new Date("2026-07-05T01:00:00Z"),
      });

      const results = connector.listEvents(
        new Date("2026-07-05T00:00:00Z"),
        new Date("2026-07-06T00:00:00Z")
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe("Spanning Event");
    });
  });

  // ── Event update ───────────────────────────────────────────────────────────

  describe("event update", () => {
    it("updates an event title", () => {
      const event = connector.createEvent({
        title: "Old Title",
        start: new Date("2026-07-10T09:00:00Z"),
        end: new Date("2026-07-10T10:00:00Z"),
      });

      const updated = connector.updateEvent(event.id, { title: "New Title" });

      expect(updated.title).toBe("New Title");
      expect(connector.getEvent(event.id)!.title).toBe("New Title");
    });

    it("updates an event start and end time", () => {
      const event = connector.createEvent({
        title: "Moveable Meeting",
        start: new Date("2026-07-10T09:00:00Z"),
        end: new Date("2026-07-10T10:00:00Z"),
      });
      const newStart = new Date("2026-07-10T11:00:00Z");
      const newEnd = new Date("2026-07-10T12:00:00Z");

      const updated = connector.updateEvent(event.id, {
        start: newStart,
        end: newEnd,
      });

      expect(updated.start).toEqual(newStart);
      expect(updated.end).toEqual(newEnd);
    });

    it("throws when updating a non-existent event", () => {
      expect(() =>
        connector.updateEvent("ghost-id", { title: "Nope" })
      ).toThrow("not found");
    });
  });

  // ── Event deletion ─────────────────────────────────────────────────────────

  describe("event deletion", () => {
    it("deletes an existing event by id", () => {
      const event = connector.createEvent({
        title: "Ephemeral Meeting",
        start: new Date("2026-07-15T09:00:00Z"),
        end: new Date("2026-07-15T10:00:00Z"),
      });

      const deleted = connector.deleteEvent(event.id);

      expect(deleted).toBe(true);
      expect(connector.getEvent(event.id)).toBeUndefined();
    });

    it("returns false when deleting a non-existent event", () => {
      const result = connector.deleteEvent("does-not-exist");
      expect(result).toBe(false);
    });

    it("deleted event no longer appears in listing", () => {
      const event = connector.createEvent({
        title: "Remove Me",
        start: new Date("2026-07-20T09:00:00Z"),
        end: new Date("2026-07-20T10:00:00Z"),
      });
      connector.deleteEvent(event.id);

      const results = connector.listEvents(
        new Date("2026-07-20T00:00:00Z"),
        new Date("2026-07-21T00:00:00Z")
      );

      expect(results).toHaveLength(0);
    });
  });

  // ── RSVP handling ──────────────────────────────────────────────────────────

  describe("RSVP handling", () => {
    let eventId: string;

    beforeEach(() => {
      const event = connector.createEvent({
        title: "Party",
        start: new Date("2026-08-01T18:00:00Z"),
        end: new Date("2026-08-01T21:00:00Z"),
        attendees: [
          { email: "alice@example.com", name: "Alice" },
          { email: "bob@example.com", name: "Bob" },
          { email: "carol@example.com", name: "Carol" },
        ],
      });
      eventId = event.id;
    });

    it("attendee can accept the event", () => {
      const updated = connector.rsvp(eventId, "alice@example.com", "accepted");
      const alice = updated.attendees.find(
        (a) => a.email === "alice@example.com"
      );
      expect(alice!.rsvp).toBe("accepted");
    });

    it("attendee can decline the event", () => {
      const updated = connector.rsvp(eventId, "bob@example.com", "declined");
      const bob = updated.attendees.find((a) => a.email === "bob@example.com");
      expect(bob!.rsvp).toBe("declined");
    });

    it("attendee can mark tentative", () => {
      const updated = connector.rsvp(eventId, "carol@example.com", "tentative");
      const carol = updated.attendees.find(
        (a) => a.email === "carol@example.com"
      );
      expect(carol!.rsvp).toBe("tentative");
    });

    it("RSVP can be updated from accepted to declined", () => {
      connector.rsvp(eventId, "alice@example.com", "accepted");
      const updated = connector.rsvp(eventId, "alice@example.com", "declined");
      const alice = updated.attendees.find(
        (a) => a.email === "alice@example.com"
      );
      expect(alice!.rsvp).toBe("declined");
    });

    it("throws when RSVPing for an attendee not on the event", () => {
      expect(() =>
        connector.rsvp(eventId, "ghost@example.com", "accepted")
      ).toThrow("Attendee ghost@example.com not found");
    });

    it("throws when RSVPing for a non-existent event", () => {
      expect(() =>
        connector.rsvp("ghost-event", "alice@example.com", "accepted")
      ).toThrow("not found");
    });
  });

  // ── Attendee list ──────────────────────────────────────────────────────────

  describe("attendee list", () => {
    it("returns all attendees with their RSVP status", () => {
      const event = connector.createEvent({
        title: "All Hands",
        start: new Date("2026-09-01T10:00:00Z"),
        end: new Date("2026-09-01T11:00:00Z"),
        attendees: [
          { email: "alice@example.com" },
          { email: "bob@example.com" },
          { email: "carol@example.com" },
        ],
      });

      connector.rsvp(event.id, "alice@example.com", "accepted");
      connector.rsvp(event.id, "bob@example.com", "declined");

      const attendees = connector.getAttendees(event.id);

      expect(attendees).toHaveLength(3);
      expect(attendees.find((a) => a.email === "alice@example.com")!.rsvp).toBe(
        "accepted"
      );
      expect(attendees.find((a) => a.email === "bob@example.com")!.rsvp).toBe(
        "declined"
      );
      expect(attendees.find((a) => a.email === "carol@example.com")!.rsvp).toBe(
        "pending"
      );
    });

    it("returns a copy — mutating result does not affect stored event", () => {
      const event = connector.createEvent({
        title: "Immutable Test",
        start: new Date("2026-09-02T10:00:00Z"),
        end: new Date("2026-09-02T11:00:00Z"),
        attendees: [{ email: "dave@example.com" }],
      });

      const attendees = connector.getAttendees(event.id);
      attendees[0]!.rsvp = "declined";

      // Original should remain pending
      expect(connector.getAttendees(event.id)[0]!.rsvp).toBe("pending");
    });

    it("throws when getting attendees for a non-existent event", () => {
      expect(() => connector.getAttendees("ghost-id")).toThrow("not found");
    });
  });

  // ── Conflict detection ─────────────────────────────────────────────────────

  describe("conflict detection", () => {
    it("detects a conflict when two events overlap in time", () => {
      const a = connector.createEvent({
        title: "Meeting A",
        start: new Date("2026-07-10T09:00:00Z"),
        end: new Date("2026-07-10T10:30:00Z"),
      });
      const b = connector.createEvent({
        title: "Meeting B",
        start: new Date("2026-07-10T10:00:00Z"),
        end: new Date("2026-07-10T11:00:00Z"),
      });

      const conflict = connector.detectConflicts(a.id, b.id);
      expect(conflict).not.toBeNull();
    });

    it("returns null when events do not overlap", () => {
      const a = connector.createEvent({
        title: "Morning",
        start: new Date("2026-07-10T08:00:00Z"),
        end: new Date("2026-07-10T09:00:00Z"),
      });
      const b = connector.createEvent({
        title: "Afternoon",
        start: new Date("2026-07-10T10:00:00Z"),
        end: new Date("2026-07-10T11:00:00Z"),
      });

      const conflict = connector.detectConflicts(a.id, b.id);
      expect(conflict).toBeNull();
    });

    it("conflict report includes both event ids and the overlap window", () => {
      const a = connector.createEvent({
        title: "Alpha",
        start: new Date("2026-07-11T09:00:00Z"),
        end: new Date("2026-07-11T11:00:00Z"),
      });
      const b = connector.createEvent({
        title: "Beta",
        start: new Date("2026-07-11T10:00:00Z"),
        end: new Date("2026-07-11T12:00:00Z"),
      });

      const report = connector.detectConflicts(a.id, b.id);

      expect(report).not.toBeNull();
      expect(report!.eventA).toBe(a.id);
      expect(report!.eventB).toBe(b.id);
      expect(report!.overlapStart).toEqual(new Date("2026-07-11T10:00:00Z"));
      expect(report!.overlapEnd).toEqual(new Date("2026-07-11T11:00:00Z"));
    });

    it("events that share only a boundary point are not considered overlapping", () => {
      // End of A == Start of B: adjacent, not overlapping
      const a = connector.createEvent({
        title: "First",
        start: new Date("2026-07-12T09:00:00Z"),
        end: new Date("2026-07-12T10:00:00Z"),
      });
      const b = connector.createEvent({
        title: "Second",
        start: new Date("2026-07-12T10:00:00Z"),
        end: new Date("2026-07-12T11:00:00Z"),
      });

      const conflict = connector.detectConflicts(a.id, b.id);
      expect(conflict).toBeNull();
    });

    it("throws when detecting conflicts with a non-existent event", () => {
      const a = connector.createEvent({
        title: "Real Event",
        start: new Date("2026-07-13T09:00:00Z"),
        end: new Date("2026-07-13T10:00:00Z"),
      });

      expect(() => connector.detectConflicts(a.id, "ghost-id")).toThrow(
        "Event not found"
      );
    });

    it("fully contained event is detected as a conflict", () => {
      const outer = connector.createEvent({
        title: "Long Block",
        start: new Date("2026-07-14T08:00:00Z"),
        end: new Date("2026-07-14T17:00:00Z"),
      });
      const inner = connector.createEvent({
        title: "Short Meeting",
        start: new Date("2026-07-14T10:00:00Z"),
        end: new Date("2026-07-14T11:00:00Z"),
      });

      const conflict = connector.detectConflicts(outer.id, inner.id);
      expect(conflict).not.toBeNull();
    });
  });

  // ── All-day events ─────────────────────────────────────────────────────────

  describe("all-day event", () => {
    it("creates an event spanning a full day with allDay flag", () => {
      const event = connector.createEvent({
        title: "Company Holiday",
        start: new Date("2026-12-25T00:00:00Z"),
        end: new Date("2026-12-26T00:00:00Z"),
        allDay: true,
      });

      expect(event.allDay).toBe(true);
      expect(event.title).toBe("Company Holiday");
    });

    it("all-day event is included in date-range listing", () => {
      connector.createEvent({
        title: "All Day Holiday",
        start: new Date("2026-12-25T00:00:00Z"),
        end: new Date("2026-12-26T00:00:00Z"),
        allDay: true,
      });

      const results = connector.listEvents(
        new Date("2026-12-25T00:00:00Z"),
        new Date("2026-12-26T00:00:00Z")
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.allDay).toBe(true);
    });

    it("all-day event conflicts with a timed event on the same day", () => {
      const allDay = connector.createEvent({
        title: "Day Off",
        start: new Date("2026-12-25T00:00:00Z"),
        end: new Date("2026-12-26T00:00:00Z"),
        allDay: true,
      });
      const timed = connector.createEvent({
        title: "Emergency Call",
        start: new Date("2026-12-25T14:00:00Z"),
        end: new Date("2026-12-25T15:00:00Z"),
      });

      const conflict = connector.detectConflicts(allDay.id, timed.id);
      expect(conflict).not.toBeNull();
    });

    it("all-day flag defaults to undefined when not provided", () => {
      const event = connector.createEvent({
        title: "Regular Meeting",
        start: new Date("2026-07-01T09:00:00Z"),
        end: new Date("2026-07-01T10:00:00Z"),
      });

      expect(event.allDay).toBeUndefined();
    });
  });

  // ── Edge cases and integration ─────────────────────────────────────────────

  describe("edge cases", () => {
    it("multiple events can have independent attendee RSVP states", () => {
      const event1 = connector.createEvent({
        title: "Event 1",
        start: new Date("2026-07-01T09:00:00Z"),
        end: new Date("2026-07-01T10:00:00Z"),
        attendees: [{ email: "alice@example.com" }],
      });
      const event2 = connector.createEvent({
        title: "Event 2",
        start: new Date("2026-07-02T09:00:00Z"),
        end: new Date("2026-07-02T10:00:00Z"),
        attendees: [{ email: "alice@example.com" }],
      });

      connector.rsvp(event1.id, "alice@example.com", "accepted");

      const attendees2 = connector.getAttendees(event2.id);
      expect(attendees2[0]!.rsvp).toBe("pending");
    });

    it("listing with empty store returns empty array", () => {
      const results = connector.listEvents(
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-12-31T23:59:59Z")
      );
      expect(results).toHaveLength(0);
    });

    it("updated event is reflected in subsequent listing", () => {
      const event = connector.createEvent({
        title: "Movable",
        start: new Date("2026-07-01T09:00:00Z"),
        end: new Date("2026-07-01T10:00:00Z"),
      });

      connector.updateEvent(event.id, {
        start: new Date("2026-08-01T09:00:00Z"),
        end: new Date("2026-08-01T10:00:00Z"),
      });

      const julyResults = connector.listEvents(
        new Date("2026-07-01T00:00:00Z"),
        new Date("2026-07-31T23:59:59Z")
      );
      const augResults = connector.listEvents(
        new Date("2026-08-01T00:00:00Z"),
        new Date("2026-08-31T23:59:59Z")
      );

      expect(julyResults).toHaveLength(0);
      expect(augResults).toHaveLength(1);
    });
  });
});
