import { describe, expect, it } from "vitest";
import {
  affordanceSubjectId,
  presentTactileCues,
  probeGustatoryObservation,
  probeOlfactoryObservation,
  probeSensoryBodyLocus,
  probeTactileObservation,
  routeContactPhenomena,
  SENSORY_PROBE_BYSTANDER,
  SENSORY_PROBE_OBSERVER,
  SENSORY_PROBE_PARTNER,
  type ContactPhenomenonObservation,
} from "@/contracts";
import { renderChatSensoryLines, type ChatSensorySubject } from "./chat-sensory-cues";

/**
 * The narration door for the nonvisual senses. Two claims, both load-bearing:
 *
 * 1. **A nonvisual cue reaches prose only through its sense owner.** The whole
 *    fixture-only path is exercised end to end — channel-tagged envelope →
 *    routing → the tactile owner's access law and selection → this renderer —
 *    and the same phenomenon renders NOTHING for an observer the access law
 *    refuses. Falsified against a renderer fed observations directly past the
 *    owner, and against an access law that stopped biting.
 * 2. **Never an id in prose.** Only "your" and the digest character's
 *    possessive may name a participant; anyone else — and any object locus,
 *    whose only name is an id — is silence.
 *
 * No producer emits nonvisual phenomena yet, so this suite is also the proof
 * the door works before stage 10 wires it: `chatSensoryCuesEnabled()` (tested
 * in `prompts/constants.test.ts`) decides whether the pipeline may call this
 * at all, and it defaults off.
 */

const SUBJECT: ChatSensorySubject = {
  characterName: "Mara",
  possessive: "Mara's",
  subjectId: SENSORY_PROBE_PARTNER,
  playerSubjectId: SENSORY_PROBE_OBSERVER,
};

describe("renderChatSensoryLines", () => {
  it("carries a tactile fact from the routing envelope to one clause, through the owner alone", () => {
    const envelope: ContactPhenomenonObservation = {
      phenomenonId: "probe.felt_warmth",
      channel: "tactile",
      subjectIds: [SENSORY_PROBE_PARTNER, SENSORY_PROBE_OBSERVER],
      locus: { kind: "body", subjectId: SENSORY_PROBE_PARTNER, locationId: "hands" },
      targetLocus: { kind: "body", subjectId: SENSORY_PROBE_OBSERVER, locationId: "shoulders" },
      intensityBand: "clear",
      semanticTags: ["warm"],
      repeatFamily: "probe:felt_warmth",
      evidence: [],
    };
    const routing = routeContactPhenomena([envelope]);
    const felt = presentTactileCues(routing.tactile, { observerId: SENSORY_PROBE_OBSERVER });
    expect(renderChatSensoryLines({ digests: { tactile: felt.digest }, subject: SUBJECT })).toEqual([
      "warm to the touch at Mara's hands",
    ]);

    // The same committed fact, an observer the access law refuses: the owner
    // offers nothing, so narration has nothing — there is no other door.
    const unfelt = presentTactileCues(routing.tactile, { observerId: SENSORY_PROBE_BYSTANDER });
    expect(renderChatSensoryLines({ digests: { tactile: unfelt.digest }, subject: SUBJECT })).toEqual([]);
  });

  it("says nothing for a participant it cannot name, and nothing for an object locus — never an id", () => {
    const stranger = probeTactileObservation({
      surface: probeSensoryBodyLocus(affordanceSubjectId("roster_member_7"), "hands"),
    });
    const object = probeGustatoryObservation({
      tastedSurface: { kind: "object", entityId: "probe_cup", surfaceId: "rim" },
    });
    const lines = renderChatSensoryLines({
      digests: {
        tactile: { sense: "tactile", observerId: SENSORY_PROBE_OBSERVER, selected: [stranger], suppressedCount: 0 },
        gustatory: { sense: "gustatory", observerId: SENSORY_PROBE_OBSERVER, selected: [object], suppressedCount: 0 },
      },
      subject: SUBJECT,
    });
    expect(lines).toEqual([]);
  });

  it("keeps the block on the strict budget, touch first, and words the bands rather than numbering them", () => {
    const lines = renderChatSensoryLines({
      digests: {
        tactile: {
          sense: "tactile",
          observerId: SENSORY_PROBE_OBSERVER,
          selected: [
            probeTactileObservation({ intensityBand: "strong", semanticTags: ["warm"] }),
            probeTactileObservation({
              phenomenonId: "probe.felt_texture",
              repeatFamily: "probe:felt_texture",
              intensityBand: "subtle",
              semanticTags: ["slick"],
              surface: probeSensoryBodyLocus(SENSORY_PROBE_OBSERVER, "shoulders"),
            }),
          ],
          suppressedCount: 0,
        },
        olfactory: {
          sense: "olfactory",
          observerId: SENSORY_PROBE_OBSERVER,
          selected: [probeOlfactoryObservation()],
          suppressedCount: 0,
        },
      },
      subject: SUBJECT,
    });
    expect(lines).toEqual([
      "unmistakably warm to the touch at Mara's hands",
      "faintly slick to the touch at your shoulders",
    ]);
  });
});
