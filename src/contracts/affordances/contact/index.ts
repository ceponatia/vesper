/**
 * The shared contact core (romantic-contact-affordances.plan.md slice 1;
 * romantic-contact-affordances.spec.contact-core.md).
 *
 * One lane-neutral lifecycle for physical contact between two surfaces:
 *
 * ```text
 * attempt → resolve → rejected | unresolved | explicit transition required | committable
 *                                                                              │
 *                                          start ─ update ─ continue ─ end ◄───┘
 * ```
 *
 * Placement: a **sibling** of `affordances/core/` and `affordances/guidance/`,
 * for the reason `guidance/` is one. The core stages a calculation it knows
 * nothing about; this layer knows what a contact IS — two surfaces, what lies
 * between them, who was allowed to make it happen — and that is domain knowledge
 * the core may not learn. It is still domain-NEUTRAL: it names no anatomy, no
 * garment, no foot and no intimate region, which its own
 * `domain-neutrality.test.ts` polices (`core/domain-neutrality.test.ts` covers
 * only `core/`).
 *
 * Import direction, enforced by that test and by the `src/contracts` purity rule:
 *
 * ```text
 * body/locations + contracts/diagnostics + lib
 *         → affordances/core
 *         → affordances/contact
 *         → domain contact layers (foot, intimate) and lane adapters under src/server
 * ```
 *
 * `contact/` may import `../core`, `../../body/locations`, `../../diagnostics`,
 * and `@/lib/*`. It may never import `../domains/*`, `../guidance`, `@/server`,
 * `@/app`, or `@/components` — the narrator seam consumes a resolution, it does
 * not participate in producing one.
 *
 * What is deliberately NOT here in slice 1: observations, phenomena, cue
 * ranking, effect commits, perception filtering, and any lane wiring or storage.
 * The audit records pose, reach, support, and material-between as unowned in
 * both lanes, so the resolver takes them as `AdapterRead`s and answers
 * `unresolved` when nobody can speak.
 */
export * from "./identity";
export * from "./surfaces";
export * from "./material";
export * from "./decisions";
export * from "./types";
export * from "./diagnostics";
export * from "./resolve";
export * from "./lifecycle";
export * from "./state";
