import type { SdEvaluationFixture } from "./evaluation-fixtures";

/**
 * The seeded Stage 3 comparison fixtures (sd-rendering-package.plan.md §20,
 * Stage 3).
 *
 * Stage 3 runs one controlled matrix — base SDXL against PuLID at 0.65, 0.80 and
 * 0.95 — and grades seven dimensions: face, age, hair, build,
 * clothing_flexibility, pose_flexibility, state_obedience. These eight fixtures
 * are the other axis of that matrix. Each one is a scene the same identity has
 * to survive, and between them a grader can put a number in every column;
 * `evaluation-fixture-registry.test.ts` holds that last claim, so a fixture
 * removed later cannot silently leave a column nothing scores.
 *
 * **No fixture describes a person.** Not an age, not a hair colour, not a build,
 * not a gender — the subject is "a person" and everything else in the prompt is
 * scene, styling, framing and light. This is the whole design, and it is easy to
 * undo by accident: the moment a prompt says "auburn-haired woman in her late
 * twenties", the `age` and `hair` columns stop measuring whether identity
 * transferred from the reference and start measuring whether SDXL can follow an
 * adjective, which it can. Identity arrives at run time as the reference image
 * and nowhere else, so those three columns grade the render against the
 * REFERENCE — which is only possible while the prompt is silent about them.
 *
 * **Every seed is fixed, and that is the point of the type.** All four arms of a
 * cell render the same fixture at the same seed, so the only thing that differs
 * between them is identity strength — §7's "only one variable should move at a
 * time", made unavoidable. The seeds differ BETWEEN fixtures on purpose: eight
 * images off one noise draw would share that draw's luck, and a grader would be
 * reading the sampler as much as the recipe. The particular integers are
 * arbitrary; their only property is that they never change.
 *
 * **`recipeId` records what the prompts were written against, not what will run.**
 * Every fixture names `sdxl/identity-portrait` — the 832×1216 portrait geometry
 * and the identity layers switched on — because that is the configuration these
 * scenes were composed for. The Stage 3 harness overrides it per arm (that
 * override IS the comparison) and writes the arm's own recipe into the run
 * manifest beside each image, so nothing downstream has to infer it from here.
 *
 * **The notes field is read, not decorative.** Each one opens with `Probes:`
 * followed by dimension names spelled exactly as `sdEvaluationDimensions` spells
 * them, because the coverage test reads those names back out. The prose after it
 * says what a regression in that cell would mean.
 */

/**
 * The negative prompt every fixture carries, and the §19 minefield it walks
 * around.
 *
 * §19 is explicit that a legitimate Vesper render can contain unusual anatomy,
 * missing limbs, prosthetics, text, logos, blur, non-human features and authored
 * wardrobe or exposure states — and that generic terms contradicting canonical
 * visual state must never be injected. A stock SDXL negative prompt, the kind
 * pasted between forum posts, is almost entirely made of exactly those terms:
 * "deformed, extra limbs, missing limbs, bad anatomy, text, watermark, logo,
 * blurry, nude". Every one of them would quietly veto something Vesper is
 * allowed to author, and two of the fixtures below exist specifically to render
 * content such a negative would suppress.
 *
 * So what is left is medium and format only — the render is a photograph of one
 * person, not a drawing and not a contact sheet. None of those terms can
 * contradict an authored state, because none of them describes the subject.
 *
 * `two people, crowd` is the one line about content, and it is safe here because
 * these fixtures are single-subject by construction; it is not a rule about
 * Vesper renders in general, where a second character is ordinary.
 */
const SD_EVALUATION_NEGATIVE =
  "cartoon, anime, illustration, painting, drawing, sketch, 3d render, cgi, video game screenshot, collage, split screen, multiple panels, picture frame, border, two people, crowd";

export const sdEvaluationFixtures: readonly SdEvaluationFixture[] = [
  {
    id: "front-portrait-neutral",
    recipeId: "sdxl/identity-portrait",
    prompt:
      "photograph of a person, head and shoulders portrait, facing the camera straight on, neutral expression, eyes to the lens, plain light grey seamless backdrop, soft even frontal light, 85mm lens, natural skin texture",
    negativePrompt: SD_EVALUATION_NEGATIVE,
    seed: 110_517,
    notes:
      "Probes: face, age, hair. The anchor cell — the easiest render in the set, front-lit and frontal, so a likeness that fails HERE is not the fixture being unfair. Every other cell is read against this one: a face that is the reference's here and a stranger's under hard light is a finding about identity strength, while a face that is a stranger's in both is a finding about the arm.",
  },
  {
    id: "full-body-standing",
    recipeId: "sdxl/identity-portrait",
    prompt:
      "full body photograph of a person standing, whole figure in frame from head to feet, arms relaxed at their sides, facing the camera, plain concrete wall, soft overcast daylight, wide shot, 35mm lens",
    // The only fixture with a framing term added, and framing is not an authored
    // state: `cropped` here means "the renderer cut the feet off", which is the
    // failure mode that makes a full-body cell ungradeable for `build`.
    negativePrompt: `${SD_EVALUATION_NEGATIVE}, cropped, close-up, head and shoulders framing`,
    seed: 220_931,
    notes:
      "Probes: build, face, clothing_flexibility. Build is only gradeable with the whole figure in frame, and this framing is also where the face falls to a few dozen pixels — the distance at which identity conditioning has least to work with. Clothing is deliberately left unspecified, so the cell doubles as the unprompted-wardrobe question: asked for no outfit at all, does the render invent one or copy the reference's?",
  },
  {
    id: "outfit-formal-overcoat",
    recipeId: "sdxl/identity-portrait",
    prompt:
      "photograph of a person walking along a city pavement, wearing a tailored charcoal wool overcoat over a white collared shirt and a dark scarf, three-quarter length shot, overcast winter daylight, shallow depth of field",
    negativePrompt: SD_EVALUATION_NEGATIVE,
    seed: 331_408,
    notes:
      "Probes: clothing_flexibility, face. The outfit is named in detail and chosen to be unlike anything an identity reference is likely to have been shot in. The failure this grades is the reference's own clothing bleeding into the render, which is expected to worsen as identity weight rises — the exact trade §8 says must not be hidden behind a single quality score.",
  },
  {
    id: "pose-seated-forward",
    recipeId: "sdxl/identity-portrait",
    prompt:
      "photograph of a person seated on a wooden chair, leaning forward, forearms resting on their knees, hands loosely clasped, body turned three-quarters away from the camera with the head turned back toward the lens, bare studio floor, single soft key light from the left",
    negativePrompt: SD_EVALUATION_NEGATIVE,
    seed: 442_760,
    notes:
      "Probes: pose_flexibility, face. Identity adapters pull a render back toward the frontal, centred head crop they condition on. A body angled away with the head turned back is where that pull shows: the graded failure is a render that quietly straightens up and faces front, having ignored the pose to keep the face easy.",
  },
  {
    id: "location-night-street",
    recipeId: "sdxl/identity-portrait",
    prompt:
      "photograph of a person standing under a shop awning at night, wet pavement, neon signage out of focus behind them, hard coloured rim light from the right, deep shadows, high contrast",
    negativePrompt: SD_EVALUATION_NEGATIVE,
    seed: 553_219,
    notes:
      "Probes: face, hair. The hostile lighting case, and the counterpart to front-portrait-neutral: hard coloured light off a wet street throws shadow across half the face and a colour cast over skin and hair. §8 asks for location flexibility, and this is where a likeness that only survives studio light comes apart.",
  },
  {
    id: "expression-laughing",
    recipeId: "sdxl/identity-portrait",
    prompt:
      "candid photograph of a person laughing, head tilted slightly back, eyes narrowed, mouth open mid-laugh, warm daylight through a window, plain wall behind, waist-up shot",
    negativePrompt: SD_EVALUATION_NEGATIVE,
    seed: 664_085,
    notes:
      "Probes: face, age, pose_flexibility. §8 names expression flexibility explicitly, and a strong expression deforms exactly the features an identity adapter locks — so both failure directions are legible in one image: the laugh flattens back toward neutral (identity too strong), or the laughing face stops being the reference's (identity too weak). Age rides along because apparent age is what a model most often shifts when it redraws a creased, animated face.",
  },
  {
    id: "state-prosthetic-forearm",
    recipeId: "sdxl/identity-portrait",
    prompt:
      "photograph of a person standing at a kitchen counter, three-quarter view, their left arm ending below the elbow in a matte black prosthetic forearm and mechanical hand, short sleeved shirt so the whole prosthetic is visible, plain kitchen, soft morning daylight, waist-up shot",
    // Deliberately the shared negative and nothing else. §19 names prosthetics
    // and missing limbs as legitimate content, so ONE "deformed, extra limbs,
    // missing limbs" paste here would suppress the only thing this cell renders
    // and the run would score a clean 0 that means nothing.
    negativePrompt: SD_EVALUATION_NEGATIVE,
    seed: 775_642,
    notes:
      "Probes: state_obedience, build. The authored state generic priors overwrite most reliably: asked for a prosthetic limb, a model draws two flesh arms and reports success. Graded on three things a reader can check — the prosthetic is present, it is on the stated arm, and it replaces the forearm rather than being worn over a hand. state_obedience is the Vesper-specific column no general image benchmark measures, and this is the body-level half of it.",
  },
  {
    id: "state-face-dressing",
    recipeId: "sdxl/identity-portrait",
    prompt:
      "photograph of a person facing the camera, a small square white adhesive dressing taped high on their right cheekbone, neutral expression, plain background, soft even light, head and shoulders portrait",
    negativePrompt: SD_EVALUATION_NEGATIVE,
    seed: 886_193,
    notes:
      "Probes: state_obedience, face. The second state probe, and deliberately ON the face: identity conditioning rewrites the face region hardest, so an authored mark there is the one it is most likely to erase. Read beside state-prosthetic-forearm it separates two findings a single probe would confuse — a model that ignores authored state everywhere, and an identity adapter that only overwrites the face.",
  },
];
