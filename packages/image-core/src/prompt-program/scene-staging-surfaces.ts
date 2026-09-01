import {
  adoptSceneStagingSurfaceForm,
  type SceneStagingId,
  type SceneStagingSurfaceDisposition,
  type SceneStagingSurfaceForm,
} from "../scene-ir";

/**
 * Where a dialect says what it did with an arrangement's measured wording.
 *
 * The registry's staging templates are measured artifacts: a revision names a specific
 * string, and the render evidence behind that revision is only a fact about renders that
 * actually contained it. So a record saying `on_all_fours@3` and nothing else misleads
 * exactly half the time — on every endpoint whose dialect worded the arrangement itself.
 * This is the channel that carries the missing half from the point of decision to the
 * program's provenance.
 *
 * ## Why the decision is reported rather than derived
 *
 * Two cheaper-looking sources were rejected, both because they answer a different question
 * than the one provenance asks:
 *
 * - **Comparing the emitted sentence to the surface text.** Adoption is not string equality.
 *   Every adopting dialect binds `{name}`, capitalises and terminates, so the emitted bytes
 *   differ from the template by construction — and a dialect that authored a near-identical
 *   rival sentence would read as adoption. The comparison would be wrong in both directions.
 * - **A static per-dialect declaration.** It is true today that each family decides once for
 *   the whole vocabulary, but a declaration is a second statement of a decision the wording
 *   arm already makes, and nothing keeps the two in step: editing the arm to write its own
 *   sentence leaves a field still saying `adopted`, and the record becomes confidently false.
 *   A per-render channel also has to exist regardless — whether a staging claim carried a
 *   form and whether it survived fitting are both per-render facts.
 *
 * Recording at the decision site is what makes the record structurally honest: the same
 * expression that takes the wording is the one that says it was taken.
 *
 * ## Why adoption goes through here
 *
 * {@link adoptSceneStagingSurfaceForm} is the only read of the measured text there is, and
 * this log is its only caller inside the compiler. Reading and recording are therefore one
 * act, so a dialect cannot use the measured bytes without the record saying so. Replacement
 * has no such natural chokepoint — a dialect that words the arrangement itself needs only the
 * arrangement's id — so {@link SceneStagingSurfaceLog.replace} hands that id back, making the
 * declaration the natural way to spell the call rather than an extra line to remember. What
 * catches a dialect that skips it anyway is the unrecorded-decision report in
 * `compileDialectClaims`: a staging sentence in a prompt with no disposition beside it reads
 * as "no arrangement" rather than "unknown", which is the misreading this whole channel
 * exists to prevent.
 *
 * PURE. Per-compile state, created fresh by each `compilePositive` and never shared.
 */

/** One arrangement's wording decision, before the compile knows whether the claim survived. */
export interface SceneStagingSurfaceDecision {
  /** The claim the decision was made for — how a survivor is told from a casualty. */
  readonly claimId: string;
  readonly form: SceneStagingSurfaceForm;
  readonly disposition: SceneStagingSurfaceDisposition;
}

/**
 * The recorder a dialect words a staging through.
 *
 * Keyed by claim, so one claim can never carry two dispositions however a dialect is
 * written. A dialect that changes its mind mid-arm overwrites: the last decision taken before
 * the segment is returned is the one that segment reflects, and an earlier, abandoned one
 * would describe a sentence nobody sent.
 */
export interface SceneStagingSurfaceLog {
  /**
   * Take the registry's measured wording for this arrangement, recording that these exact
   * bytes are what the provider was sent.
   */
  adopt(claimId: string, form: SceneStagingSurfaceForm): string;
  /**
   * Word the arrangement in this dialect instead, recording that the measured bytes did not
   * travel. Returns the arrangement to word.
   */
  replace(claimId: string, form: SceneStagingSurfaceForm): SceneStagingId;
  /** Every decision taken, in the order the claims were rendered. */
  decisions(): readonly SceneStagingSurfaceDecision[];
  /**
   * Whether this claim's dialect said where its wording came from.
   *
   * The compile asks before admitting a staging segment: a rendered arrangement with no
   * disposition beside it is indistinguishable in provenance from one whose measured bytes
   * were sent, so it is dropped rather than published.
   */
  decided(claimId: string): boolean;
}

export function createSceneStagingSurfaceLog(): SceneStagingSurfaceLog {
  const byClaim = new Map<string, SceneStagingSurfaceDecision>();
  const record = (
    claimId: string,
    form: SceneStagingSurfaceForm,
    disposition: SceneStagingSurfaceDisposition,
  ): void => {
    byClaim.set(claimId, { claimId, form, disposition });
  };
  return {
    adopt(claimId, form) {
      record(claimId, form, "adopted");
      return adoptSceneStagingSurfaceForm(form);
    },
    replace(claimId, form) {
      record(claimId, form, "replaced");
      return form.stagingId;
    },
    decisions() {
      return [...byClaim.values()];
    },
    decided(claimId) {
      return byClaim.has(claimId);
    },
  };
}
