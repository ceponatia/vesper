import { bodyLocationRegistry } from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";
import type { BodyMarkProposal } from "../affordances/contact";
import {
  bodySurfaceMarkKinds,
  bodySurfaceMarkSlot,
  BODY_SURFACE_MARK_ID_MAX_LENGTH,
  BODY_SURFACE_MAX_MARKS,
  commitBodySurfaceMark,
  isInvalidMarkSlot,
  pruneFadedBodySurfaceMarks,
  type BodySurfaceMarkBand,
  type BodySurfaceMarkKind,
  type BodySurfaceState,
} from "../state/body-surface";
import type { ChatSurfaceTraceEntry } from "./chat-surface-ops";

/**
 * The body-surface owner's side of the contact-effect transaction: validate a
 * `BodyMarkProposal` against the owner's own vocabulary and current state, and
 * commit it — or refuse with a stable code.
 *
 * The design law is `chat-surface-ops.ts`'s, verbatim: a proposal is a small
 * semantic sentence, never a state value, and this module maps it
 * deterministically onto the owner in `state/body-surface.ts`. A hallucinated
 * magnitude is unreachable (the band table is the owner's), and so is a mark
 * kind no owner supports — which is where "scratch stays unavailable" is
 * ENFORCED, not just documented: a proposal whose `markKind` is outside
 * `bodySurfaceMarkKinds` refuses with a diagnostic instead of committing the
 * nearest supported thing.
 *
 * Failure law: every refusal is a drop with a stable
 * `contact_effects.*` code, never a throw, and a refused proposal has NO
 * observable result — the returned surface is the input surface for that item.
 */

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** The proposal named a mark kind the body-surface owner does not support (the scratch fence). */
export const CONTACT_EFFECT_KIND_UNSUPPORTED = "contact_effects.kind_unsupported";

/** The proposal named a body location the shared registry does not know. */
export const CONTACT_EFFECT_LOCUS_UNKNOWN = "contact_effects.locus_unknown";

/** The proposal's idempotency key failed the owner's bounds — refused, never truncated. */
export const CONTACT_EFFECT_KEY_INVALID = "contact_effects.key_invalid";

/** The mark record is full; the commit was refused rather than evicting a standing mark. */
export const CONTACT_EFFECT_CAPACITY = "contact_effects.capacity";

/** A proposal addressed a body no implemented owner backs — recorded by the lane, committed by nobody. */
export const CONTACT_EFFECT_OWNER_UNAVAILABLE = "contact_effects.owner_unavailable";

/** Max mark proposals accepted from one exchange — one act proposes one mark; this is headroom, not a lane. */
export const CHAT_CONTACT_EFFECT_MAX = 4;

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ChatContactEffectFold {
  surface: BodySurfaceState;
  trace: ChatSurfaceTraceEntry[];
}

/**
 * The proposal's shared-vocabulary band, in the owner's own band type. The two
 * vocabularies carry the same three members by design; stating the map (rather
 * than casting) makes an owner-side rename a compile error here instead of a
 * silently dropped band.
 */
const PROPOSAL_BAND: Readonly<Record<BodyMarkProposal["magnitudeBand"], BodySurfaceMarkBand>> = {
  subtle: "subtle",
  clear: "clear",
  strong: "strong",
};

function isOwnedMarkKind(kind: string): kind is BodySurfaceMarkKind {
  return (bodySurfaceMarkKinds as readonly string[]).includes(kind);
}

/**
 * Fold this exchange's mark proposals onto the surface state. PURE — the caller
 * persists, exactly as with `applySurfaceWetnessProposals`, and the fold prunes
 * fully faded marks first (integrate on write; the prune cannot change any
 * read).
 *
 * Outcomes per proposal, on the trace:
 *
 * - `applied` — validated and committed at the proposal's exact locus.
 * - `no_change` — a VALID mark already stands under this idempotency key: the
 *   designed retry answer, reported without a diagnostic
 *   because nothing degraded.
 * - `rejected` — refused with its `contact_effects.*` code and a diagnostic;
 *   the surface is untouched by that item.
 */
export function applyBodyMarkProposals(input: {
  surface: BodySurfaceState;
  proposals: readonly BodyMarkProposal[];
  atMinutes: number;
  sink?: DiagnosticSink;
}): ChatContactEffectFold {
  let surface = pruneFadedBodySurfaceMarks(input.surface, input.atMinutes);
  const trace: ChatSurfaceTraceEntry[] = [];

  const reject = (proposal: BodyMarkProposal, code: string, detail: string): void => {
    trace.push({ kind: "mark", target: proposal.locus.locationId, outcome: "rejected", code, detail });
    input.sink?.push(diag("warn", code, detail, { context: { idempotencyKey: proposal.idempotencyKey } }));
  };

  for (const proposal of input.proposals.slice(0, CHAT_CONTACT_EFFECT_MAX)) {
    if (!isOwnedMarkKind(proposal.markKind)) {
      reject(proposal, CONTACT_EFFECT_KIND_UNSUPPORTED, `no owner for mark kind "${proposal.markKind}" — nothing committed`);
      continue;
    }
    if (bodyLocationRegistry.byId(proposal.locus.locationId) === undefined) {
      reject(proposal, CONTACT_EFFECT_LOCUS_UNKNOWN, `no body location "${proposal.locus.locationId}" — mark dropped`);
      continue;
    }
    if (proposal.idempotencyKey.length === 0 || proposal.idempotencyKey.length > BODY_SURFACE_MARK_ID_MAX_LENGTH) {
      reject(proposal, CONTACT_EFFECT_KEY_INVALID, "idempotency key outside the owner's bounds — mark dropped");
      continue;
    }
    const standing = bodySurfaceMarkSlot(surface, proposal.idempotencyKey);
    if (standing !== undefined && !isInvalidMarkSlot(standing)) {
      // The retry law: this causal event already committed. Nothing to do,
      // nothing degraded, and saying so on the trace is the whole record.
      trace.push({ kind: "mark", target: proposal.locus.locationId, outcome: "no_change", code: "", detail: "already committed under this event" });
      continue;
    }
    const before = surface;
    surface = commitBodySurfaceMark(surface, {
      markId: proposal.idempotencyKey,
      locationId: proposal.locus.locationId,
      kind: proposal.markKind,
      band: PROPOSAL_BAND[proposal.magnitudeBand],
      atMinutes: input.atMinutes,
      ...(proposal.locus.side === undefined ? {} : { side: proposal.locus.side }),
      ...(proposal.locus.detail === undefined ? {} : { detail: proposal.locus.detail }),
    });
    if (surface === before) {
      // The owner refused — with the duplicate case already answered above,
      // the one remaining refusal is capacity.
      reject(proposal, CONTACT_EFFECT_CAPACITY, `mark record is full (${BODY_SURFACE_MAX_MARKS}) — mark dropped`);
      continue;
    }
    trace.push({
      kind: "mark",
      target: proposal.locus.locationId,
      outcome: "applied",
      code: "",
      detail: `${proposal.markKind} ${PROPOSAL_BAND[proposal.magnitudeBand]}`,
    });
  }

  return { surface, trace };
}
