/**
 * Leaf contracts shared by the LLM verdict judge and its guard decorators.
 *
 * `team-verdict-judge-controls.ts` decorates a judge invoker and
 * `team-verdict-llm-judge.ts` consumes one, so both need the invoker's shape.
 * Declaring it in either implementation module made the pair mutually
 * importing; it lives here instead. This module MUST NOT import from any
 * non-contract sibling — that is what keeps it a leaf.
 */

/**
 * Invokes a model with a prompt and returns its raw text.
 *
 * Deliberately a bare callback rather than a `BaseChatModel`: it keeps the
 * judge modules free of any provider dependency and lets a host route the judge
 * through whatever registry, budget, or cache it already has.
 */
export type JudgeInvoker = (prompt: string) => Promise<string>;
