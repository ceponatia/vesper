/**
 * Visual affordances.
 *
 * Turns stable appearance and trustworthy live state into a few grounded,
 * perception-safe observations. Pure and lane-neutral: the chat and successor
 * adapters normalize their own authoritative reads into these contracts rather
 * than forking the calculation.
 */
export * from "./core";
export * from "./contact";
export * from "./permission";
export * from "./scene";
export * from "./domains/hair";
export * from "./domains/garment";
export * from "./domains/foot";
export * from "./domains";
export * from "./derive-affordance-read";
export * from "./recognition";
export * from "./guidance";
