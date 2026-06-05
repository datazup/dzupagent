import type {
  PersistedTurnEvent,
  RawTurnEvent,
  StreamTurnEvent,
} from "./turn-event.js";

export interface RedactedEvents {
  persisted: PersistedTurnEvent;
  stream: StreamTurnEvent;
}

export interface RedactionPolicy {
  redact(event: RawTurnEvent): RedactedEvents;
}
