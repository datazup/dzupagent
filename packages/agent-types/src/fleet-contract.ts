/**
 * Public entry point for the framework-free fleet conformance contracts.
 *
 * Kept separate from `./fleet.js` so that importing the type surface never
 * drags the contract case bodies into a production bundle.
 */
export * from "./orchestration/fleet/knowledge-store-contract.js";
