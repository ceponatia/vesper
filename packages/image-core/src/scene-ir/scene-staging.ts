import { z } from "zod";
import {
  sceneCameraSpecSchema,
  sceneExposureRegionIdSchema,
  sceneFaceVisibilitySchema,
  sceneViewerBodyPartIdSchema,
} from "./scene-vocabulary";

/**
 * Staging — one stageable arrangement of two bodies, as an instruction the compiler reads.
 *
 * The application's staging registry decides WHICH arrangement a scene is in: it owns
 * selection, the evidence a claim must earn, the camera override, the route and coverage
 * gates, and every explicit word. What it cannot do is reach into a dialect, because the
 * compiler depends on nothing above it. So the closed id set and the typed facts behind each
 * id live here, where the registry that resolves a staging and the dialect that words one can
 * both see them. The compiler owns the opcode; the application owns the logic that emits it.
 *
 * Two things deliberately do NOT cross. The registry's per-id template is not mirrored here
 * — see {@link SceneStagingSurfaceForm} for the one narrow channel it travels through — and
 * neither is the composer-facing recognition hint, which never reaches an image at all.
 *
 * PURE data and types.
 */

// ---------------------------------------------------------------------------
// The closed staging vocabulary
// ---------------------------------------------------------------------------

/**
 * Every arrangement Vesper can stage, and the whole of what an id is allowed to be.
 *
 * Closed because a staging is chosen by a small model from a menu and then gated by code:
 * an unknown id has to be rejectable, and a rejectable id has to be a member of something.
 * Adding an arrangement is an entry here plus the registry data behind it plus a wording
 * decision per dialect family — the cost is the point, since it is what stops an
 * arrangement from being half-supported on four endpoints.
 *
 * Every member describes a two-body geometry between the subject and the viewer. Variants
 * that differ by one physical fact are separate members rather than flags on one, because a
 * clothed hold and a bare hold are two arrangements, not one arrangement with a switch.
 */
export const sceneStagingIds = [
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
] as const;

export const sceneStagingIdSchema = z.enum(sceneStagingIds);

export type SceneStagingId = (typeof sceneStagingIds)[number];

const stagingIdSet: ReadonlySet<string> = new Set<string>(sceneStagingIds);

/** Whether an arbitrary string names a staging. The membership check a boundary reads with. */
export function isSceneStagingId(value: string): value is SceneStagingId {
  return stagingIdSet.has(value);
}

// ---------------------------------------------------------------------------
// Cast shape
// ---------------------------------------------------------------------------

/**
 * How many present characters an arrangement can honestly hold.
 *
 * `solo` is a statement about the arrangement, not a placeholder: a geometry written between
 * one subject and the viewer becomes a lie about who is where the moment a second person is
 * standing in the room. A multi-character arrangement is its own member of
 * {@link sceneStagingIds} with its own geometry, never a relaxed flag on a solo one.
 *
 * The roster gate itself runs in the application, which is the only side that knows who is
 * present; this is the datum that gate reads.
 */
export const sceneStagingCasts = ["solo", "multi"] as const;

export const sceneStagingCastSchema = z.enum(sceneStagingCasts);

export type SceneStagingCast = (typeof sceneStagingCasts)[number];

// ---------------------------------------------------------------------------
// Provider-neutral semantics
// ---------------------------------------------------------------------------

/**
 * What an arrangement IS, in facts rather than in English.
 *
 * Everything here is decidable without reading a sentence, which is the test for membership:
 * a compiler can check a cast size, apply an identity lock against a face-visibility answer,
 * or notice that two claims disagree about where the camera is. It could do none of that
 * with prose. The registry's tuned wording is not a field of this type — a resolved staging
 * may carry one alongside, as a {@link SceneStagingSurfaceForm}, and the two stay separate
 * so that a consumer can have the semantics without the prose.
 */
export const sceneStagingSemanticsSchema = z.object({
  id: sceneStagingIdSchema,
  /**
   * The shot the arrangement entails. It **replaces** any proposed camera rather than
   * merging with one: the geometry follows from the act, so an arrangement that survived its
   * own evidence gate has already decided where the lens is.
   */
  camera: sceneCameraSpecSchema,
  /**
   * The viewer's own parts the arrangement puts in frame — a gate list, still checked
   * against the route's permissions and the player's coverage before anything renders.
   */
  viewerParts: z.array(sceneViewerBodyPartIdSchema).readonly(),
  /** Regions of the SUBJECT that must read bare for the arrangement to be truthful; empty ⇒ clothed-capable. */
  requiresBare: z.array(sceneExposureRegionIdSchema).readonly(),
  /** Whether the arrangement may only travel a route that permits intimate detail. */
  intimate: z.boolean(),
  /**
   * Overrides what the camera orientation alone would imply. Present only when the body's
   * angle hides a face the orientation says is toward the lens — a shot onto the crown of a
   * head is the case that makes this a field rather than a derivation.
   */
  faceVisibility: sceneFaceVisibilitySchema.optional(),
  cast: sceneStagingCastSchema,
});

export type SceneStagingSemantics = z.infer<typeof sceneStagingSemanticsSchema>;

/**
 * A registry keyed by arrangement — the shape that makes drift a compile error.
 *
 * The application's own definition adds the fields this side has no business seeing (the
 * tuned template, the composer's recognition hint) and writes its table
 * `satisfies SceneStagingTable<AppStagingDefinition>`. Extending {@link sceneStagingIds}
 * then fails the application's registry until it says what the new arrangement means, which
 * is the whole of the drift protection on this seam: no parity test and no second
 * declaration of the id list, either of which would let the two sides agree in shape while
 * disagreeing about what exists.
 *
 * The key is pinned to the entry's own `id`, so a row filed under the wrong key does not
 * compile either.
 */
export type SceneStagingTable<T extends SceneStagingSemantics = SceneStagingSemantics> = {
  readonly [K in SceneStagingId]: T & { readonly id: K };
};

// ---------------------------------------------------------------------------
// The registry-owned surface form
// ---------------------------------------------------------------------------

/**
 * Which revision of an arrangement's wording a surface form carries — `on_all_fours@3`.
 *
 * The identity a measurement record cites and the one people say out loud. A surface form
 * always carries one, because a measurement is only ever a fact about a specific string: a
 * template whose anatomy rendered in every probe and one that lost it differ by a clause.
 *
 * A change to the exact registry-owned string always bumps the revision, even when the
 * phrasings are believed equivalent. Re-running a measurement against a different model does
 * not — that is a new measurement record against the same artifact.
 *
 * The shape is composed rather than authored, so a revision can never disagree with the
 * arrangement it names. A revision recovered from storage is an ordinary `string`, because a
 * stored value is untrusted until something checks it.
 */
export type SceneStagingSurfaceRevision = `${SceneStagingId}@${number}`;

/** The one way to spell a revision. Takes an arrangement and a number, never a caller's string. */
export function sceneStagingSurfaceRevision(
  stagingId: SceneStagingId,
  revision: number,
): SceneStagingSurfaceRevision {
  return `${stagingId}@${revision}`;
}

/**
 * The proof of which exact bytes a revision meant: SHA-256 of the wording's UTF-8 encoding,
 * lowercase hex.
 *
 * A readable revision alone is not enough. `@3` is a name, and a name can be made to point
 * somewhere else: editing the text and its expected hash in one commit leaves every
 * content-hash test green while destroying what `@3` historically meant. The digest is what
 * a later reader compares a render's recorded value against to say plainly that the registry
 * has moved underneath a revision it still calls by the same name.
 *
 * **Authored data, verified by a test — never computed at run time.** This package is
 * browser-portable and may not pull in `node:crypto`, so the hash is supplied from outside;
 * {@link findSceneStagingSurfaceDigestMismatches} is where a test hands one in. The FNV-1a
 * helper in `@vesper/contracts` is deterministic bucketing and is not a content identity.
 */
export type SceneStagingSurfaceDigest = string;

/** Lowercase hex SHA-256. The shape a digest has wherever one is read back rather than authored. */
export const sceneStagingSurfaceDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The private key the measured text sits behind.
 *
 * Not exported, and that is the whole mechanism: outside this module the property has no
 * name, so no object literal can carry one and no consumer can read one. The two named
 * functions below are the only door in and the only door out.
 */
const SURFACE_TEXT: unique symbol = Symbol("vesper.scene.staging.surface_text");

/**
 * A sentence a registry authored for one arrangement, with the provenance needed to reason
 * about it.
 *
 * ## Why a registry sentence crosses the seam at all
 *
 * Wording normally belongs to a dialect, and staging is the exception, on evidence. These
 * templates were tuned against renders and the tuning is recorded in measurements, not
 * opinions: one rewrite that replaced a contact verb took the viewer's anatomy from present
 * in three renders of three to absent in three of three; naming a forearm and the frame's
 * lower corners held the viewer's hands in two renders of two where a plainer phrasing lost
 * them in both; one template's assembled prompt measures nine characters under its ceiling.
 * A minority of each template's characters carries nearly all of that delta, and what they
 * encode is model behavior rather than scene meaning — so it cannot be re-derived from
 * {@link SceneStagingSemantics} by any dialect, however good. Discarding it would discard
 * the measurements with it.
 *
 * ## Why this is not a prose escape hatch
 *
 * The distinction is structural rather than a matter of discipline:
 *
 * - **A caller cannot supply a string.** Nothing in this API takes prose from a call site.
 *   A form is reachable only through {@link createSceneStagingSurfaceForms}, whose input is
 *   a table **total over {@link sceneStagingIds}** — authoring one is authoring a registry,
 *   not passing an argument, and it can neither omit an arrangement nor invent one.
 * - **The text has no public name.** It sits behind a module-private symbol, so the only way
 *   to read it is {@link adoptSceneStagingSurfaceForm} — which means every dialect that uses
 *   the registry's wording says so at a call site, and every dialect that replaces it is
 *   equally visible by having no such call. Neither is a silent default.
 * - **There is no schema for this type, deliberately.** A parser would be a second door,
 *   and one that opens on untrusted JSON. For the same reason the text does not survive
 *   `JSON.stringify` — what a persisted claim or a program fingerprint records is the
 *   revision and the digest, which are exactly what a re-measurement is keyed to.
 *
 * What remains reachable to a determined caller is a deliberate double type assertion, which
 * no type system prevents and which is a visible, greppable lie rather than an ordinary use
 * of the API.
 *
 * The claim this rides on keeps its concept, channel, segment kind, conflict keys and
 * priority — those belong to the compiler, not here. That is the entire difference between
 * this and an untyped prose channel: a claim carrying a surface form is still ordered, still
 * protected, still fitted, and still traceable to the arrangement it came from.
 */
export interface SceneStagingSurfaceForm {
  /** The arrangement this wording is for — closed, so a form can never float free of one. */
  readonly stagingId: SceneStagingId;
  /** The wording revision the measurements apply to. */
  readonly revision: SceneStagingSurfaceRevision;
  /** Which bytes that revision means. Readable without reading the text, which is the point. */
  readonly digest: SceneStagingSurfaceDigest;
  readonly [SURFACE_TEXT]: string;
}

/**
 * One row of a surface-form table, as the registry authors it.
 *
 * `text` is public here and nowhere downstream. This type exists at the authoring site — the
 * module that wrote the sentence in the first place — and {@link createSceneStagingSurfaceForms}
 * is a one-way door: what a claim, a dialect or a compiler ever holds is a
 * {@link SceneStagingSurfaceForm}, which has no readable text on it.
 */
export interface SceneStagingSurfaceFormEntry {
  /** The registry's tuned sentence for this arrangement. */
  readonly text: string;
  /** The revision NUMBER, bumped by any change to {@link text}. The citable form is composed from it. */
  readonly revision: number;
  /** SHA-256 of {@link text}, authored here and proved by a test. */
  readonly digest: SceneStagingSurfaceDigest;
}

/**
 * A complete surface-form table — every arrangement, no exceptions.
 *
 * Totality is a load-bearing property twice over. It makes {@link SceneStagingSurfaceForms}
 * a total function, so a lookup never degrades and no consumer needs a missing-wording
 * branch; and it makes authoring one an act of writing a registry rather than of passing a
 * string, which is what keeps arbitrary prose out. A new member of {@link sceneStagingIds}
 * breaks every table that has not answered for it.
 */
export type SceneStagingSurfaceFormTable = Readonly<Record<SceneStagingId, SceneStagingSurfaceFormEntry>>;

/** The lookup a resolved staging reads its wording through. Total over {@link sceneStagingIds}. */
export interface SceneStagingSurfaceForms {
  /** The form for an arrangement. Compared by `stagingId`, `revision` and `digest`; never by identity. */
  formFor(id: SceneStagingId): SceneStagingSurfaceForm;
  /** The revision alone, for provenance that has no business reading the text. */
  revisionFor(id: SceneStagingId): SceneStagingSurfaceRevision;
  /** The digest alone, for the same reason. */
  digestFor(id: SceneStagingId): SceneStagingSurfaceDigest;
}

/**
 * Close a registry's table into the only source of surface forms there is.
 *
 * The table is code, so it is not parsed: `parseOr` belongs at a trust boundary, and a
 * registry authored in TypeScript is the opposite of one. What guards this input is the
 * compiler — a table missing an arrangement, or naming one that does not exist, does not
 * build.
 */
export function createSceneStagingSurfaceForms(table: SceneStagingSurfaceFormTable): SceneStagingSurfaceForms {
  return {
    formFor(id) {
      const entry = table[id];
      return {
        stagingId: id,
        revision: sceneStagingSurfaceRevision(id, entry.revision),
        digest: entry.digest,
        [SURFACE_TEXT]: entry.text,
      };
    },
    revisionFor(id) {
      return sceneStagingSurfaceRevision(id, table[id].revision);
    },
    digestFor(id) {
      return table[id].digest;
    },
  };
}

/**
 * Take the registry's wording for this arrangement.
 *
 * The only read of the measured text there is, and calling it IS a dialect's decision to
 * adopt rather than author. A dialect that words the arrangement itself simply never calls
 * this, so which endpoints kept the measured phrasing is answerable by looking, not by
 * asking. Whichever it does, it records the choice — see `SceneStagingSurfaceDisposition`.
 */
export function adoptSceneStagingSurfaceForm(form: SceneStagingSurfaceForm): string {
  return form[SURFACE_TEXT];
}

// ---------------------------------------------------------------------------
// Digest verification
// ---------------------------------------------------------------------------

/** One row whose authored digest does not describe its text. */
export interface SceneStagingSurfaceDigestMismatch {
  readonly stagingId: SceneStagingId;
  readonly revision: SceneStagingSurfaceRevision;
  /** What the registry claims the bytes hash to. */
  readonly declared: SceneStagingSurfaceDigest;
  /** What they actually hash to. */
  readonly actual: string;
}

/**
 * Check a registry's authored digests against its own text.
 *
 * The hash arrives as an argument because this package is browser-portable and may not
 * evaluate `node:crypto`; the caller is a test, which is free to. That inversion is also
 * what keeps the rule executable rather than a comment: **the digest is SHA-256 over the
 * UTF-8 bytes of `text` and nothing else** — not the revision, not the id, not a
 * concatenation — and this function is where that sentence is defined.
 *
 * Returns every mismatch rather than the first, so one run names all the rows a wording edit
 * forgot to re-digest.
 */
export function findSceneStagingSurfaceDigestMismatches(
  table: SceneStagingSurfaceFormTable,
  sha256Hex: (text: string) => string,
): readonly SceneStagingSurfaceDigestMismatch[] {
  const mismatches: SceneStagingSurfaceDigestMismatch[] = [];
  for (const stagingId of sceneStagingIds) {
    const entry = table[stagingId];
    const actual = sha256Hex(entry.text);
    if (actual === entry.digest) continue;
    mismatches.push({
      stagingId,
      revision: sceneStagingSurfaceRevision(stagingId, entry.revision),
      declared: entry.digest,
      actual,
    });
  }
  return mismatches;
}
