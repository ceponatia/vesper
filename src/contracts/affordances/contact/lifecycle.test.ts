import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { adapterSupported, toUnitInterval } from "../core";
import type { ContactMaterialLayerRead } from "./material";
import { CONTACT_AUTHORIZATION_LAPSED, CONTACT_LIFECYCLE_INVALID } from "./diagnostics";
import { contactEventRef } from "./identity";
import {
  activeContact,
  activeContactForPair,
  applyContactCommit,
  commitContactResolution,
  contactCommitEvents,
  emptyContactLifecycleState,
  endAllContacts,
  endContact,
  endUnauthorizedContacts,
  recomposeContactTransmission,
  replayContactCommits,
  type CommittedContactOutcome,
  type ContactCommitOutcome,
  type ContactLifecycleState,
} from "./lifecycle";
import { resolveContactAttempt } from "./resolve";
import { contactPairKey } from "./surfaces";
import type { CommittableContactResolution, ContactActionIntent, ContactLifecycleCommit } from "./types";
import {
  PROBE_ACTOR,
  PROBE_EVENT,
  PROBE_TARGET,
  probeAdjustment,
  probeAgency,
  probeAttempt,
  probeBodySurface,
  probeEligibility,
  probeLayer,
  probePolicy,
} from "./test-support";

function committable(intent: Partial<ContactActionIntent> = {}): CommittableContactResolution {
  const attempt = probeAttempt({ intent });
  const resolution = resolveContactAttempt(attempt);
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  return resolution;
}

/**
 * Commit, narrowed to the branch that produced a contact.
 *
 * Almost every case here is about a contact that DID start, and the union's
 * whole point is that reading one off a refusal is impossible — so the tests
 * narrow once, here, and a case that unexpectedly refuses fails loudly rather
 * than quietly reading `undefined`. The refusal branch has its own cases, which
 * call `commitContactResolution` directly.
 */
function mustCommit(request: Parameters<typeof commitContactResolution>[0]): CommittedContactOutcome {
  const outcome = commitContactResolution(request);
  if (outcome.status !== "committed") throw new Error(`fixture was refused: ${outcome.reason}`);
  return outcome;
}

function committableWith(layers: readonly ContactMaterialLayerRead[]): CommittableContactResolution {
  const attempt = probeAttempt({ context: { material: adapterSupported({ layers, evidence: [] }) } });
  const resolution = resolveContactAttempt(attempt);
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  return resolution;
}

function committableThrough(layerIds: readonly string[]): CommittableContactResolution {
  return committableWith(layerIds.map((id) => probeLayer(id)));
}

function start(state: ContactLifecycleState = emptyContactLifecycleState()) {
  return mustCommit({ state, resolution: committable(), eventRef: PROBE_EVENT });
}

/** A contact that folded in a movement of the TARGET's body, with the answer that allowed it. */
function committableWithAgency(intent: Partial<ContactActionIntent> = {}): CommittableContactResolution {
  const attempt = probeAttempt({
    intent,
    context: {
      adjustments: [probeAdjustment({ subjectId: PROBE_TARGET })],
      targetAgencies: [probeAgency("allowed")],
    },
  });
  const resolution = resolveContactAttempt(attempt);
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  return resolution;
}

/** A romantic contact — the kind whose authorization can lapse under it. */
function romantic(intent: Partial<ContactActionIntent> = {}): CommittableContactResolution {
  const attempt = probeAttempt({
    intent: { actionKind: "romantic", ...intent },
    context: { policy: probePolicy("allowed", "romantic"), participantEligibility: probeEligibility("eligible") },
  });
  const resolution = resolveContactAttempt(attempt);
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  return resolution;
}

/** The durable stream a sequence of outcomes produced, in fold order. */
function streamOf(...outcomes: readonly ContactCommitOutcome[]): readonly ContactLifecycleCommit[] {
  return outcomes.flatMap((outcome) => [...contactCommitEvents(outcome)]);
}

describe("contact lifecycle", () => {
  describe("start", () => {
    it("mints an active contact with a derived id", () => {
      const { state, commit, contact } = start();
      expect(commit.kind).toBe("contact_started");
      expect(contact.phase).toBe("active");
      expect(contact.contactId).toContain(PROBE_EVENT);
      expect(state.contacts).toHaveLength(1);
    });

    it("derives the same id from the same attempt every time", () => {
      expect(start().contact.contactId).toBe(start().contact.contactId);
    });

    it("keeps the acting orientation and the two surfaces", () => {
      const { contact } = start();
      expect(contact.actorId).toBe(PROBE_ACTOR);
      expect(contact.source.locationId).toBe("hands");
      expect(contact.target).toMatchObject({ kind: "body", subjectId: PROBE_TARGET, locationId: "feet" });
    });

    it("carries the decisions that allowed it to exist", () => {
      const { contact } = start();
      expect(contact.actorControl.status).toBe("allowed");
      expect(contact.participantEligibility.status).toBe("eligible");
      expect(contact.policy.status).toBe("allowed");
      expect(contact.targetAgencies).toEqual([]);
    });

    it("carries the agency proof for every body its adjustments moved", () => {
      // `implicitAdjustments` is a durable claim that a body MOVED. Without the
      // decision beside it, the committed record cannot prove — later and out of
      // context — that the body's own authority allowed the movement.
      const { contact } = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committableWithAgency(),
        eventRef: PROBE_EVENT,
      });
      expect(contact.implicitAdjustments.map((adjustment) => adjustment.subjectId)).toEqual([PROBE_TARGET]);
      expect(contact.targetAgencies).toEqual([
        expect.objectContaining({ targetId: PROBE_TARGET, status: "allowed" }),
      ]);
    });

    it("leaves unstated pressure and area unknown rather than guessing a floor", () => {
      const { contact } = start();
      expect(contact.pressure).toBeUndefined();
      expect(contact.contactArea).toBeUndefined();
      expect(contact.motion).toBeUndefined();
    });

    it("carries stated pressure, area, and motion path in order", () => {
      const { contact } = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committable({
          requestedPressure: "moderate",
          requestedArea: "broad",
          requestedMotion: { band: "sliding", pathDetailIds: ["arch", "heel_pad"] },
        }),
        eventRef: PROBE_EVENT,
      });
      expect(contact.pressure).toBe("moderate");
      expect(contact.contactArea).toBe("broad");
      expect(contact.motion?.pathDetailIds).toEqual(["arch", "heel_pad"]);
    });

    it("freezes the committed read", () => {
      const { contact } = start();
      expect(Object.isFrozen(contact)).toBe(true);
      expect(() => {
        (contact as { lastUpdatedAt: number }).lastUpdatedAt = 999;
      }).toThrow();
    });
  });

  describe("continue and update", () => {
    it("re-asserting an unchanged contact writes nothing and keeps the id", () => {
      const first = start();
      const again = mustCommit({
        state: first.state,
        resolution: committable(),
        eventRef: contactEventRef("later_event"),
      });
      expect(again.commit.kind).toBe("contact_continued");
      expect(again.contact.contactId).toBe(first.contact.contactId);
      expect(again.state).toBe(first.state);
      expect(again.state.contacts).toHaveLength(1);
    });

    it("updates in place when the physical content changes", () => {
      const first = start();
      const changed = mustCommit({
        state: first.state,
        resolution: committable({ requestedPressure: "firm", storyTime: 140 }),
        eventRef: contactEventRef("later_event"),
      });
      expect(changed.commit.kind).toBe("contact_updated");
      expect(changed.contact.contactId).toBe(first.contact.contactId);
      expect(changed.contact.startedAt).toBe(first.contact.startedAt);
      expect(changed.contact.lastUpdatedAt).toBe(140);
      expect(changed.contact.lastUpdatedByEventRef).toBe("later_event");
      expect(changed.state.contacts).toHaveLength(1);
      if (changed.commit.kind !== "contact_updated") return;
      expect(changed.commit.snapshot.pressure).toBe("firm");
    });

    it("keeps the start agency proof when a later assertion moves nobody", () => {
      // Start identity, exactly like the three decisions beside it: the proof
      // belongs to the contact that began. A later assertion that folds in no
      // movement is not evidence that the first movement was unauthorized.
      const moved = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committableWithAgency(),
        eventRef: PROBE_EVENT,
      });
      const changed = mustCommit({
        state: moved.state,
        resolution: committable({ requestedPressure: "firm", storyTime: 140 }),
        eventRef: contactEventRef("later_event"),
      });
      expect(changed.commit.kind).toBe("contact_updated");
      expect(changed.contact.targetAgencies).toEqual(moved.contact.targetAgencies);
    });

    it("keeps the start orientation when the other side asserts a changed contact", () => {
      // The pair key is order-independent, so the same touch can be re-asserted
      // from the other side. Taking that assertion's orientation would rewrite
      // who was touching whom for every observation downstream.
      const first = start();
      const swapped = probeAttempt({
        intent: {
          actorId: PROBE_TARGET,
          source: probeBodySurface(PROBE_TARGET, "feet", "arch"),
          target: probeBodySurface(PROBE_ACTOR, "hands"),
          requestedPressure: "firm",
          storyTime: 140,
        },
        context: { actorControl: { status: "allowed", actorId: PROBE_TARGET, evidence: [] } },
      });
      const resolution = resolveContactAttempt(swapped);
      if (resolution.status !== "committable") throw new Error("fixture did not commit");
      const changed = mustCommit({
        state: first.state,
        resolution,
        eventRef: contactEventRef("swapped_change"),
      });
      expect(changed.commit.kind).toBe("contact_updated");
      expect(changed.contact.contactId).toBe(first.contact.contactId);
      expect(changed.contact.pressure).toBe("firm");
      // Orientation, actor, and the decision that justified the start: unchanged.
      expect(changed.contact.actorId).toBe(PROBE_ACTOR);
      expect(changed.contact.source.subjectId).toBe(PROBE_ACTOR);
      expect(changed.contact.target).toMatchObject({ subjectId: PROBE_TARGET });
      expect(changed.contact.actorControl.actorId).toBe(PROBE_ACTOR);
      expect(changed.contact.startedByEventRef).toBe(first.contact.startedByEventRef);
    });

    it("ends the contact and starts a new one when the action framing changes", () => {
      const sink = new DiagnosticCollector();
      const affectionate = start();
      const escalated = mustCommit({
        state: affectionate.state,
        resolution: romantic({ storyTime: 140 }),
        eventRef: contactEventRef("romantic_event"),
        sink,
      });
      expect(escalated.commit.kind).toBe("contact_started");
      expect(escalated.contact.contactId).not.toBe(affectionate.contact.contactId);
      expect(escalated.contact.actionKind).toBe("romantic");
      // The old contact left through a durable event, not a quiet overwrite.
      expect(escalated.ended.map((commit) => commit.contactId)).toEqual([affectionate.contact.contactId]);
      expect(escalated.state.contacts).toHaveLength(1);
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID]);
      expect(replayContactCommits({ commits: streamOf(affectionate, escalated) })).toEqual(escalated.state);
    });

    it("will not let an assertion older than the projection rewrite it", () => {
      const sink = new DiagnosticCollector();
      const first = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committable({ requestedPressure: "firm", storyTime: 200 }),
        eventRef: PROBE_EVENT,
      });
      const stale = mustCommit({
        state: first.state,
        resolution: committable({ requestedPressure: "trace", storyTime: 150 }),
        eventRef: contactEventRef("stale_event"),
        sink,
      });
      expect(stale.commit.kind).toBe("contact_continued");
      expect(stale.state).toBe(first.state);
      expect(stale.contact.pressure).toBe("firm");
      expect(stale.contact.lastUpdatedAt).toBe(200);
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID]);
    });

    it("will not let a stale assertion end a newer contact through the framing door", () => {
      // Guarding only the same-kind path left staleness with a way in: a stale
      // assertion of a DIFFERENT kind fell through to end+start, ending a
      // contact at a story time before its own last update and replacing it
      // with one whose start predates what it displaced.
      const sink = new DiagnosticCollector();
      const live = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committable({ requestedPressure: "firm", storyTime: 200 }),
        eventRef: PROBE_EVENT,
      });
      const stale = mustCommit({
        state: live.state,
        resolution: romantic({ storyTime: 150 }),
        eventRef: contactEventRef("stale_romantic_event"),
        sink,
      });
      expect(stale.commit.kind).toBe("contact_continued");
      expect(stale.ended).toEqual([]);
      expect(stale.state).toBe(live.state);
      expect(stale.contact.contactId).toBe(live.contact.contactId);
      expect(stale.contact.actionKind).toBe("affectionate");
      expect(stale.contact.lastUpdatedAt).toBe(200);
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID]);
      expect(replayContactCommits({ commits: streamOf(live, stale) })).toEqual(live.state);
    });

    it("counts a change of what is between as a change", () => {
      const bare = start();
      const dressed = mustCommit({
        state: bare.state,
        resolution: committableThrough(["sock"]),
        eventRef: contactEventRef("sock_event"),
      });
      expect(dressed.commit.kind).toBe("contact_updated");
      expect(dressed.contact.transmission.directSkinContact).toBe(false);
    });

    it("counts a layer that changed under a stable id as a change", () => {
      // The wardrobe's `layerId` survives the garment changing underneath it: a
      // sock soaking through keeps its id while its permeability moves. An
      // id-only fingerprint continued here and the projection kept the dry
      // snapshot for every observation downstream to read.
      const dry = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committableWith([probeLayer("sock")]),
        eventRef: PROBE_EVENT,
      });
      const soaked = mustCommit({
        state: dry.state,
        resolution: committableWith([
          { ...probeLayer("sock"), moistureTransmission: toUnitInterval(9_500) },
        ]),
        eventRef: contactEventRef("soaked_event"),
      });
      expect(soaked.commit.kind).toBe("contact_updated");
      expect(soaked.contact.contactId).toBe(dry.contact.contactId);
      expect(soaked.contact.materialBetween[0]?.moistureTransmission).toBe(9_500);
      // The composed answer moves with the layers, not with the id.
      expect(soaked.contact.transmission.moistureTransmission).toBe(9_500);
      if (soaked.commit.kind !== "contact_updated") return;
      expect(soaked.commit.snapshot.materialBetween[0]?.moistureTransmission).toBe(9_500);
    });

    it("still continues for layers whose content is identical", () => {
      const first = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committableWith([probeLayer("sock"), probeLayer("boot", 1)]),
        eventRef: PROBE_EVENT,
      });
      const again = mustCommit({
        state: first.state,
        resolution: committableWith([probeLayer("sock"), probeLayer("boot", 1)]),
        eventRef: contactEventRef("later_event"),
      });
      expect(again.commit.kind).toBe("contact_continued");
      expect(again.state).toBe(first.state);
    });

    it("does not count the adapter's array order as a change", () => {
      // `sortContactMaterialLayers` is a total canonical order and `order` is
      // itself fingerprinted, so where a layer sits in the array the adapter
      // handed over is a presentation detail rather than a physical claim.
      const stack = [probeLayer("sock", 0), probeLayer("boot", 1)];
      const first = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committableWith(stack),
        eventRef: PROBE_EVENT,
      });
      const reversed = mustCommit({
        state: first.state,
        resolution: committableWith([...stack].reverse()),
        eventRef: contactEventRef("reordered_event"),
      });
      expect(reversed.commit.kind).toBe("contact_continued");
      expect(reversed.state).toBe(first.state);
    });

    it("treats the same touch asserted from the other side as one contact", () => {
      const first = start();
      const swapped = probeAttempt({
        intent: {
          actorId: PROBE_TARGET,
          source: probeBodySurface(PROBE_TARGET, "feet", "arch"),
          target: probeBodySurface(PROBE_ACTOR, "hands"),
        },
        context: { actorControl: { status: "allowed", actorId: PROBE_TARGET, evidence: [] } },
      });
      const resolution = resolveContactAttempt(swapped);
      expect(resolution.status).toBe("committable");
      if (resolution.status !== "committable") return;
      const second = mustCommit({
        state: first.state,
        resolution,
        eventRef: contactEventRef("swapped_event"),
      });
      expect(second.state.contacts).toHaveLength(1);
      expect(second.contact.contactId).toBe(first.contact.contactId);
      expect(second.contact.source.subjectId).toBe(PROBE_ACTOR);
    });

    it("opens a second contact for a different pair of surfaces", () => {
      const first = start();
      const other = probeAttempt({ intent: { source: probeBodySurface(PROBE_ACTOR, "lips") } });
      const resolution = resolveContactAttempt(other);
      if (resolution.status !== "committable") throw new Error("fixture did not commit");
      const second = mustCommit({
        state: first.state,
        resolution,
        eventRef: contactEventRef("second_event"),
      });
      expect(second.state.contacts).toHaveLength(2);
    });
  });

  describe("end", () => {
    it("removes the contact and hands back an ended record", () => {
      const started = start();
      const { state, commit } = endContact({
        state: started.state,
        contactId: started.contact.contactId,
        reason: "withdrawn",
        storyTime: 200,
        eventRef: contactEventRef("end_event"),
      });
      expect(state.contacts).toEqual([]);
      expect(commit?.kind).toBe("contact_ended");
      if (commit?.kind !== "contact_ended") return;
      expect(commit.contact.phase).toBe("ended");
      expect(commit.contact.endReason).toBe("withdrawn");
      expect(commit.contact.endedAt).toBe(200);
    });

    it("makes an ended contact unfindable in the active projection", () => {
      const started = start();
      const { state } = endContact({
        state: started.state,
        contactId: started.contact.contactId,
        reason: "separated",
        storyTime: 200,
        eventRef: contactEventRef("end_event"),
      });
      expect(activeContact(state, started.contact.contactId)).toBeUndefined();
      expect(activeContactForPair(state, started.contact.pairKey)).toBeUndefined();
    });

    it("gives a restarted contact a new identity", () => {
      const started = start();
      const { state } = endContact({
        state: started.state,
        contactId: started.contact.contactId,
        reason: "separated",
        storyTime: 200,
        eventRef: contactEventRef("end_event"),
      });
      const restarted = mustCommit({
        state,
        resolution: committable({ storyTime: 300 }),
        eventRef: contactEventRef("restart_event"),
      });
      expect(restarted.commit.kind).toBe("contact_started");
      expect(restarted.contact.contactId).not.toBe(started.contact.contactId);
    });

    it("reports an end for something that is not active and changes nothing", () => {
      const sink = new DiagnosticCollector();
      const started = start();
      const { state, commit } = endContact({
        state: started.state,
        contactId: started.contact.contactId,
        reason: "withdrawn",
        storyTime: 200,
        eventRef: contactEventRef("end_event"),
        sink,
      });
      const second = endContact({
        state,
        contactId: started.contact.contactId,
        reason: "withdrawn",
        storyTime: 210,
        eventRef: contactEventRef("end_again"),
        sink,
      });
      expect(commit).not.toBeNull();
      expect(second.commit).toBeNull();
      expect(second.state).toBe(state);
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID]);
      expect(sink.hasErrors).toBe(true);
    });

    it("will not end a contact at a story time before its own last update", () => {
      // `endedAt < lastUpdatedAt` is a durable claim that the contact stopped
      // before the last thing known about it happened — a replay then sees a
      // contact that ended before it was last touched.
      const sink = new DiagnosticCollector();
      const started = start();
      const updated = mustCommit({
        state: started.state,
        resolution: committable({ requestedPressure: "firm", storyTime: 200 }),
        eventRef: contactEventRef("update_event"),
      });
      const stale = endContact({
        state: updated.state,
        contactId: updated.contact.contactId,
        reason: "withdrawn",
        storyTime: 150,
        eventRef: contactEventRef("stale_end"),
        sink,
      });
      expect(stale.commit).toBeNull();
      expect(stale.state).toBe(updated.state);
      expect(activeContact(stale.state, updated.contact.contactId)).toBeDefined();
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID]);
      expect(sink.hasErrors).toBe(false);

      // The same end at a current story time still closes it.
      const current = endContact({
        state: updated.state,
        contactId: updated.contact.contactId,
        reason: "withdrawn",
        storyTime: 200,
        eventRef: contactEventRef("current_end"),
      });
      expect(current.commit?.storyTime).toBe(200);
      expect(current.state.contacts).toEqual([]);
    });

    it("ends everything deterministically on a scene change", () => {
      const first = start();
      const other = resolveContactAttempt(probeAttempt({ intent: { source: probeBodySurface(PROBE_ACTOR, "lips") } }));
      if (other.status !== "committable") throw new Error("fixture did not commit");
      const both = mustCommit({
        state: first.state,
        resolution: other,
        eventRef: contactEventRef("second_event"),
      });
      const ended = endAllContacts({
        state: both.state,
        reason: "scene_changed",
        storyTime: 400,
        eventRef: contactEventRef("scene_event"),
      });
      expect(ended.state.contacts).toEqual([]);
      expect(ended.commits).toHaveLength(2);
      expect(ended.commits.map((commit) => commit.contactId)).toEqual(both.state.contacts.map((c) => c.contactId));
    });

    it("leaves a contact newer than the scene exit alive rather than back-dating its end", () => {
      // The ruling for an exit asserted from the past: per contact, not per
      // request. Refusing the whole exit would throw away the ends of every
      // contact it legitimately covers; ending the newer one anyway would stamp
      // `endedAt` before facts already committed about it.
      const sink = new DiagnosticCollector();
      const older = start();
      const otherAttempt = probeAttempt({
        intent: { source: probeBodySurface(PROBE_ACTOR, "lips"), storyTime: 300 },
      });
      const otherResolution = resolveContactAttempt(otherAttempt);
      if (otherResolution.status !== "committable") throw new Error("fixture did not commit");
      const newer = mustCommit({
        state: older.state,
        resolution: otherResolution,
        eventRef: contactEventRef("newer_event"),
      });

      const ended = endAllContacts({
        state: newer.state,
        reason: "scene_changed",
        storyTime: 200,
        eventRef: contactEventRef("stale_scene_event"),
        sink,
      });
      expect(ended.commits.map((commit) => commit.contactId)).toEqual([older.contact.contactId]);
      expect(ended.state.contacts.map((contact) => contact.contactId)).toEqual([newer.contact.contactId]);
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID]);
      // The stream and the projection still agree.
      expect(replayContactCommits({ commits: [...streamOf(older, newer), ...ended.commits] })).toEqual(ended.state);
    });
  });

  describe("projection invariants", () => {
    it("keys a contact by the order-independent surface pair", () => {
      const { contact } = start();
      const attempt = probeAttempt({});
      expect(contact.pairKey).toBe(contactPairKey(attempt.intent.source, attempt.intent.target));
    });

    it("keeps the stored composition in step with the stored layers", () => {
      const { contact } = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committableThrough(["sock", "boot"]),
        eventRef: PROBE_EVENT,
      });
      expect(recomposeContactTransmission(contact)).toEqual(contact.transmission);
    });

    it("ends the oldest with real events rather than trimming the projection", () => {
      // A contact that disappears from the projection with no event behind it
      // replays back into existence on the next branch restore, and nothing
      // downstream can tell the drop apart from a contact that really ended.
      const sink = new DiagnosticCollector();
      const outcomes: CommittedContactOutcome[] = [];
      let state = emptyContactLifecycleState();
      for (let index = 0; index < 20; index += 1) {
        const attempt = probeAttempt({
          intent: { source: probeBodySurface(PROBE_ACTOR, "hands", `finger_${index}`), storyTime: 100 + index },
        });
        const resolution = resolveContactAttempt(attempt);
        if (resolution.status !== "committable") throw new Error("fixture did not commit");
        const outcome = mustCommit({
          state,
          resolution,
          eventRef: contactEventRef(`event_${index}`),
          sink,
        });
        outcomes.push(outcome);
        state = outcome.state;
      }
      expect(state.contacts).toHaveLength(16);
      const ended = outcomes.flatMap((outcome) => [...outcome.ended]);
      expect(ended).toHaveLength(4);
      expect(ended.every((commit) => commit.reason === "state_invalidated")).toBe(true);
      expect(sink.items.map((item) => item.code)).toEqual(Array<string>(4).fill(CONTACT_LIFECYCLE_INVALID));
      // The stream and the projection agree — nothing left without an event.
      expect(replayContactCommits({ commits: streamOf(...outcomes) })).toEqual(state);
    });

    it("refuses a new contact rather than evicting a victim it cannot end honestly", () => {
      // Capacity's victims are unrelated pairs, so the stale-assertion guard —
      // which is about the pair being asserted — protects none of them. An
      // assertion perfectly current for its own contact can still be older than
      // the contact eviction would destroy, and ending that one would stamp
      // `endedAt` before its own last update.
      const sink = new DiagnosticCollector();
      let state = emptyContactLifecycleState();
      for (let index = 0; index < 16; index += 1) {
        const attempt = probeAttempt({
          intent: { source: probeBodySurface(PROBE_ACTOR, "hands", `finger_${index}`), storyTime: 200 + index },
        });
        const resolution = resolveContactAttempt(attempt);
        if (resolution.status !== "committable") throw new Error("fixture did not commit");
        state = mustCommit({ state, resolution, eventRef: contactEventRef(`event_${index}`) }).state;
      }
      expect(state.contacts).toHaveLength(16);

      const lateAttempt = probeAttempt({
        intent: { source: probeBodySurface(PROBE_ACTOR, "lips"), storyTime: 150 },
      });
      const lateResolution = resolveContactAttempt(lateAttempt);
      if (lateResolution.status !== "committable") throw new Error("fixture did not commit");
      const refused = commitContactResolution({
        state,
        resolution: lateResolution,
        eventRef: contactEventRef("late_event"),
        sink,
      });

      expect(refused.status).toBe("refused");
      if (refused.status !== "refused") return;
      expect(refused.reason).toBe("capacity_blocked_by_newer_contact");
      // Nothing written, nothing ended, nothing dropped.
      expect(refused.state).toBe(state);
      expect(refused.state.contacts).toHaveLength(16);
      expect(contactCommitEvents(refused)).toEqual([]);
      expect(refused.blockedBy).toHaveLength(1);
      const blocked = refused.blockedBy[0];
      expect(blocked !== undefined && activeContact(state, blocked) !== undefined).toBe(true);
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID]);
      expect(sink.hasErrors).toBe(false);

      // A refusal has no contact and no commit to read off it — the union is
      // the guarantee, and this is its runtime shadow.
      expect(refused).not.toHaveProperty("contact");
      expect(refused).not.toHaveProperty("commit");
    });
  });

  describe("replay", () => {
    it("folds a stream back into the projection it came from", () => {
      const started = start();
      const held = mustCommit({
        state: started.state,
        resolution: committable(),
        eventRef: contactEventRef("held_event"),
      });
      const changed = mustCommit({
        state: held.state,
        resolution: committable({ requestedPressure: "moderate", storyTime: 140 }),
        eventRef: contactEventRef("changed_event"),
      });
      const commits = streamOf(started, held, changed);
      expect(replayContactCommits({ commits })).toEqual(changed.state);
      // The held exchange wrote nothing: one start, one continue, one update.
      expect(commits.map((commit) => commit.kind)).toEqual([
        "contact_started",
        "contact_continued",
        "contact_updated",
      ]);
      expect(replayContactCommits({ commits }).contacts).toHaveLength(1);
    });

    it("restores optional values that were CLEARED, not just ones that changed", () => {
      // A patch cannot express removal. An update event that simply omitted the
      // pressure it no longer has replays as the pressure the contact used to
      // carry — the projection is right and the durable record is wrong.
      const stated = mustCommit({
        state: emptyContactLifecycleState(),
        resolution: committable({
          requestedPressure: "firm",
          requestedArea: "broad",
          requestedMotion: { band: "sliding", pathDetailIds: ["arch"] },
        }),
        eventRef: PROBE_EVENT,
      });
      const cleared = mustCommit({
        state: stated.state,
        resolution: committable({ storyTime: 140 }),
        eventRef: contactEventRef("cleared_event"),
      });
      expect(cleared.commit.kind).toBe("contact_updated");
      expect(cleared.contact.pressure).toBeUndefined();
      expect(cleared.contact.contactArea).toBeUndefined();
      expect(cleared.contact.motion).toBeUndefined();
      if (cleared.commit.kind !== "contact_updated") return;
      expect(cleared.commit.snapshot).toMatchObject({ pressure: null, contactArea: null, motion: null });

      const replayed = replayContactCommits({ commits: streamOf(stated, cleared) });
      expect(replayed).toEqual(cleared.state);
      expect(replayed.contacts[0]?.pressure).toBeUndefined();
      expect(replayed.contacts[0]?.motion).toBeUndefined();
    });

    it("replays an end without resurrecting the contact", () => {
      const started = start();
      const ended = endContact({
        state: started.state,
        contactId: started.contact.contactId,
        reason: "separated",
        storyTime: 200,
        eventRef: contactEventRef("end_event"),
      });
      if (ended.commit === null) throw new Error("fixture did not end");
      expect(replayContactCommits({ commits: [...streamOf(started), ended.commit] })).toEqual(ended.state);
    });

    it("reports a stream that contradicts the projection instead of guessing", () => {
      const sink = new DiagnosticCollector();
      const started = start();
      const changed = mustCommit({
        state: started.state,
        resolution: committable({ requestedPressure: "firm", storyTime: 140 }),
        eventRef: contactEventRef("changed_event"),
      });

      // The same start twice — the pair is already occupied.
      const twice = replayContactCommits({ commits: [...streamOf(started), ...streamOf(started)], sink });
      expect(twice.contacts).toHaveLength(1);
      // An update with no contact under it changes nothing.
      const orphan = applyContactCommit(emptyContactLifecycleState(), changed.commit, sink);
      expect(orphan.contacts).toEqual([]);

      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID, CONTACT_LIFECYCLE_INVALID]);
      expect(sink.hasErrors).toBe(true);
    });
  });

  describe("authorization that lapses under a live contact", () => {
    function liveRomantic() {
      return mustCommit({
        state: emptyContactLifecycleState(),
        resolution: romantic(),
        eventRef: PROBE_EVENT,
      });
    }

    /** Re-check one live contact against a fresh answer — or against silence. */
    function sweep(
      live: CommittedContactOutcome,
      current?: { policy?: ReturnType<typeof probePolicy>; eligibility?: ReturnType<typeof probeEligibility> },
      sink?: DiagnosticCollector,
      storyTime = 300,
    ) {
      return endUnauthorizedContacts({
        state: live.state,
        authorizations:
          current === undefined
            ? []
            : [
                {
                  contactId: live.contact.contactId,
                  participantEligibility: current.eligibility ?? probeEligibility("eligible"),
                  policy: current.policy ?? probePolicy("allowed", "romantic"),
                },
              ],
        storyTime,
        eventRef: contactEventRef("sweep_event"),
        ...(sink === undefined ? {} : { sink }),
      });
    }

    it("ends a romantic contact whose permission was withdrawn", () => {
      const sink = new DiagnosticCollector();
      const live = liveRomantic();
      const swept = sweep(live, { policy: probePolicy("withdrawn", "romantic") }, sink);
      expect(swept.state.contacts).toEqual([]);
      expect(swept.commits.map((commit) => commit.reason)).toEqual(["policy_withdrawn"]);
      expect(swept.commits[0]?.contact.phase).toBe("ended");
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_AUTHORIZATION_LAPSED]);
      expect(replayContactCommits({ commits: [...streamOf(live), ...swept.commits] })).toEqual(swept.state);
    });

    it("ends it when the permission stops covering the action's scope", () => {
      const swept = sweep(liveRomantic(), { policy: probePolicy("allowed", "casual") });
      expect(swept.commits.map((commit) => commit.reason)).toEqual(["policy_withdrawn"]);
    });

    it("fails closed when nobody answers for a contact that needs an answer", () => {
      const swept = sweep(liveRomantic());
      expect(swept.commits.map((commit) => commit.reason)).toEqual(["state_invalidated"]);
      expect(swept.state.contacts).toEqual([]);
    });

    it("ends it when eligibility stops covering a participant", () => {
      const swept = sweep(liveRomantic(), { eligibility: probeEligibility("eligible", [PROBE_ACTOR]) });
      expect(swept.commits.map((commit) => commit.reason)).toEqual(["state_invalidated"]);
    });

    it("leaves a contact whose kind never needed a grant alone", () => {
      const sink = new DiagnosticCollector();
      const live = start();
      const swept = sweep(live, undefined, sink);
      expect(swept.commits).toEqual([]);
      expect(swept.state).toEqual(live.state);
      expect(sink.items).toEqual([]);
    });

    it("keeps a romantic contact whose permission still holds", () => {
      const swept = sweep(liveRomantic(), {});
      expect(swept.commits).toEqual([]);
      expect(swept.state.contacts).toHaveLength(1);
    });

    it("leaves a contact newer than the sweep alive rather than back-dating its end", () => {
      // A sweep is a read of what is true NOW, so one stamped before a
      // contact's own last update is an out-of-order write. The contact is
      // carried to the next sweep — a lapsed authorization does not un-lapse.
      const sink = new DiagnosticCollector();
      const live = liveRomantic();
      const swept = sweep(live, { policy: probePolicy("withdrawn", "romantic") }, sink, 50);
      expect(swept.commits).toEqual([]);
      expect(swept.state.contacts.map((contact) => contact.contactId)).toEqual([live.contact.contactId]);
      expect(sink.items.map((item) => item.code)).toEqual([CONTACT_LIFECYCLE_INVALID]);

      // The same withdrawal at a current story time still ends it.
      const later = sweep(live, { policy: probePolicy("withdrawn", "romantic") });
      expect(later.commits.map((commit) => commit.reason)).toEqual(["policy_withdrawn"]);
    });
  });
});
