import { describe, expect, it } from "vitest";
import { DiagnosticCollector, type Diagnostic } from "../../diagnostics";
import { adapterInvalid, adapterSupported, adapterUnavailable, affordanceSubjectId } from "../core";
import {
  CONTACT_ACTION_INVALID,
  CONTACT_ACTOR_CONTROL_UNAVAILABLE,
  CONTACT_ELIGIBILITY_UNAVAILABLE,
  CONTACT_GEOMETRY_UNAVAILABLE,
  CONTACT_MATERIAL_UNAVAILABLE,
  CONTACT_PERMISSION_SCOPE_MISSING,
  CONTACT_PERMISSION_UNAVAILABLE,
  CONTACT_SUPPORT_UNAVAILABLE,
  CONTACT_TARGET_AGENCY_UNAVAILABLE,
} from "./diagnostics";
import { contactEntityId } from "./identity";
import { resolveContactAttempt } from "./resolve";
import type { ContactResolution } from "./types";
import {
  PROBE_ACTOR,
  PROBE_TARGET,
  probeAdjustment,
  probeAgency,
  probeAttempt,
  probeBodySurface,
  probeControl,
  probeEligibility,
  probeGeometry,
  probeLayer,
  probePolicy,
  probeSupport,
} from "./test-support";

function run(input: Parameters<typeof probeAttempt>[0], sink?: DiagnosticCollector): ContactResolution {
  const { intent, context } = probeAttempt(input);
  return resolveContactAttempt({ intent, context, ...(sink === undefined ? {} : { sink }) });
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item: Diagnostic) => item.code);
}

describe("contact attempt resolution", () => {
  describe("the happy paths", () => {
    it("commits bare contact as direct", () => {
      const resolution = run({});
      expect(resolution.status).toBe("committable");
      if (resolution.status !== "committable") return;
      expect(resolution.access.mode).toBe("direct");
      expect(resolution.access.transmission.directSkinContact).toBe(true);
      expect(resolution.access.materialBetween).toEqual([]);
    });

    it("commits through material when the action does not demand skin", () => {
      const resolution = run({
        context: { material: adapterSupported({ layers: [probeLayer("sock")], evidence: [] }) },
      });
      expect(resolution.status).toBe("committable");
      if (resolution.status !== "committable") return;
      expect(resolution.access.mode).toBe("through_material");
      expect(resolution.access.transmission.directSkinContact).toBe(false);
      expect(resolution.access.transmission.layerIds).toEqual(["sock"]);
    });

    it("carries the three decisions onto the committable resolution", () => {
      const resolution = run({ intent: { actionKind: "romantic" }, context: { policy: probePolicy("allowed") } });
      expect(resolution.status).toBe("committable");
      if (resolution.status !== "committable") return;
      expect(resolution.actorControl.status).toBe("allowed");
      expect(resolution.participantEligibility.status).toBe("eligible");
      expect(resolution.policy.status).toBe("allowed");
    });

    it("records the provenance of every read it consulted", () => {
      const resolution = run({});
      expect(resolution.evidence.map((entry) => entry.ref)).toContain("probe.control");
      expect(resolution.evidence.map((entry) => entry.ref)).toContain("probe.reach");
    });

    it("is deterministic — the same inputs resolve identically", () => {
      const { intent, context } = probeAttempt({ intent: { requestedPressure: "moderate" } });
      expect(resolveContactAttempt({ intent, context })).toEqual(resolveContactAttempt({ intent, context }));
    });

    it("files no diagnostic for an ordinary commitment", () => {
      const sink = new DiagnosticCollector();
      run({}, sink);
      expect(sink.items).toEqual([]);
    });
  });

  describe("who may move", () => {
    it("rejects a denied actor-control decision", () => {
      const resolution = run({ context: { actorControl: probeControl("denied") } });
      expect(resolution).toMatchObject({ status: "rejected", reason: "actor_control_denied" });
    });

    it("rejects — never commits — when no control owner answered, and says so", () => {
      const sink = new DiagnosticCollector();
      const resolution = run({ context: { actorControl: probeControl("unresolved") } }, sink);
      expect(resolution).toMatchObject({ status: "rejected", reason: "actor_control_unresolved" });
      expect(codes(sink)).toEqual([CONTACT_ACTOR_CONTROL_UNAVAILABLE]);
    });

    it("treats a control decision about somebody else as a malformed attempt", () => {
      const sink = new DiagnosticCollector();
      const resolution = run(
        { context: { actorControl: probeControl("allowed", affordanceSubjectId("someone_else")) } },
        sink,
      );
      expect(resolution).toMatchObject({ status: "unresolved", reason: "action_invalid" });
      expect(codes(sink)).toEqual([CONTACT_ACTION_INVALID]);
    });

    it("treats an acting surface that belongs to somebody else as a malformed attempt", () => {
      // The control decision is impeccable and about the right actor. Without
      // binding the source surface to that actor it would still authorize an
      // attempt made with the OTHER character's hands.
      const sink = new DiagnosticCollector();
      const resolution = run({ intent: { source: probeBodySurface(PROBE_TARGET, "hands") } }, sink);
      expect(resolution).toMatchObject({ status: "unresolved", reason: "action_invalid" });
      expect(codes(sink)).toEqual([CONTACT_ACTION_INVALID]);
      expect(sink.hasErrors).toBe(true);
    });

    it("requires the target's own behaviour authority for a movement on the target's body", () => {
      const sink = new DiagnosticCollector();
      const resolution = run(
        {
          context: {
            adjustments: [probeAdjustment({ subjectId: PROBE_TARGET })],
            targetAgencies: [probeAgency("not_required")],
          },
        },
        sink,
      );
      expect(resolution).toMatchObject({ status: "rejected", reason: "target_agency_unresolved" });
      expect(codes(sink)).toEqual([CONTACT_TARGET_AGENCY_UNAVAILABLE]);
    });

    it("accepts a target movement the target's authority committed", () => {
      const resolution = run({
        context: {
          adjustments: [probeAdjustment({ subjectId: PROBE_TARGET })],
          targetAgencies: [probeAgency("allowed")],
        },
      });
      expect(resolution.status).toBe("committable");
    });

    it("rejects a denied target movement", () => {
      const resolution = run({
        context: {
          adjustments: [probeAdjustment({ subjectId: PROBE_TARGET })],
          targetAgencies: [probeAgency("denied")],
        },
      });
      expect(resolution).toMatchObject({ status: "rejected", reason: "target_agency_denied" });
    });

    it("will not spend an agency decision about one body on a movement of another", () => {
      const sink = new DiagnosticCollector();
      const resolution = run(
        {
          context: {
            adjustments: [probeAdjustment({ subjectId: PROBE_TARGET })],
            targetAgencies: [probeAgency("allowed", affordanceSubjectId("someone_else"))],
          },
        },
        sink,
      );
      expect(resolution).toMatchObject({ status: "rejected", reason: "target_agency_unresolved" });
      expect(codes(sink)).toEqual([CONTACT_TARGET_AGENCY_UNAVAILABLE]);
    });

    it("refuses an adjustment that moves somebody who is not in this contact", () => {
      const sink = new DiagnosticCollector();
      const resolution = run(
        {
          context: {
            adjustments: [probeAdjustment({ id: "third_party", subjectId: affordanceSubjectId("bystander") })],
            targetAgencies: [probeAgency("allowed", affordanceSubjectId("bystander"))],
          },
        },
        sink,
      );
      expect(resolution).toMatchObject({ status: "unresolved", reason: "action_invalid" });
      expect(codes(sink)).toEqual([CONTACT_ACTION_INVALID]);
    });

    it("needs an answer for every moved body, and needs none for the actor's own", () => {
      const moved = {
        adjustments: [
          probeAdjustment({ id: "actor_lean", subjectId: PROBE_ACTOR, kind: "lean" }),
          probeAdjustment({ id: "target_turn", subjectId: PROBE_TARGET }),
          probeAdjustment({ id: "target_angle", subjectId: PROBE_TARGET, kind: "head_angle" }),
        ],
      };
      // The actor's own movement rides on actor control; the target's needs the
      // target's authority, and one answer covers both of the target's.
      const covered = run({ context: { ...moved, targetAgencies: [probeAgency("allowed")] } });
      expect(covered.status).toBe("committable");
      if (covered.status !== "committable") return;
      expect(covered.access.implicitAdjustments.map((adjustment) => adjustment.id)).toEqual([
        "actor_lean",
        "target_turn",
        "target_angle",
      ]);
      // An answer that only covers the actor authorizes nothing about the target.
      const uncovered = run({
        context: { ...moved, targetAgencies: [probeAgency("allowed", PROBE_ACTOR)] },
      });
      expect(uncovered).toMatchObject({ status: "rejected", reason: "target_agency_unresolved" });
    });

    it("prefers a definite refusal over a missing answer when several bodies move", () => {
      const resolution = run({
        context: {
          adjustments: [probeAdjustment({ subjectId: PROBE_TARGET })],
          targetAgencies: [probeAgency("denied"), probeAgency("unresolved", PROBE_ACTOR)],
        },
      });
      expect(resolution).toMatchObject({ status: "rejected", reason: "target_agency_denied" });
    });

    it("records the provenance of every agency decision it consulted", () => {
      const resolution = run({
        context: {
          adjustments: [probeAdjustment({ subjectId: PROBE_TARGET })],
          targetAgencies: [probeAgency("allowed")],
        },
      });
      expect(resolution.evidence.map((entry) => entry.ref)).toContain(`probe.agency.${PROBE_TARGET}`);
    });
  });

  describe("who may be touched", () => {
    it("rejects a participant the product ruled ineligible", () => {
      const resolution = run({
        intent: { actionKind: "romantic" },
        context: { participantEligibility: probeEligibility("ineligible") },
      });
      expect(resolution).toMatchObject({ status: "rejected", reason: "participant_ineligible" });
    });

    it("rejects unresolved eligibility rather than guessing", () => {
      const sink = new DiagnosticCollector();
      const resolution = run(
        { intent: { actionKind: "romantic" }, context: { participantEligibility: probeEligibility("unresolved") } },
        sink,
      );
      expect(resolution).toMatchObject({ status: "rejected", reason: "participant_eligibility_unresolved" });
      expect(codes(sink)).toEqual([CONTACT_ELIGIBILITY_UNAVAILABLE]);
    });

    it("rejects an eligibility answer that covers only one participant", () => {
      const resolution = run({
        intent: { actionKind: "romantic" },
        context: { participantEligibility: probeEligibility("eligible", [PROBE_ACTOR]) },
      });
      expect(resolution).toMatchObject({ status: "rejected", reason: "participant_eligibility_unresolved" });
    });

    it("does not demand eligibility for ordinary affectionate contact", () => {
      const resolution = run({
        intent: { actionKind: "affectionate" },
        context: { participantEligibility: probeEligibility("unresolved", []) },
      });
      expect(resolution.status).toBe("committable");
    });

    it.each([
      ["denied", "permission_denied"],
      ["withdrawn", "permission_withdrawn"],
    ] as const)("rejects %s permission", (status, reason) => {
      const resolution = run({ intent: { actionKind: "romantic" }, context: { policy: probePolicy(status) } });
      expect(resolution).toMatchObject({ status: "rejected", reason });
    });

    it("rejects when no permission owner answered", () => {
      const sink = new DiagnosticCollector();
      const resolution = run(
        { intent: { actionKind: "romantic" }, context: { policy: probePolicy("unresolved") } },
        sink,
      );
      expect(resolution).toMatchObject({ status: "rejected", reason: "permission_unresolved" });
      expect(codes(sink)).toEqual([CONTACT_PERMISSION_UNAVAILABLE]);
    });

    it("never widens a grant to a scope it does not name", () => {
      const sink = new DiagnosticCollector();
      const resolution = run(
        { intent: { actionKind: "intimate" }, context: { policy: probePolicy("allowed", "romantic") } },
        sink,
      );
      expect(resolution).toMatchObject({ status: "rejected", reason: "permission_scope_missing" });
      expect(codes(sink)).toEqual([CONTACT_PERMISSION_SCOPE_MISSING]);
    });

    it("does not demand permission for ordinary affectionate contact", () => {
      const resolution = run({ context: { policy: probePolicy("unresolved") } });
      expect(resolution.status).toBe("committable");
    });

    it("needs neither permission nor eligibility to touch an object", () => {
      const resolution = run({
        intent: {
          actionKind: "romantic",
          target: { kind: "object", entityId: contactEntityId("wall_1"), surfaceId: "surface" },
        },
        context: { policy: probePolicy("unresolved"), participantEligibility: probeEligibility("unresolved", []) },
      });
      expect(resolution.status).toBe("committable");
    });

    it("asks nobody's permission for a character touching their own body", () => {
      const resolution = run({
        intent: {
          actionKind: "intimate",
          target: probeBodySurface(PROBE_ACTOR, "feet", "arch"),
        },
        context: { policy: probePolicy("denied"), participantEligibility: probeEligibility("ineligible") },
      });
      expect(resolution.status).toBe("committable");
    });

    it("still needs control over the body doing the touching", () => {
      const resolution = run({
        intent: { target: probeBodySurface(PROBE_ACTOR, "feet", "arch") },
        context: { actorControl: probeControl("denied") },
      });
      expect(resolution).toMatchObject({ status: "rejected", reason: "actor_control_denied" });
    });

    it("refuses on permission before it ever asks about pose", () => {
      const sink = new DiagnosticCollector();
      const resolution = run(
        { intent: { actionKind: "romantic" }, context: { policy: probePolicy("denied"), geometry: adapterUnavailable } },
        sink,
      );
      expect(resolution).toMatchObject({ status: "rejected", reason: "permission_denied" });
      expect(codes(sink)).toEqual([]);
    });
  });

  describe("whether it can physically happen", () => {
    it("rejects an unreachable surface", () => {
      const resolution = run({ context: { geometry: adapterSupported(probeGeometry("out_of_reach")) } });
      expect(resolution).toMatchObject({ status: "rejected", reason: "out_of_reach" });
    });

    it("requires an explicit reposition when reach needs a movement nobody proposed", () => {
      const resolution = run({
        context: { geometry: adapterSupported(probeGeometry("within_reach_after_adjustment")) },
      });
      expect(resolution.status).toBe("explicit_transition_required");
      if (resolution.status !== "explicit_transition_required") return;
      expect(resolution.requirements.map((requirement) => requirement.code)).toEqual(["reposition"]);
      expect(resolution.access.mode).toBe("blocked_by_geometry");
    });

    it("folds an ordinary small movement in without a scene beat", () => {
      const resolution = run({
        context: {
          geometry: adapterSupported(probeGeometry("within_reach_after_adjustment")),
          adjustments: [probeAdjustment()],
        },
      });
      expect(resolution.status).toBe("committable");
      if (resolution.status !== "committable") return;
      expect(resolution.access.implicitAdjustments.map((adjustment) => adjustment.id)).toEqual(["probe_adjustment"]);
    });

    it.each([
      ["one that moves a layer", probeAdjustment({ movesMaterialLayer: true }), "moves_material_layer"],
      ["a posture change", probeAdjustment({ changesPostureOrPlace: true }), "posture_or_place_change"],
      ["a support transfer", probeAdjustment({ requiresSupportTransfer: true }), "support_transfer"],
      ["one that overcomes resistance", probeAdjustment({ overcomesResistanceOrConstraint: true }), "overcomes_resistance"],
      ["an expressive movement", probeAdjustment({ expressesChoiceOrReaction: true }), "expresses_choice"],
      ["one that newly exposes", probeAdjustment({ newlyExposesIntimateSurface: true }), "new_intimate_exposure"],
      ["one outside current proximity", probeAdjustment({ withinCurrentProximity: false }), "outside_current_proximity"],
    ])("turns %s into an explicit requirement", (_label, adjustment, blockCode) => {
      const resolution = run({ context: { adjustments: [adjustment] } });
      expect(resolution.status).toBe("explicit_transition_required");
      if (resolution.status !== "explicit_transition_required") return;
      expect(resolution.requirements[0]?.detail).toContain(blockCode);
    });

    it("requires freeing a trapped limb", () => {
      const resolution = run({ context: { sourceSupport: adapterSupported(probeSupport("trapped")) } });
      expect(resolution.status).toBe("explicit_transition_required");
      if (resolution.status !== "explicit_transition_required") return;
      expect(resolution.requirements.map((requirement) => requirement.code)).toEqual(["free_limb"]);
      expect(resolution.access.mode).toBe("blocked_by_support");
    });

    it("requires changing support before a weight-bearing surface may move", () => {
      const resolution = run({
        intent: { requestedMotion: { band: "sliding" } },
        context: { sourceSupport: adapterSupported(probeSupport("free", "weight_bearing")) },
      });
      expect(resolution.status).toBe("explicit_transition_required");
      if (resolution.status !== "explicit_transition_required") return;
      expect(resolution.requirements.map((requirement) => requirement.code)).toEqual(["change_support"]);
    });

    it("leaves a weight-bearing surface alone when nothing has to move", () => {
      const resolution = run({
        context: { sourceSupport: adapterSupported(probeSupport("free", "weight_bearing")) },
      });
      expect(resolution.status).toBe("committable");
    });

    it("requires removing what is in the way of a bare-skin action", () => {
      const resolution = run({
        intent: { access: "direct_skin" },
        context: { material: adapterSupported({ layers: [probeLayer("sock"), probeLayer("shoe", 1)], evidence: [] }) },
      });
      expect(resolution.status).toBe("explicit_transition_required");
      if (resolution.status !== "explicit_transition_required") return;
      expect(resolution.requirements.map((requirement) => requirement.detail)).toEqual(["sock", "shoe"]);
      expect(resolution.access.mode).toBe("blocked_by_material");
      expect(resolution.access.transmission.directSkinContact).toBe(false);
    });
  });

  describe("unresolved — the world could not be read", () => {
    it("returns unresolved when no pose owner can place the surfaces", () => {
      const sink = new DiagnosticCollector();
      const resolution = run({ context: { geometry: adapterUnavailable } }, sink);
      expect(resolution).toMatchObject({ status: "unresolved", reason: "geometry_unavailable" });
      expect(codes(sink)).toEqual([CONTACT_GEOMETRY_UNAVAILABLE]);
    });

    it("returns unresolved when no support owner can answer for the acting surface", () => {
      const sink = new DiagnosticCollector();
      const resolution = run({ context: { sourceSupport: adapterUnavailable } }, sink);
      expect(resolution).toMatchObject({ status: "unresolved", reason: "support_unavailable" });
      expect(codes(sink)).toEqual([CONTACT_SUPPORT_UNAVAILABLE]);
    });

    it("returns unresolved when nobody can say what lies between", () => {
      const sink = new DiagnosticCollector();
      const resolution = run({ context: { material: adapterUnavailable } }, sink);
      expect(resolution).toMatchObject({ status: "unresolved", reason: "material_unavailable" });
      expect(codes(sink)).toEqual([CONTACT_MATERIAL_UNAVAILABLE]);
    });

    it("treats an invalid read exactly like a missing one", () => {
      const resolution = run({ context: { material: adapterInvalid } });
      expect(resolution).toMatchObject({ status: "unresolved", reason: "material_unavailable" });
    });

    it.each([
      ["an unknown source location", { source: probeBodySurface(PROBE_ACTOR, "left_antenna") }],
      ["an unknown target location", { target: probeBodySurface(PROBE_TARGET, "not_a_place") }],
      ["a blank action id", { actionId: "  " }],
      ["a negative story time", { storyTime: -1 }],
      ["a fractional story time", { storyTime: 1.5 }],
    ])("refuses %s with an error diagnostic", (_label, overrides) => {
      const sink = new DiagnosticCollector();
      const resolution = run({ intent: overrides }, sink);
      expect(resolution).toMatchObject({ status: "unresolved", reason: "action_invalid" });
      expect(codes(sink)).toEqual([CONTACT_ACTION_INVALID]);
      expect(sink.hasErrors).toBe(true);
    });

    it("refuses a surface touching itself", () => {
      const surface = probeBodySurface(PROBE_ACTOR, "hands");
      const resolution = run({ intent: { source: surface, target: surface } });
      expect(resolution).toMatchObject({ status: "unresolved", reason: "action_invalid" });
    });
  });

});
