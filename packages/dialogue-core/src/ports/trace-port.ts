import type {
  PersistedTurnEvent,
  StreamTurnEvent,
} from "../types/turn-event.js";

export interface TracePort {
  emit(event: PersistedTurnEvent | StreamTurnEvent): Promise<void>;
}
