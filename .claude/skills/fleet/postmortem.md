---
name: fleet:postmortem
description: Use after a fleet run completes (or fails) — reads decisions and lessons, drafts a postmortem markdown.
---

# fleet:postmortem

Steps:

1. Run `yarn fleet:postmortem --run <runRoot> --run-id <id>` to dump decisions, lessons, and contract changes.
2. For each decision, note: what was decided, by which policy, with what outcome. Highlight escalations.
3. For each lesson with `scope=workspace` or appearing in ≥ 3 runs, propose promotion to `memory/feedback_*.md`. Promotion requires human ratification (see spec §5.5).
4. Write the postmortem to `out/fleet-runs/<scenario>-<date>/run-<id>/POSTMORTEM.md` with sections: Summary, Decisions, Lessons, Contracts, Follow-ups.
