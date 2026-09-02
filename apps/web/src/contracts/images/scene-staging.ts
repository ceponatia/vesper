import {
  createSceneStagingSurfaceForms,
  isSceneStagingId,
  sceneStagingIds,
  type SceneStagingId,
  type SceneStagingSemantics,
  type SceneStagingSurfaceFormTable,
  type SceneStagingSurfaceForms,
  type SceneStagingTable,
} from "@vesper/image-core";

/**
 * The **staging catalog** — one entry per stageable intimate configuration.
 *
 * During intimate play the picture and the text diverge worst: the narration describes a
 * specific act with a specific geometry, and the render comes back a nude portrait — right
 * person, right room, wrong moment. The cause is not prudishness in the image model but a
 * hole in the prompt. The character's explicit anatomy is already stated deterministically
 * (the program's intimate reveal over the committed cut's coverage), while the **act** never
 * is, because the only thing that could
 * write it is the small composing model — which runs in a safe configuration and answers
 * with "close to the viewer, intimate".
 *
 * So the registry owns every explicit word, and the composer owns nothing but an `id` and a
 * quote. That is a grounding decision before it is a moderation one: a bold composer cannot
 * invent an act the story never described, and a cautious one cannot water down an act it
 * did. The gates are code either way — evidence, subject exposure, and the uncensored route.
 *
 * ## Templates
 *
 * Geometry-first, positive phrasing, `{name}` for the subject, and **every limb noun
 * possessive-bound** — to `{name}` or to "the viewer's own". An unowned limb in a
 * first-person prompt is the phantom-limb scar (2026-07-29), and a registry test runs the
 * `BARE_LIMB` pattern over each template with `{name}` substituted so none can land here.
 *
 * **A staging template owns the viewer-limb phrasing for the parts it names.** The generic
 * viewer-body framing lines describe foreground limbs near the lens ("entering frame from
 * the lower edge, close to the lens…") — the right geometry for a hand reaching into shot,
 * the wrong one for a hand placed on somebody. `viewerParts` is therefore the **gate list**:
 * every id still passes `resolveViewerParts` (registry membership, route, player coverage),
 * while the staged sentence supplies the geometry. Unlike the composer, a staging may list
 * intimate parts directly — it is registry data, not model output — and the route and
 * coverage gates still decide whether they render at all.
 *
 * PURE. A new configuration is one entry; a phrasing fix is a data edit.
 *
 * ## What this file no longer declares
 *
 * The id union and the facts behind each id — the camera, the viewer parts, the bare regions,
 * the intimate flag, the face override, the cast — are `@vesper/image-core`'s
 * {@link SceneStagingSemantics}, because both sides of the render seam reason over them and a
 * second declaration here would let them drift while both kept compiling. The table below
 * satisfies the shared shape rather than restating it, so a new arrangement in the shared
 * vocabulary is a compile error here until this registry says what it means. Selection, the
 * evidence gates, the sentence and the composer's hint stay app-side: none of them is
 * decidable without reading English, and none of them belongs to a compiler.
 */

export { sceneStagingIds };
export type { SceneStagingId };

/**
 * One arrangement: what it means, plus the two things only this side has.
 *
 * The semantics are shared. The **template** is the sentence a render is built from, and the
 * **hint** is how a composer recognises the arrangement — two audiences, two fields, so a
 * template tuned for render quality cannot silently retrain selection.
 *
 * Three app-side rules the shared semantics do not state, because they are rulings about this
 * catalog rather than properties of the vocabulary:
 *
 * - **An away-facing entry carries orientation `away`, never `away_glance_back`** (owner
 *   ruling 2026-08-10). The glance is a separate physical claim needing its own narration
 *   evidence; a glance-back variant would be its own entry, and there are none in v1.
 * - **Every entry is `solo` in v1** — each describes a two-body geometry between the subject
 *   and the viewer, so a second character in the room makes the sentence a lie about who is
 *   where. The roster gate runs in `resolveScenePlan`, which is the only side that knows who
 *   is present.
 * - **A template owns the viewer-limb phrasing for the parts it names**, so `viewerParts`
 *   stays a gate list resolved through `resolveViewerParts` rather than a phrasing source.
 */
export type SceneStaging = SceneStagingSemantics & {
  /** The staging sentence. `{name}` is the subject. Written once, here, never by a model. */
  template: string;
  /**
   * How the COMPOSER recognises this configuration — one clause naming the geometry that
   * makes this entry the right answer and its siblings the wrong one.
   *
   * It exists because the composer was shown bare ids and nothing else, and an id is not a
   * definition: `kneeling_before_viewer_guided` differs from `kneeling_before_viewer` by one
   * adjective whose whole meaning lives in {@link SceneStaging.template}, so no model could
   * infer it. In the 2026-08-15 composer A/B that cost the guided entry every run — 0/16
   * across eight models, all of them answering the plain sibling.
   *
   * **Not the template, and never rendered into an image prompt.** The template is explicit
   * because a render needs explicit words; a hint is a recognition cue for a planner that is
   * choosing between thirteen options, and it stays plain.
   *
   * Write it to answer "how do I tell this from its neighbours?" — the distinguishing fact
   * first, in the vocabulary a narrator would use.
   */
  hint: string;
};

export const sceneStagings = {
  held_from_behind: {
    id: "held_from_behind",
    camera: { orientation: "away", distance: "medium", height: "eye_level" },
    viewerParts: ["hands", "forearms"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} standing with {name}'s back against the viewer's chest, the viewer's own arms closed around {name} from behind and the viewer's own hands resting on {name}'s stomach",
    hint: "standing, held from behind — the viewer's arms around her from behind, both still dressed.",
    cast: "solo",
  },
  held_from_behind_bare: {
    // The same hold, bare. Split into its own entry rather than made conditional, because a
    // clothed embrace and a bare one are different sentences, not one sentence with a flag.
    id: "held_from_behind_bare",
    camera: { orientation: "away", distance: "medium", height: "eye_level" },
    viewerParts: ["hands", "forearms"],
    requiresBare: ["torso"],
    intimate: true,
    template:
      "{name} standing bare-skinned with {name}'s back against the viewer's chest, the viewer's own arms closed around {name} from behind and the viewer's own hands cupping {name}'s bare breasts",
    hint: "the same hold from behind, but she is bare from the waist up and the viewer's hands are on her bare breasts.",
    cast: "solo",
  },
  kneeling_before_viewer: {
    // Acceptance scene "Oral", composition A (owner-specified 2026-08-10): her face visible,
    // looking up, mid-act. `requiresBare` is empty on purpose — the bare anatomy this shot
    // needs is the VIEWER's, and that is gated by `viewerParts` against the player's own
    // coverage, not by the subject's.
    id: "kneeling_before_viewer",
    camera: { orientation: "toward_viewer", distance: "close", height: "high" },
    viewerParts: ["genitals"],
    requiresBare: [],
    intimate: true,
    // "Below the camera" is the frame anchor for this entry's high angle (probe run
    // 2026-08-14, kneel/oral beats: stated camera height alone moved her gaze, never the
    // camera — she looked up at nothing from an eye-level shot).
    template:
      "{name} kneeling on the floor below the camera and facing up toward it, {name}'s face tilted up toward the viewer and {name}'s mouth on the viewer's own genitals, {name}'s eyes on the viewer",
    hint: "she kneels facing the viewer with her mouth on them and her face tilted up, visible — the viewer's hands are NOT on her.",
    cast: "solo",
  },
  kneeling_before_viewer_guided: {
    // Composition B of the same acceptance scene: the shot looks down on the crown of her
    // head. `faceVisibility: "hidden"` is the whole reason the override field exists — the
    // orientation is `toward_viewer`, and the face is hidden by head angle alone, so the
    // lock adaptation's `hidden` branch has to fire off the staging rather than the camera.
    id: "kneeling_before_viewer_guided",
    camera: { orientation: "toward_viewer", distance: "close", height: "high" },
    viewerParts: ["hands", "forearms", "genitals"],
    requiresBare: [],
    intimate: true,
    // Two ATTRIBUTION fixes, both from the 2026-08-15 all-inclusive-LoRA run, where the act
    // and the crown-of-head composition rendered perfectly and only the hand's ownership
    // failed — once as a phantom arm materializing behind her head, once as HER own arm
    // reaching up, which left the render with three of them.
    //
    // 1. The hand gets an ARM AND A SOURCE EDGE. A hand stated only as located on somebody
    //    has no route back to a body, so the model attaches it to whichever body is already
    //    drawn — hers. Naming the arm, the edge it enters from, and the proven lens geometry
    //    ("close to the lens and strongly foreshortened", the viewer-body registry's own
    //    wording) gives the limb a viewer-side origin to hang from. Measured 5/5 across the
    //    2026-08-15 verification runs: no phantom, no third arm.
    // 2. HER hands are spent, cheaply. An unplaced pair is an invitation — the run with no
    //    hands clause at all is the one that produced the third arm — but the clause only has
    //    to account for them, and the model already puts them palms-down on the floor when
    //    left alone (3/3). Pinning them where they were going anyway costs a quarter of the
    //    characters, and the budget below is why that matters.
    //
    // The third fix is the ACT's FRAME ANCHOR, and it is the same defect as #1 one part over.
    // Everything in this composition that names where it sits relative to the lens renders
    // every time (the arm from the upper edge, 8/8; the crown of the head, 8/8). The viewer's
    // genitals were the one element with no such anchor: the template stated contact only
    // ("{name}'s mouth on ..."), and because the staging claims `genitals` in `viewerParts`,
    // the viewer-body registry's own near-the-lens line for it is suppressed by design — so
    // nothing in the assembled prompt ever said where that anatomy was. It rendered 2/5.
    // Two attempts at fixing this from HER side both failed: hands on her own thighs (2/5),
    // then hands braced on the viewer's own thighs, which was meant to force the viewer's
    // lower body into frame and instead was ignored outright — 0/3, her palms on the carpet,
    // no viewer below her. Her hands were never the variable. So the anchor goes on the part
    // that lacked one, in the construction this entry has the most evidence for: the arm's
    // "entering frame from the upper edge" mirrored to the opposite edge. It says the same
    // thing the arm clause says — this belongs to a body continuing past the frame edge.
    //
    // The anchor fixed presence, and the residue is a KNOWN, MEASURED limitation rather than
    // a bug to keep poking: the anatomy renders in frame every time and her mouth stops short
    // of it. Anatomy present 3/3, mouth on it 0/3 — with the anatomy pinned to the frame edge
    // and her bow holding her mouth mid-frame, the composition is complete with a visible gap.
    //
    // DO NOT re-try the obvious fix. Replacing "mouth on" with a contact verb ("lips wrapped
    // tight around"), funded by dropping "before the viewer" from the opening clause, was
    // rendered 3 times on 2026-08-15 and LOST the anchor's win: the viewer's anatomy went
    // absent 0/3, contact 0/3. Best read is that lips wrapped around a thing occlude it, and
    // the model resolves that by drawing her mouth closed and the thing not at all — where
    // "mouth on" leaves it exposed and drawable. Two variables moved in that run (the verb
    // and the dropped "before the viewer"), so which one cost the presence is unproven; what
    // is proven is that the pair together is worse than this wording on every axis.
    //
    // Budget: this entry was written AGAINST a 1,500-character prompt ceiling (the retired
    // scene prose builder's self-imposed bound; the assembled edit prompt measured 1491),
    // and every clause here was funded by shortening another one. Longer anchors ("below
    // the camera", "in front of {name}'s face") measured over and cost the setting,
    // lighting and quality tail. The live budget is the binding's — the endpoint's own
    // prompt capability, applied when the program is compiled — and the sentence rides as
    // a required claim, so what a squeeze drops is optional detail around it rather than the
    // act; but a longer template still spends that room. Re-measure on any edit.
    template:
      "{name} kneeling before the viewer with {name}'s head bowed, the crown of {name}'s head toward the camera and {name}'s mouth on the viewer's own genitals rising into frame from the lower edge, {name}'s palms on the floor, the viewer's own arm entering frame from the upper edge, close to the lens and strongly foreshortened, and the viewer's own hand resting flat on top of {name}'s head",
    faceVisibility: "hidden",
    hint: "the same kneeling act, but the viewer's own hand rests on top of her head, guiding — the story must say the hand is on her head.",
    cast: "solo",
  },
  astride_viewer_facing: {
    id: "astride_viewer_facing",
    camera: { orientation: "toward_viewer", distance: "close", height: "low" },
    viewerParts: ["hands", "genitals"],
    requiresBare: ["pelvis"],
    intimate: true,
    template:
      "{name} astride the viewer facing the camera, {name}'s knees either side of the viewer and {name}'s bare pelvis lowered onto the viewer's own genitals in penetration, the viewer's own hands on {name}'s waist",
    hint: "she straddles the viewer facing them, chest to chest, penetration, the viewer's hands on her waist.",
    cast: "solo",
  },
  astride_viewer_away: {
    // Facing away, so the camera says `away` and the face is hidden. The subject's back is
    // NOT described as bare: over-claiming a region in the template would make `requiresBare`
    // demand a bare torso for a shot that only needs a bare pelvis.
    id: "astride_viewer_away",
    camera: { orientation: "away", distance: "close", height: "low" },
    viewerParts: ["hands", "genitals"],
    requiresBare: ["pelvis"],
    intimate: true,
    template:
      "{name} astride the viewer facing away from the camera, {name}'s back and hips filling the frame above the viewer, penetration where {name}'s bare pelvis meets the viewer's own genitals, the viewer's own hands on {name}'s hips",
    hint: "she straddles the viewer facing AWAY, her back to them, penetration, the viewer's hands on her hips.",
    cast: "solo",
  },
  bent_over_surface: {
    id: "bent_over_surface",
    camera: { orientation: "away", distance: "medium", height: "high" },
    viewerParts: ["hands", "genitals"],
    requiresBare: ["pelvis"],
    intimate: true,
    template:
      "{name} bent forward over a waist-high surface with {name}'s back to the camera and {name}'s hips raised toward the viewer, penetration where the viewer's own genitals meet {name}'s bare pelvis from behind, the viewer's own hands entering frame from the lower edge and holding {name}'s hips",
    hint: "she is bent forward over a waist-high surface, back to the viewer, entered from behind while standing.",
    cast: "solo",
  },
  on_all_fours: {
    // Acceptance scene "Doggy style" (owner-specified 2026-08-10). Graded on three visible
    // elements: on all fours, back to the camera with the face away from the lens, and the
    // viewer's own hands on her waist or hips. `viewerParts` carries hands and forearms —
    // the forearms because the template names them, and no anatomy, because the pinned
    // acceptance composition does not put the viewer's anatomy in this frame.
    id: "on_all_fours",
    camera: { orientation: "away", distance: "close", height: "high" },
    viewerParts: ["hands", "forearms"],
    requiresBare: ["pelvis"],
    intimate: true,
    // The frame-edge clause is this entry's load-bearing sentence and it has been beaten
    // twice, each time by the same failure: the hip-hands drawn as HER own, arms reaching
    // back, and the viewer gone from the shot entirely. Probe run 2026-08-14 lost them that
    // way with no edge stated at all; run 2026-08-15b lost them again (0/2) on a LoRA whose
    // priors overpower a bare "entering frame from the lower edge" — while a weaker LoRA
    // held the viewer's hands 2/2 on that same wording. So the wording has to out-shout a
    // prior rather than merely state a fact, and it does that two ways:
    //
    // 1. The FOREARM is named alongside the hand, entering from the lower CORNERS. The
    //    renders that worked showed forearms converging from the lower corners: a hand with
    //    an arm behind it has somewhere to come from, and two limbs entering from opposite
    //    corners is a shape her own arms cannot make. A hand named with no arm gets grafted
    //    onto the nearest body already drawn — hers.
    // 2. HER arms are spent forward. "Palms and knees planted" alone let the pose drift into
    //    an upright kneeling spread with both arms free to reach back; straight arms held
    //    ahead pin the all-fours pose AND leave her no hands to be recruited for the hips.
    //
    // It is written TIGHT because it had to be: this entry's assembled edit prompt sat ~25
    // characters under the 1,500-character ceiling the retired prose builder budgeted to,
    // past which the setting, lighting and quality tail was clamped away. Longer drafts (the
    // knees clause, "close to the lens and strongly foreshortened", "either side of {name}'s
    // hips") each measured over the line and were cut for the two levers above. The live
    // budget is the binding's own prompt capability, applied at compile time, and this
    // sentence rides as a required claim — but the room it spends is real on every endpoint.
    // Re-measure before adding a word.
    template:
      "{name} on all fours with {name}'s arms straight ahead and {name}'s palms planted, {name}'s back to the camera and {name}'s bare hips raised toward the viewer, {name}'s head lowered and facing away from the lens, the viewer's own hands and forearms entering frame from the lower corners onto {name}'s waist and hips",
    hint: "she is on hands and knees on a low surface, back to the viewer, entered from behind — the viewer's hands on her waist or hips.",
    cast: "solo",
  },
  lying_beneath_viewer: {
    // Acceptance scene "Missionary" (owner-specified 2026-08-10). Graded on: on her back
    // facing up at the camera, penetration visible at the bottom frame edge, and the
    // viewer's hands on her legs OR her waist — the template names both, since either hand
    // position passes.
    id: "lying_beneath_viewer",
    camera: { orientation: "toward_viewer", distance: "close", height: "high" },
    viewerParts: ["hands", "genitals"],
    requiresBare: ["pelvis"],
    intimate: true,
    template:
      "{name} on {name}'s back beneath the viewer with {name}'s face turned up toward the camera, the viewer's own genitals entering frame at the bottom edge in penetration with {name}'s bare pelvis, the viewer's own hands holding {name}'s legs and waist",
    hint: "she lies on her back beneath the viewer, facing up, penetration from above.",
    cast: "solo",
  },
  lying_face_down: {
    id: "lying_face_down",
    camera: { orientation: "away", distance: "medium", height: "high" },
    viewerParts: ["hands"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} lying face down along the bed with {name}'s back to the camera and {name}'s head turned to the side against the pillow, the viewer's own hands resting on {name}'s shoulders",
    hint: "she lies face down and still, the viewer's hand on her back — resting or being touched, not an act.",
    cast: "solo",
  },
  spooned_from_behind: {
    id: "spooned_from_behind",
    camera: { orientation: "away", distance: "close", height: "eye_level" },
    viewerParts: ["hands", "forearms"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} lying on {name}'s side with {name}'s back curled against the viewer's chest, the viewer's own arm draped over {name}'s waist and the viewer's own hand resting on {name}'s stomach",
    hint: "both lying on their sides, her back against the viewer's front, the viewer's arm draped over her — dressed, at rest.",
    cast: "solo",
  },
  pressed_to_wall_facing: {
    id: "pressed_to_wall_facing",
    camera: { orientation: "toward_viewer", distance: "close", height: "eye_level" },
    viewerParts: ["hands", "forearms"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} standing with {name}'s back against the wall facing the camera and {name}'s face tilted up toward the viewer, the viewer's own hands braced on the wall either side of {name}'s shoulders",
    hint: "she is against a wall FACING the viewer, who is close in front of her.",
    cast: "solo",
  },
  pressed_to_wall_away: {
    id: "pressed_to_wall_away",
    camera: { orientation: "away", distance: "close", height: "eye_level" },
    viewerParts: ["hands"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} standing facing the wall with {name}'s back to the camera and {name}'s cheek turned against the wall, the viewer's own hands resting on {name}'s shoulders",
    hint: "she is against a wall facing INTO it, her back to the viewer, who is close behind her.",
    cast: "solo",
  },
} satisfies SceneStagingTable<SceneStaging>;

/**
 * The order the catalog is READ in — stated, never inherited.
 *
 * The composer's menu is built by walking this list, so the order is prompt content: it is
 * what a small model reads top to bottom when it picks between thirteen arrangements. Taking
 * that order from the table's key order would make a silent, invisible dependency out of how
 * an object literal happens to be written, and reordering two rows for readability would
 * change what the model sees with nothing to notice it.
 *
 * Totality is pinned by a test rather than by the compiler — an arrangement missing from here
 * is never offered, which is a failure that looks exactly like a model declining to use it.
 */
export const sceneStagingOrder = [
  "held_from_behind",
  "held_from_behind_bare",
  "kneeling_before_viewer",
  "kneeling_before_viewer_guided",
  "astride_viewer_facing",
  "astride_viewer_away",
  "bent_over_surface",
  "on_all_fours",
  "lying_beneath_viewer",
  "lying_face_down",
  "spooned_from_behind",
  "pressed_to_wall_facing",
  "pressed_to_wall_away",
] as const satisfies readonly SceneStagingId[];

/** The catalog as a list, in {@link sceneStagingOrder} — what a menu, a form or a census iterates. */
export const sceneStagingList: readonly SceneStaging[] = sceneStagingOrder.map((id) => sceneStagings[id]);

export function sceneStagingById(id: string): SceneStaging | undefined {
  return isSceneStagingId(id) ? sceneStagings[id] : undefined;
}

// ---------------------------------------------------------------------------
// The measured wording, as an artifact
// ---------------------------------------------------------------------------

/**
 * Each arrangement's sentence, with the provenance that makes a measurement citable.
 *
 * The `text` is the entry's own `template` rather than a copy of it, and that is the whole
 * mechanism: a digest over a copy would prove only that the copy had not moved, leaving a
 * wording edit to the template it was copied from completely unguarded. One artifact, one
 * hash, so `held_from_behind@1` names bytes that are actually in use.
 *
 * `{name}` is left INTACT. The template is the artifact; substituting the subject's name is a
 * separate step at the emission site, and hashing a substituted string would produce a
 * different digest for every character in the cast.
 *
 * The digests are authored here and verified by `scene-staging.test.ts`, which is the one
 * place in the application that runs SHA-256 — a wording edit that forgets to bump the
 * revision fails there rather than quietly redefining what the old revision meant.
 */
export const sceneStagingSurfaceFormTable = {
  held_from_behind: {
    text: sceneStagings.held_from_behind.template,
    revision: 1,
    digest: "e954404cfcce2cdeaa0737c50fb487d4a2c996b78307da51257b2818edc46ceb",
  },
  held_from_behind_bare: {
    text: sceneStagings.held_from_behind_bare.template,
    revision: 1,
    digest: "6a868ee7d30b77e60aca6c5c0dafb5df132a5420e6c4dc8b33e0b7344ba76068",
  },
  kneeling_before_viewer: {
    text: sceneStagings.kneeling_before_viewer.template,
    revision: 1,
    digest: "dcb0c21e9826606b704745f856bffeec173c377b93ac5724e0eb36d1887f53ff",
  },
  kneeling_before_viewer_guided: {
    text: sceneStagings.kneeling_before_viewer_guided.template,
    revision: 1,
    digest: "723e8a49e7356c5360db8182c624a35f6067530d44d575073ccf1c12176aec95",
  },
  astride_viewer_facing: {
    text: sceneStagings.astride_viewer_facing.template,
    revision: 1,
    digest: "06a751ad09ad50233be551fa045163b6b9b773ca80ff5ec869a5f82815628899",
  },
  astride_viewer_away: {
    text: sceneStagings.astride_viewer_away.template,
    revision: 1,
    digest: "c236e982ec293a6965b6d9d79651833462013ea43f8875e9ffe67500cbe0b1b3",
  },
  bent_over_surface: {
    text: sceneStagings.bent_over_surface.template,
    revision: 1,
    digest: "33feef7aeb628765cc1fdeb9085e46a128baf26c762ba6d390c8ed0170c6a762",
  },
  on_all_fours: {
    text: sceneStagings.on_all_fours.template,
    revision: 1,
    digest: "d3f2f60b7d66a587a6f270dbbec9c4167a058d703b1b1fe6a069f03cb2d167e4",
  },
  lying_beneath_viewer: {
    text: sceneStagings.lying_beneath_viewer.template,
    revision: 1,
    digest: "8144f5704ff8538e805fe46e7ded68bce88721bacdc097284adb799e079bebe8",
  },
  lying_face_down: {
    text: sceneStagings.lying_face_down.template,
    revision: 1,
    digest: "be6218c3fdb15f453825d9027c5162df4542d61edffbdbb2f23b41b74af78a74",
  },
  spooned_from_behind: {
    text: sceneStagings.spooned_from_behind.template,
    revision: 1,
    digest: "3178a4755a7e3f2f71783deca9fe0e21c18a2584b7e4ae4777cbe841f4d192b2",
  },
  pressed_to_wall_facing: {
    text: sceneStagings.pressed_to_wall_facing.template,
    revision: 1,
    digest: "18d42a732433811a0bdaec2eee54ea9d2a93c3531b1bede30a37fccfaff7466a",
  },
  pressed_to_wall_away: {
    text: sceneStagings.pressed_to_wall_away.template,
    revision: 1,
    digest: "f7514817593a4601186328b37082cec452d5dbc7ba409ef8b8de95b8743aca6f",
  },
} satisfies SceneStagingSurfaceFormTable;

/**
 * The one way a dialect reaches this registry's wording.
 *
 * Closing the table is what makes the text unreadable everywhere else: past this line the
 * sentence has no public name, so a dialect either adopts it at a visible call site or words
 * the arrangement itself, and which one it did is answerable by looking.
 */
export const sceneStagingSurfaceForms: SceneStagingSurfaceForms =
  createSceneStagingSurfaceForms(sceneStagingSurfaceFormTable);

// ---------------------------------------------------------------------------
// Contact as staging evidence
// ---------------------------------------------------------------------------

/**
 * The minimum a committed contact has to say for this table to read it: which surface acted,
 * which surface it met, and **which side is the player**. Direction is load-bearing — the
 * viewer's hands on the subject's hips and the subject's hands on the viewer's hips are two
 * different shots — so a pair without it could never ground a geometry.
 *
 * Deliberately a projection of `CommittedContactRead` rather than the record itself: this
 * table needs three facts, and taking the whole contact would tie the camera vocabulary to
 * the contact core's lifecycle shape for no gain. Body-to-body only — a hand braced on a
 * wall is a real contact and says nothing about how two bodies are arranged, so it never
 * becomes one of these.
 */
export interface SceneContactPairRead {
  /** `bodyLocationRegistry` id of the acting surface (the contact's `source`). */
  sourceLocationId: string;
  /** `bodyLocationRegistry` id of the touched surface. */
  targetLocationId: string;
  /** True when the acting body is the player's — the viewer is doing the touching. */
  sourceIsPlayer: boolean;
}

/** One row: this contact pair, in this direction, grounds this staging's geometry. */
export interface SceneStagingContactEvidenceRow {
  stagingId: SceneStagingId;
  sourceLocationId: string;
  targetLocationId: string;
  sourceIsPlayer: boolean;
}

/**
 * Committed contact that can stand in for a narration quote — **empty today, and typed so
 * the first honest row is a one-line data edit.**
 *
 * The spec allows an active contact on the focal pair to satisfy a staging's evidence
 * requirement when its location pair matches the staging's geometry, and says the table
 * "starts tiny (only unambiguous pairs)". Applied to the vocabulary that actually exists,
 * "only unambiguous pairs" comes out empty, and that is the finding rather than an omission:
 * the chat contact lane commits **affectionate touch only** — a hand (`hands`) meeting
 * `shoulders`, `upper_arms`, `arms`, `forearms`, `hands`, `back`, `head`, or `hair`
 * (`turns/chat-contact-vocabulary.ts`) — and every one of those pairs is consistent with
 * several stagings and with no staging at all. A hand on the back belongs to a face-to-face
 * embrace as readily as to a hold from behind; a hand on the head is as much a head-pat as
 * it is `kneeling_before_viewer_guided`. Writing either row would spend a provenance-carrying
 * fact on a guess, which is exactly what the propose-then-verify architecture exists to stop.
 *
 * What would populate it is the pairs the affectionate lexicon deliberately excludes — waist
 * and hips as targets of the viewer's hands, which are the unambiguous half of
 * `on_all_fours` and `bent_over_surface`. When an intimate contact domain commits those,
 * each becomes one row here and nothing else changes.
 */
export const sceneStagingContactEvidence: readonly SceneStagingContactEvidenceRow[] = [];

/**
 * Does any active contact on the focal pair ground this staging?
 *
 * The resolver's read of the table above: `true` means a provenance-carrying fact already
 * says the bodies are arranged this way, so the staging needs no narration quote. Because
 * the table is empty today this answers `false` for everything, which is the correct
 * degradation — every staging still has to earn its place with a verbatim quote.
 */
export function stagingEvidenceFromContacts(
  contacts: readonly SceneContactPairRead[],
  stagingId: string,
): boolean {
  return sceneStagingContactEvidence.some(
    (row) =>
      row.stagingId === stagingId &&
      contacts.some(
        (contact) =>
          contact.sourceLocationId === row.sourceLocationId &&
          contact.targetLocationId === row.targetLocationId &&
          contact.sourceIsPlayer === row.sourceIsPlayer,
      ),
  );
}
