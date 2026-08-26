/**
 * The application's entry point for the boundary parser.
 *
 * The implementation lives in `@vesper/contracts` alongside the diagnostic
 * contract it reports through. This file stays because it is a genuine
 * application-facing API; it is a re-export barrel and holds no implementation.
 *
 * Every value crossing a trust boundary — JSONB columns, LLM output, request
 * bodies, file payloads — goes through it: docs/resilience.md §1.
 */

export { parseOr, parseOrNull } from "@vesper/contracts";
