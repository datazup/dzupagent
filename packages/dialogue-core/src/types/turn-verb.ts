export const TURN_VERBS = [
  "deliberate",
  "implement",
  "validate",
  "review",
  "decide",
  "handoff",
] as const;

export type TurnVerb = (typeof TURN_VERBS)[number];
