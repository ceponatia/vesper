/**
 * Narrator Prompt Lab contracts — the pure shapes shared by the prompt builders,
 * the admin API, the Prompt Lab UI and the take browser
 * (narrator-prompt-lab.plan.md).
 *
 * Four groups, and nothing else: the prompt **authority IR** the builders emit,
 * the **template/revision** shapes and their API request schemas, the resolved
 * **instruction source** one exchange freezes, and the **run provenance** every
 * take records. Pure — no IO, no database, no environment.
 */
export * from "./authority";
export * from "./template";
export * from "./instruction-source";
export * from "./provenance";
