import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { affordanceSubjectId } from "../core";
import {
  CONTACT_PERMISSION_SCOPE_MISSING,
  CONTACT_PERMISSION_UNAVAILABLE,
} from "../contact/diagnostics";
import { resolveContactAttempt } from "../contact/resolve";
import {
  PROBE_ACTOR,
  PROBE_TARGET,
  probeAttempt,
  probeBodySurface,
} from "../contact/test-support";
import type { ContactActionKind, ContactInteractionPolicyRead } from "../contact";
import { derivePermissionPolicyRead } from "./policy";
import { foldRomanticPermissionProjection, type RomanticPermissionProjection } from "./projection";
import { probePermissionEvent } from "./test-support";

/**
 * The resolver-adapter mapping, and
 * the whole seam end to end: the same derived read handed to the REAL contact
 * resolver, so a grant commits, a withdrawal refuses, absence falls silent, an
 * exact scope never widens, and the player-target exception passes without a
 * grant anybody manufactured.
 *
 * Direction fixtures reuse the contact core's probe identities: the projection
 * speaks about PROBE_ACTOR → PROBE_TARGET, which is exactly the attempt
 * `probeAttempt` builds.
 */

const PLAYER = affordanceSubjectId("player");

/** A projection folded from real events — never a hand-built literal. */
function projectionOf(...events: Parameters<typeof foldRomanticPermissionProjection>[0]["events"]) {
  return foldRomanticPermissionProjection({ events });
}

const GRANT = probePermissionEvent({
  eventId: "evt_grant",
  permittedActorId: PROBE_ACTOR,
  grantingTargetId: PROBE_TARGET,
});
const WITHDRAW = probePermissionEvent({
  eventId: "evt_withdraw",
  kind: "withdrawn",
  permittedActorId: PROBE_ACTOR,
  grantingTargetId: PROBE_TARGET,
  storyTime: 120,
});

function read(
  projection: RomanticPermissionProjection,
  overrides: {
    actionKind?: ContactActionKind;
    permittedActorId?: typeof PROBE_ACTOR;
    grantingTargetId?: typeof PROBE_TARGET;
    attemptActionId?: string;
    attemptContactId?: string;
  } = {},
): ContactInteractionPolicyRead {
  return derivePermissionPolicyRead({
    projection,
    permittedActorId: overrides.permittedActorId ?? PROBE_ACTOR,
    grantingTargetId: overrides.grantingTargetId ?? PROBE_TARGET,
    actionKind: overrides.actionKind ?? "romantic",
    playerSubjectId: PLAYER,
    ...(overrides.attemptActionId === undefined ? {} : { attemptActionId: overrides.attemptActionId }),
    ...(overrides.attemptContactId === undefined ? {} : { attemptContactId: overrides.attemptContactId }),
  });
}

describe("derivePermissionPolicyRead", () => {
  it("answers allowed for a standing exact grant, citing the deciding event", () => {
    const policy = read(projectionOf(GRANT));
    expect(policy.status).toBe("allowed");
    expect(policy.scopes).toEqual(["romantic_touch"]);
    expect(policy.evidence.map((entry) => entry.ref)).toEqual(["permission:evt_grant"]);
  });

  it("never lets a reverse-direction grant authorize the attempt", () => {
    // Mara granted ALEX — so an attempt where the roles are swapped finds no
    // record at all: the answer is silence, never a borrowed yes.
    const reversed = projectionOf(
      probePermissionEvent({
        eventId: "evt_reverse",
        permittedActorId: PROBE_TARGET,
        grantingTargetId: PROBE_ACTOR,
      }),
    );
    expect(read(reversed).status).toBe("unresolved");
  });

  it("answers withdrawn for a grant that was taken back", () => {
    const policy = read(projectionOf(GRANT, WITHDRAW));
    expect(policy.status).toBe("withdrawn");
    expect(policy.scopes).toEqual([]);
    expect(policy.evidence.map((entry) => entry.ref)).toEqual(["permission:evt_withdraw"]);
  });

  it("answers unresolved when nobody ever answered", () => {
    const policy = read(projectionOf());
    expect(policy.status).toBe("unresolved");
    expect(policy.scopes).toEqual([]);
  });

  it("answers denied for the exact attempt a denial addressed — and only that one", () => {
    const denied = projectionOf(
      GRANT,
      probePermissionEvent({
        eventId: "evt_denied",
        kind: "attempt_denied",
        permittedActorId: PROBE_ACTOR,
        grantingTargetId: PROBE_TARGET,
        attemptActionId: "attempt_7",
        storyTime: 110,
      }),
    );
    const thisAttempt = read(denied, { attemptActionId: "attempt_7" });
    expect(thisAttempt.status).toBe("denied");
    expect(thisAttempt.evidence.map((entry) => entry.ref)).toEqual(["permission:evt_denied"]);
    // "Not now" was about attempt_7. The standing grant still answers for the next one.
    expect(read(denied, { attemptActionId: "attempt_8" }).status).toBe("allowed");
    expect(read(denied).status).toBe("allowed");
  });

  it("matches an action-local denial to the active contact produced by that action", () => {
    // Projection folding is pinned separately; this fixture isolates the policy
    // lookup that the invalidation sweep performs for one active contact.
    const denied: RomanticPermissionProjection = {
      ...projectionOf(GRANT),
      denials: [
        {
          permittedActorId: PROBE_ACTOR,
          grantingTargetId: PROBE_TARGET,
          scope: "romantic_touch",
          attemptActionId: "attempt_7",
          attemptContactId: "contact_7",
          eventId: "evt_denied_contact",
        },
      ],
    };
    expect(read(denied, { attemptContactId: "contact_7" }).status).toBe("denied");
    expect(read(denied, { attemptContactId: "contact_8" }).status).toBe("allowed");
  });

  it("takes the player-target exception without manufacturing a player grant", () => {
    const policy = read(projectionOf(), { grantingTargetId: PLAYER });
    expect(policy).toMatchObject({
      status: "not_required",
      notRequiredBasis: "player_target",
      notRequiredTargetId: PLAYER,
      scopes: [],
    });
  });

  it("stays neutral — basis-free — for a kind that never needed permission", () => {
    const policy = read(projectionOf(GRANT), { actionKind: "affectionate" });
    expect(policy.status).toBe("not_required");
    expect(policy.notRequiredBasis).toBeUndefined();
  });
});

describe("the derived read through the real contact resolver", () => {
  function resolveWith(
    policy: ContactInteractionPolicyRead,
    intent: Parameters<typeof probeAttempt>[0]["intent"] = { actionKind: "romantic" },
    sink?: DiagnosticCollector,
  ) {
    const { intent: built, context } = probeAttempt({ intent, context: { policy } });
    return resolveContactAttempt({ intent: built, context, ...(sink === undefined ? {} : { sink }) });
  }

  it("a standing grant commits the romantic attempt", () => {
    const sink = new DiagnosticCollector();
    const resolution = resolveWith(read(projectionOf(GRANT)), { actionKind: "romantic" }, sink);
    expect(resolution.status).toBe("committable");
    if (resolution.status !== "committable") return;
    expect(resolution.policy.status).toBe("allowed");
    expect(sink.items).toEqual([]);
  });

  it("romantic_touch cannot authorize an intimate act — the scope-missing path", () => {
    const sink = new DiagnosticCollector();
    // The grant EXISTS and does not name intimate_touch: an answer about this
    // action, so a refusal the narrator must carry — never a widened grant.
    const resolution = resolveWith(read(projectionOf(GRANT), { actionKind: "intimate" }), { actionKind: "intimate" }, sink);
    expect(resolution).toMatchObject({ status: "rejected", reason: "permission_scope_missing" });
    expect(sink.items.map((item) => item.code)).toEqual([CONTACT_PERMISSION_SCOPE_MISSING]);
  });

  it("a withdrawal refuses the attempt as an answer, not a gap", () => {
    const sink = new DiagnosticCollector();
    const resolution = resolveWith(read(projectionOf(GRANT, WITHDRAW)), { actionKind: "romantic" }, sink);
    expect(resolution).toMatchObject({ status: "rejected", reason: "permission_withdrawn" });
    expect(sink.items.map((item) => item.code)).toEqual([]);
  });

  it("absence falls silent with the resolver's own diagnostic", () => {
    const sink = new DiagnosticCollector();
    const resolution = resolveWith(read(projectionOf()), { actionKind: "romantic" }, sink);
    expect(resolution).toMatchObject({ status: "unresolved", reason: "permission_unresolved" });
    expect(sink.items.map((item) => item.code)).toEqual([CONTACT_PERMISSION_UNAVAILABLE]);
  });

  it("an NPC touching the PLAYER passes on the exception, with no grant in the ledger", () => {
    const sink = new DiagnosticCollector();
    const { intent, context } = probeAttempt({
      // The NPC is the actor; the player's body is the target surface.
      intent: { actionKind: "romantic", target: probeBodySurface(PLAYER, "shoulders") },
      context: {
        policy: read(projectionOf(), { grantingTargetId: PLAYER }),
      },
    });
    const resolution = resolveContactAttempt({ intent, context, sink });
    expect(resolution.status).toBe("committable");
    expect(sink.items).toEqual([]);
  });
});
