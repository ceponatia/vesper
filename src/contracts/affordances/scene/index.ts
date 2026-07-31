/**
 * The scene / body-relations owner
 * (romantic-contact-affordances.plan.md slice 3A;
 * romantic-contact-affordances.spec.scene.md).
 *
 * One lane-neutral owner for the physical facts a contact decision needs and
 * nobody in either lane holds today: where the bodies are, how they are
 * configured, what holds them up, and what that lets them reach.
 *
 * ```text
 * typed movement intent ─ actor-control law ─► scene state ─┬─► reach      ─► contact geometry read
 *                                                           ├─► support    ─► contact support read
 *                                                           └─► the contact projection, housed
 * ```
 *
 * Placement: a **sibling** of `affordances/contact/`, and one it depends on.
 * The contact core knows what a contact IS; this module knows where the bodies
 * are, which is the input the contact core deliberately refused to own. The
 * dependency runs one way only — `scene/` imports `contact/`, never the
 * reverse — so the contact core stays usable by a lane that has no scene model
 * at all and answers `unresolved` instead.
 *
 * **The point of the module** is stated most sharply by what it will not
 * accept: there is no way to source a fact here from narrator prose. Movement
 * arrives as a typed intent with an origin of `player`, `npc`, or `simulation`;
 * every stored fact carries one of five provenance sources, none of which is a
 * sentence; and a fact nobody stated is absent, which makes the reads that
 * depend on it answer `unresolved` rather than guess. A narrator may describe a
 * movement, and that description remains exactly what it was — narration —
 * until the side that owns the body commits it.
 *
 * ## What it owns
 *
 * - participant posture, and coarse facing and proximity;
 * - support roles and support surfaces — who or what bears weight, leans, holds;
 * - coarse surface-height relationships, and the reach they imply;
 * - the contact core's active-contact projection, housed for retake capture;
 * - structured player/NPC movement intents and the actor-control law over them;
 * - a versioned, serializable, replayable snapshot of all of it;
 * - provenance on every authoritative fact and every read.
 *
 * ## What it is not
 *
 * No coordinates, no pathfinding, no collision, no gait, no balance. Positions
 * are rungs on a six-name ladder and distances are four bands, because the
 * question is "can this surface meet that one", not "where is everybody". No
 * production wiring and no registry entry: 3A is fixture-driven contracts, and
 * the lane adapter is a later slice.
 *
 * Import direction, enforced by the `src/contracts` purity rule: this module
 * may import `../core`, `../contact`, `../../body/locations`,
 * `../../diagnostics`, and `@/lib/*`. It may never import `../domains/*`,
 * `../guidance`, `@/server`, `@/app`, or `@/components`.
 */
export * from "./vocabulary";
export * from "./provenance";
export * from "./diagnostics";
export * from "./state";
export * from "./intents";
export * from "./relations";
export * from "./snapshot";
