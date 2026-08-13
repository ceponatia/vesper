/**
 * The lane-neutral affordance core (body-attribute-affordances.spec.code-organization.md).
 *
 * Import direction is one-way and enforced by review: attribute/body/item
 * contracts → core → domain definitions → lane adapters under `src/server`.
 * **The core may never import a domain**, and it names none: no hair, no skin,
 * no garments, no anatomy. Everything a domain needs is a type parameter, a
 * registry entry, or a string key it owns itself.
 */
export * from "./evidence";
export * from "./fixed-point";
export * from "./types";
export * from "./perception";
export * from "./ranking";
export * from "./registry";
