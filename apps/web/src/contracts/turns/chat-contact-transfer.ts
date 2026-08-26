import { bodyLocationRegistry } from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";
import type { SurfaceTransferProposal } from "../affordances/contact";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core";
import { garmentInstanceById } from "../items/garment-store";
import type { ChatGarmentStore, GarmentOperation } from "../items/garment-instance";
import { applyGarmentOperations } from "../items/garment-presentation";
import {
  acceptBodySurfaceDeposit,
  bodySurfaceDepositSlot,
  bodySurfaceTransferCommitted,
  isInvalidDepositSlot,
  recordBodySurfaceTransferReceipt,
  takeBodySurfaceDeposit,
  BODY_SURFACE_MARK_ID_MAX_LENGTH,
  type BodySurfaceState,
} from "../state/body-surface";
import type { SurfaceDepositKind } from "../materials/surface-deposits";
import type { ChatSurfaceTraceEntry } from "./chat-surface-ops";

/**
 * The conserved-transfer transaction — §9's second effect proof
 * (romantic-contact-affordances.spec.effects.md §9, §15 stage 8; owner rulings
 * 2026-08-25 and 2026-08-26).
 *
 * The pressure mark's transaction validates one proposal against one owner. A
 * transfer is a different animal: it debits one owner, credits one to several
 * others, and §9's law is that all of that is true together or none of it is.
 *
 * **The governing rule is: planning may degrade, transactions may not.** Before
 * anything moves, this module may discover an unresolvable layer, an absent
 * source, or a destination that cannot take what is coming and refuse the whole
 * thing. Once it has taken material off the source, every remaining leg must
 * land exactly, or the entire settlement is discarded and the caller receives
 * the owners it passed in, by reference. There is no partial success and no
 * "committed but degraded" state — those would make §9's "retake removes both
 * sides or neither" unprovable, because there would be nothing exact to undo.
 *
 * That all-or-nothing property is STRUCTURAL here, not checked afterwards: every
 * owner is folded on a local copy, and a refusal simply never returns them.
 *
 * **Conservation is structural too.** Material is stepped through the path one
 * layer at a time in the actual units being moved, and what a layer keeps is
 * derived by SUBTRACTION from what reached it:
 *
 * ```text
 * carried₀ = D                                  (what the source actually lost)
 * carried₍ᵢ₊₁₎ = floor(carriedᵢ × throughputᵢ / ONE)
 * retainedᵢ  = carriedᵢ − carried₍ᵢ₊₁₎
 * destination = carried_final
 * ```
 *
 * so `D = Σ retainedᵢ + destination` by construction, with every integer
 * remainder staying on the layer that failed to pass it. Composing the
 * coefficients first and applying `D` once would floor differently and could
 * lose a unit into nowhere — harmless for a sensory channel, fatal for material
 * accounting.
 *
 * **Where the boundary between owners is enforced.** Contact never edits worn
 * layers, and neither does this module: an intermediate leg becomes a typed
 * operation that the layer's own owner validates and commits (§10). And every
 * credit is verified by reading the owner BACK — the delta it actually applied
 * must equal the exact number this transaction planned. That check is what
 * makes the law independent of any owner's internal merge or capacity policy;
 * an owner that clamped, evicted, or max-merged a conserved credit fails here
 * instead of silently breaking conservation.
 *
 * FIXTURE-ONLY, by the 2026-08-25 owner ruling: no chat-lane producer resolves a
 * source material read or a path, so nothing in production reaches this module.
 * What it proves is the transaction, and the transaction is the point.
 */

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** The proposal named a body location the shared registry does not know. */
export const SURFACE_TRANSFER_LOCUS_UNKNOWN = "surface_transfer.locus_unknown";

/** The idempotency key failed the owner's bounds — refused, never truncated. */
export const SURFACE_TRANSFER_KEY_INVALID = "surface_transfer.key_invalid";

/** A path layer's handle resolved to nothing the lane can address. Nothing moved. */
export const SURFACE_TRANSFER_LAYER_UNRESOLVED = "surface_transfer.layer_unresolved";

/** The source record is gone, unreadable, or holds a different substance than the proposal read. */
export const SURFACE_TRANSFER_SOURCE_STALE = "surface_transfer.source_stale";

/** An intermediate leg's owner did not credit exactly what it was given. Whole settlement discarded. */
export const SURFACE_TRANSFER_LAYER_REFUSED = "surface_transfer.layer_refused";

/** The destination surface refused its leg — saturated, quarantined, or full. */
export const SURFACE_TRANSFER_DESTINATION_REFUSED = "surface_transfer.destination_refused";

/** The receipt could not be written, so the debit must not stand. */
export const SURFACE_TRANSFER_RECEIPT_REFUSED = "surface_transfer.receipt_refused";

/** Max transfer settlements accepted from one exchange. Headroom, not a lane. */
export const CHAT_SURFACE_TRANSFER_MAX = 2;

// ---------------------------------------------------------------------------
// The owners a transfer touches
// ---------------------------------------------------------------------------

/**
 * Every authoritative value one settlement may move. They travel together
 * because they commit together: the caller persists this whole record inside
 * one database transaction or persists none of it.
 *
 * `source` and `destination` are two different characters' surfaces in the
 * general case, and ONE surface when a character moves material across their own
 * body — wiping a muddy hand on their own thigh. The transaction reads which of
 * those it is from the proposal's own subject ids rather than from reference
 * equality, and chains the credit onto the debited value in the self case.
 * Folding a debit and a credit onto two copies of one surface independently
 * would silently keep whichever fold was written last and lose the other, which
 * looks exactly like conservation right up until anyone reads the row.
 */
export interface SurfaceTransferOwners {
  readonly source: BodySurfaceState;
  readonly destination: BodySurfaceState;
  readonly layers: ChatGarmentStore;
}

/** How a lane turns an opaque path handle into an address its layer owner can validate. */
export type SurfaceTransferLayerResolver = (
  layerId: string,
) => { readonly instanceId: string; readonly partIds: readonly string[] } | undefined;

/** One credit in the committed equation. `target` is a layer handle or the destination locus. */
export interface SurfaceTransferCredit {
  readonly target: string;
  readonly amount: number;
}

/**
 * The exact equation a committed settlement made true. Evidence for the trace,
 * and the thing a test asserts against rather than re-deriving.
 */
export interface SurfaceTransferLedger {
  readonly transferKey: string;
  readonly kind: SurfaceDepositKind;
  /** What actually left the source. Every credit below sums to exactly this. */
  readonly debited: number;
  readonly credits: readonly SurfaceTransferCredit[];
}

export type SurfaceTransferSettlement =
  | {
      readonly status: "committed";
      readonly owners: SurfaceTransferOwners;
      readonly ledger: SurfaceTransferLedger;
      readonly trace: readonly ChatSurfaceTraceEntry[];
    }
  /** This causal identity already committed. The designed retry answer: nothing changed, nothing degraded. */
  | { readonly status: "no_change"; readonly trace: readonly ChatSurfaceTraceEntry[] }
  | { readonly status: "refused"; readonly code: string; readonly trace: readonly ChatSurfaceTraceEntry[] };

// ---------------------------------------------------------------------------
// Reading a layer owner back
// ---------------------------------------------------------------------------

/**
 * How much of one substance the named instance carries, summed across its
 * records.
 *
 * Read twice per credit, before and after, so the transaction can insist the
 * owner applied EXACTLY the planned number. Summing rather than addressing one
 * record is deliberate: the owner chooses its own record identity and may
 * legitimately merge a credit into a standing record or open a new one, and the
 * conserved quantity is the total either way.
 */
function layerDepositTotal(store: ChatGarmentStore, instanceId: string, kind: SurfaceDepositKind): number {
  const instance = garmentInstanceById(store, instanceId);
  if (instance === undefined) return 0;
  let total = 0;
  for (const deposit of instance.condition.deposits) {
    if (deposit.kind === kind) total += deposit.intensity;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

/**
 * Settle one conserved transfer, or change nothing.
 *
 * Order matters and is the law's order:
 *
 * 1. **The receipt first.** A standing receipt short-circuits before any debit,
 *    which is the only way an ADDING credit can tell a retry from a second
 *    helping of the same substance.
 * 2. **Preflight everything that can be known without moving material** —
 *    registry membership, key bounds, path resolution, and that the source
 *    record still holds the substance the proposal read.
 * 3. **Debit, and let the debit define the equation.** `D` is what actually
 *    left, never what was asked for.
 * 4. **Credit every leg exactly, verifying each against its owner.**
 * 5. **Write the receipt onto the debited surface**, so it cannot outlive the
 *    debit under any rollback.
 *
 * Never throws. Every refusal is a drop with a stable `surface_transfer.*` code
 * and no observable result (docs/resilience.md; effects spec §14).
 */
export function applySurfaceTransferProposal(input: {
  proposal: SurfaceTransferProposal;
  owners: SurfaceTransferOwners;
  resolveLayer: SurfaceTransferLayerResolver;
  atMinutes: number;
  sink?: DiagnosticSink;
}): SurfaceTransferSettlement {
  const { proposal, owners } = input;
  const atMinutes = Math.max(0, Math.trunc(input.atMinutes));
  const locus = proposal.material.locus.locationId;

  const refuse = (code: string, detail: string): SurfaceTransferSettlement => {
    input.sink?.push(diag("warn", code, detail, { context: { idempotencyKey: proposal.idempotencyKey } }));
    return {
      status: "refused",
      code,
      trace: [{ kind: "transfer", target: locus, outcome: "rejected", code, detail }],
    };
  };

  // 1. The retry law. Asked of the surface that would be DEBITED, because that
  //    is the surface the receipt rides and rolls back with.
  if (bodySurfaceTransferCommitted(owners.source, proposal.idempotencyKey)) {
    return {
      status: "no_change",
      trace: [
        { kind: "transfer", target: locus, outcome: "no_change", code: "", detail: "already committed under this event" },
      ],
    };
  }

  // 2. Preflight.
  if (proposal.idempotencyKey.length === 0 || proposal.idempotencyKey.length > BODY_SURFACE_MARK_ID_MAX_LENGTH) {
    return refuse(SURFACE_TRANSFER_KEY_INVALID, "idempotency key outside the owner's bounds — nothing moved");
  }
  if (bodyLocationRegistry.byId(locus) === undefined) {
    return refuse(SURFACE_TRANSFER_LOCUS_UNKNOWN, `no body location "${locus}" — nothing moved`);
  }
  const destinationLocus = proposal.path.destination.locationId;
  if (bodyLocationRegistry.byId(destinationLocus) === undefined) {
    return refuse(SURFACE_TRANSFER_LOCUS_UNKNOWN, `no body location "${destinationLocus}" — nothing moved`);
  }
  const resolved: { layerId: string; instanceId: string; partIds: readonly string[]; throughput: number }[] = [];
  for (const layer of proposal.path.layers) {
    const address = input.resolveLayer(layer.layerId);
    if (address === undefined) {
      return refuse(SURFACE_TRANSFER_LAYER_UNRESOLVED, `path layer "${layer.layerId}" addresses no owner — nothing moved`);
    }
    resolved.push({ layerId: layer.layerId, ...address, throughput: layer.throughput });
  }
  // The proposal read the source OUTSIDE this cut. Re-reading it here is what
  // stops a stale proposal debiting a record that has since been washed off,
  // replaced by a different substance, or corrupted.
  const standing = bodySurfaceDepositSlot(owners.source, proposal.material.depositId);
  if (standing === undefined || isInvalidDepositSlot(standing) || standing.kind !== proposal.material.kind) {
    return refuse(
      SURFACE_TRANSFER_SOURCE_STALE,
      `source record "${proposal.material.depositId}" no longer holds ${proposal.material.kind} — nothing moved`,
    );
  }

  // 3. The debit defines the equation.
  const taken = takeBodySurfaceDeposit(owners.source, {
    depositId: proposal.material.depositId,
    amount: proposal.amount,
  });
  if (taken.taken <= 0) {
    return refuse(SURFACE_TRANSFER_SOURCE_STALE, "source record had nothing left to move — nothing moved");
  }
  const debited = taken.taken;

  // 4. Step the actual units through the path, crediting each layer exactly
  //    what it kept.
  // Provenance, not identity: every credit says where the material came from,
  // in the words a later reader would want ("transferred from hands"). The
  // contact's own sub-surface token is deliberately NOT used — it names a place
  // on a body, not a reason, and putting it here would make an opaque domain
  // token surface in prose.
  const cause = `transferred from ${locus}`.slice(0, 80);
  // One body on both ends means one surface. The credit chains onto the value
  // the debit produced; anything else drops one half of the equation.
  const sameBody = proposal.sourceSubjectId === proposal.targetSubjectId;
  let carried = debited;
  let layerStore = owners.layers;
  const credits: SurfaceTransferCredit[] = [];
  const trace: ChatSurfaceTraceEntry[] = [];
  for (const layer of resolved) {
    const passed = Math.floor((carried * layer.throughput) / AFFORDANCE_UNIT_ONE);
    const retained = carried - passed;
    carried = passed;
    if (retained <= 0) continue;
    const before = layerDepositTotal(layerStore, layer.instanceId, proposal.material.kind);
    const operation: GarmentOperation = {
      kind: "accept_transfer",
      garmentId: layer.instanceId,
      partIds: [...layer.partIds],
      depositKind: proposal.material.kind,
      amount: retained,
      cause,
    };
    const result = applyGarmentOperations(layerStore, [operation], {
      atMinutes,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
    const after = layerDepositTotal(result.store, layer.instanceId, proposal.material.kind);
    if (after - before !== retained) {
      // The owner refused, clamped, evicted, or merged. Any of those breaks
      // conservation, and none of them is a reason to keep the debit.
      return refuse(
        SURFACE_TRANSFER_LAYER_REFUSED,
        `layer "${layer.layerId}" credited ${after - before} of ${retained} — whole settlement discarded`,
      );
    }
    layerStore = result.store;
    credits.push({ target: layer.layerId, amount: retained });
    trace.push({ kind: "transfer", target: layer.layerId, outcome: "applied", code: "", detail: `+${retained}` });
  }

  // The destination leg. Zero is legitimate and common: a fully blocking layer
  // kept everything, which is a transfer whose destination happened to be the
  // thing in the way rather than a transfer that failed.
  let destination = sameBody ? taken.state : owners.destination;
  if (carried > 0) {
    const accepted = acceptBodySurfaceDeposit(destination, {
      locationId: destinationLocus,
      kind: proposal.material.kind,
      amount: carried,
      atMinutes,
      cause,
    });
    if (accepted.status === "refused") {
      return refuse(
        SURFACE_TRANSFER_DESTINATION_REFUSED,
        `destination refused ${carried} (${accepted.reason}) — whole settlement discarded`,
      );
    }
    destination = accepted.state;
    credits.push({ target: destinationLocus, amount: carried });
    trace.push({ kind: "transfer", target: destinationLocus, outcome: "applied", code: "", detail: `+${carried}` });
  }

  // 5. The receipt, onto the surface that was debited.
  const receipt = recordBodySurfaceTransferReceipt(sameBody ? destination : taken.state, {
    transferKey: proposal.idempotencyKey,
    amount: debited,
    atMinutes,
  });
  if (receipt.status === "refused") {
    return refuse(
      SURFACE_TRANSFER_RECEIPT_REFUSED,
      `receipt could not be written (${receipt.reason}) — whole settlement discarded`,
    );
  }

  return {
    status: "committed",
    owners: {
      source: receipt.state,
      destination: sameBody ? receipt.state : destination,
      layers: layerStore,
    },
    ledger: { transferKey: proposal.idempotencyKey, kind: proposal.material.kind, debited, credits },
    trace: [
      { kind: "transfer", target: locus, outcome: "applied", code: "", detail: `-${debited}` },
      ...trace,
    ],
  };
}

/**
 * Settle this exchange's transfers in order, threading the owners forward.
 *
 * Sequential and not independent, deliberately: two transfers off the same
 * surface in one exchange are the second one seeing what the first one left,
 * which is the only reading that conserves. A refused settlement leaves the
 * owners exactly as the previous one did and the walk continues — a refusal is
 * one transfer that did not happen, not a poisoned exchange.
 */
export function applySurfaceTransferProposals(input: {
  proposals: readonly SurfaceTransferProposal[];
  owners: SurfaceTransferOwners;
  resolveLayer: SurfaceTransferLayerResolver;
  atMinutes: number;
  sink?: DiagnosticSink;
}): {
  owners: SurfaceTransferOwners;
  ledgers: readonly SurfaceTransferLedger[];
  trace: readonly ChatSurfaceTraceEntry[];
  committed: number;
} {
  let owners = input.owners;
  const ledgers: SurfaceTransferLedger[] = [];
  const trace: ChatSurfaceTraceEntry[] = [];
  let committed = 0;
  for (const proposal of input.proposals.slice(0, CHAT_SURFACE_TRANSFER_MAX)) {
    const settlement = applySurfaceTransferProposal({
      proposal,
      owners,
      resolveLayer: input.resolveLayer,
      atMinutes: input.atMinutes,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
    trace.push(...settlement.trace);
    if (settlement.status !== "committed") continue;
    owners = settlement.owners;
    ledgers.push(settlement.ledger);
    committed += 1;
  }
  return { owners, ledgers, trace, committed };
}
