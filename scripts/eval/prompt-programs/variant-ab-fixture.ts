import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import type { AttributeValue } from "@/contracts/attributes";
import type { AvatarWardrobeItem } from "@/server/images";

/**
 * The variant A/B's character, in one place.
 *
 * Two scripts need the same person and must not drift: `variant-prompt-ab.ts`
 * builds the prompts measured against her, and `variant-ab-reference.ts`
 * generates the canonical portrait those prompts edit. If each owned its own
 * copy, a change to the sheet would move the prompts without moving the face
 * they are graded against — and the trial would silently be measuring an edit
 * of somebody else.
 *
 * She is declared HERE rather than borrowed from `@/server/test-support`'s lane
 * probe for a mechanical reason: that barrel eagerly imports vitest
 * (`route-assertions.ts`, `sim-assertions.ts`, `sim-harness.ts`), so a runnable
 * script importing it dies at load, and a script may not deep-import past a
 * server barrel either (eslint no-restricted-imports zone 4).
 * `scripts/check-route-authz.ts` records the same constraint and resolves it the
 * same way. So this fixture is the TRIAL's, not the shadow's probe: the two are
 * authored to the same shape and both exercise the species delta, but they are
 * separate literals and a number from this trial and one from
 * `shadow-report.ts` describe two characters, not one.
 */

/** The fixture's name — one place, since it appears in name-bound prompt sentences. */
export const FIXTURE_NAME = "Nyx";

/** The fixture's subject id — the one id the assembly, the digest and the cut all name. */
export const FIXTURE_SUBJECT_ID = "variant-ab-subject";

/** The standalone read token the assembly fingerprints — this trial's committed-cut stand-in. */
export const FIXTURE_READ_TOKEN = "variant-ab-token";

/** The output root every artefact of this trial lands under. */
export const OUT_BASE = process.env["AB_OUT"] ?? "eval-images/variant-prompt-ab";

/**
 * Where the identity reference lives — the picture BOTH arms send.
 *
 * One constant so the generator writes exactly the file the trial reads; two
 * spellings of this path is how a trial ends up editing a face nobody looked at.
 */
export const REFERENCE_DEFAULT = `${OUT_BASE}/reference-face.webp`;

function baseAttribute(id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue {
  return { id, value, source: "base" };
}

/**
 * The character both scripts describe.
 *
 * A succubus with spiraled horns, membranous wings and a spaded tail, because
 * the one delta the cutover claims over the legacy prompt is the digest's
 * morphology anchors (`VARIANT_SHADOW_DELTA = added: horns/wings/tail`) — a
 * fixture without them measures nothing about the change under test.
 * `voice.timbre` is the leak control: nothing visual may state it, so a render
 * that somehow renders a voice is a `no_other_regression` finding.
 */
export function trialCharacterProfile(): CharacterProfile {
  return {
    ...emptyCharacterProfile(),
    bio: "A daemonkin broker who deals in favors.",
    personality: "Unhurried, amused, entirely unbothered.",
    age: "134",
    speciesId: "succubus",
    intimateRegions: ["breasts", "vulva"],
    attributes: [
      baseAttribute("identity.apparent_age", "late_twenties"),
      baseAttribute("identity.gender", "female"),
      baseAttribute("identity.heritage", "Latina"),
      baseAttribute("hair.color", "deep_violet"),
      baseAttribute("eyes.color", "amber"),
      baseAttribute("skin.tone", "bronze"),
      baseAttribute("horns.shape", "spiraled"),
      baseAttribute("wings.type", "membranous"),
      baseAttribute("tail.type", "spaded"),
      baseAttribute("legs.build", "athletic"),
      baseAttribute("feet.nails", "painted"),
      baseAttribute("breasts.size", "ample"),
      baseAttribute("breasts.nipples", "puffy"),
      baseAttribute("voice.timbre", "gravelly"),
    ],
  };
}

/**
 * The character's default outfit.
 *
 * The variant lane states no garment names — the reference image shows the
 * clothes — but coverage still drives the camera's perception and the exposure
 * the intimate gate reads, so a DRESSED fixture is what production runs.
 */
export function trialWardrobe(): AvatarWardrobeItem[] {
  return [
    {
      name: "silk kimono",
      description: "a floor-length wine-red silk kimono",
      appearance: "embroidered with pale cranes",
      coverage: ["chest", "groin", "hips", "buttocks", "thighs"],
      layer: 1,
      opacity: "opaque",
    },
    { name: "slippers", description: "flat black slippers", coverage: ["feet"], layer: 1, opacity: "opaque" },
  ];
}
