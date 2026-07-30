import { diag, type DiagnosticSink } from "../diagnostics";
import { isMinorAge } from "../world/life-stage";
import { adultEligibilityDeclarationSchema, type AdultEligibilityDeclaration } from "./declaration";

/**
 * The adult-eligibility resolver law (adult-eligibility.spec.md §"Resolver law").
 *
 * Pure, total, and deliberately **starved of inputs**: a declaration and a free-text
 * age, nothing else. The narrow signature is the enforcement of the rule that
 * `identity.apparent_age` — a visual, model-generatable, default-fillable value the
 * portrait studio reads — is never eligibility evidence. It cannot be passed in, so it
 * cannot be consulted, so no future edit can quietly start consulting it.
 *
 * The law, clause by clause:
 *
 * 1. Declared `adult`, no known numeric-minor conflict ⇒ `eligible`.
 * 2. Declared `minor`, or a numeric age below {@link ADULT_ELIGIBILITY_MIN_YEARS} ⇒ `ineligible`.
 * 3. Missing, malformed, or declared `unresolved` ⇒ `unresolved`.
 * 4. A parseable ADULT numeric age without a declaration stays `unresolved` — age alone
 *    is never positive proof. This is the whole point of the feature: the fence that
 *    reads "" / "ancient" / "312" as adult is negative and fails open.
 * 5. Attributes are not an input (see above).
 * 6. A stored contradiction — declared `adult` on a numeric-minor record — fails
 *    **closed** with an `error` diagnostic. Authoring rejects that combination up front
 *    ({@link adultEligibilityConflict}), so reaching it here means the row was corrupted
 *    or written around the API; the declaration never overrides the numeric fence.
 *
 * `isMinorAge` / `lifeStageForAge` are **read, never modified** — the repo-wide
 * fail-open fallback stays exactly as it is (owner ruling 2026-07-30).
 */

/** Adulthood in years, for the numeric half of the law. */
export const ADULT_ELIGIBILITY_MIN_YEARS = 18;

export const adultEligibilityResults = ["eligible", "ineligible", "unresolved"] as const;
export type AdultEligibilityResult = (typeof adultEligibilityResults)[number];

/** Diagnostic code for a stored declaration that contradicts the numeric age. */
export const ADULT_ELIGIBILITY_CONFLICT_CODE = "eligibility.declaration_conflicts_age";

/** Why an authoring attempt was rejected. A closed vocabulary; one member today. */
export const adultEligibilityConflicts = ["declared_adult_numeric_minor"] as const;
export type AdultEligibilityConflict = (typeof adultEligibilityConflicts)[number];

/**
 * The two inputs, and only the two.
 *
 * Field names match the stored profiles exactly, so a `CharacterProfile` or a
 * `PersonaProfile` is structurally an input — no mapper, no chance of a call site
 * mapping it wrong and getting a silent `unresolved`. The persona has no `age`, which
 * is why it is optional rather than required-and-blank.
 *
 * `adultEligibilityDeclaration` is `unknown` on purpose: this is a trust boundary —
 * lanes hand in whatever a JSONB row held — and the schema's `.catch` turns anything
 * unrecognized into `unresolved` rather than throwing or, worse, guessing `adult`.
 */
export interface AdultEligibilityInput {
  /** The stored declaration. Missing/malformed reads `unresolved`. */
  readonly adultEligibilityDeclaration?: unknown;
  /** The authored free-text age. Absent on a persona, which has no age field. */
  readonly age?: string;
}

/**
 * Whether a free-text age is a KNOWN numeric minor, reconciled in the stricter
 * direction (adult-eligibility.spec.md §"Numeric-minor derivation").
 *
 * `isMinorAge` is the repo's existing derivation and is authoritative wherever it
 * answers `true`: its bands (child 0–12, teen 13–17) are exactly "below 18" for a bare
 * numeral within the human scale. It answers `false` for shapes it declines to parse —
 * `"17.5"`, `"-5"` — where a literal "below 18" reading says minor. For an
 * `ineligible` verdict the stricter answer wins, so those are caught here. Nothing in
 * this function can make a record LESS restricted than `isMinorAge` already makes it.
 */
export function isNumericMinorAge(age: string): boolean {
  if (isMinorAge(age)) return true;
  const trimmed = age.trim();
  if (!/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return false;
  const years = Number.parseFloat(trimmed);
  return Number.isFinite(years) && years < ADULT_ELIGIBILITY_MIN_YEARS;
}

/** Normalize a stored value to the vocabulary. Missing/malformed ⇒ `unresolved`. */
export function readAdultEligibilityDeclaration(raw: unknown): AdultEligibilityDeclaration {
  return adultEligibilityDeclarationSchema.parse(raw ?? undefined);
}

/**
 * Validation-time contradiction check for the AUTHORING surfaces (the character
 * create/update boundary). Returns the conflict code, or `null` when the pair is
 * coherent.
 *
 * Only one direction is a conflict. Declaring `minor` on a numeric-adult record is
 * always allowed — it is the stricter statement, and an author who says "this
 * participant is a minor" is never overruled by a number.
 */
export function adultEligibilityConflict(input: AdultEligibilityInput): AdultEligibilityConflict | null {
  const declaration = readAdultEligibilityDeclaration(input.adultEligibilityDeclaration);
  return declaration === "adult" && isNumericMinorAge(input.age ?? "") ? "declared_adult_numeric_minor" : null;
}

/**
 * Apply the law. Pure; the sink only records the clause-6 corruption case.
 *
 * `path` names the record for the diagnostic ("characters.profile", a chat
 * participant id) so a fail-closed romantic attempt is traceable to a row.
 */
export function resolveAdultEligibility(
  input: AdultEligibilityInput,
  sink?: DiagnosticSink,
  path?: string,
): AdultEligibilityResult {
  const declaration = readAdultEligibilityDeclaration(input.adultEligibilityDeclaration);
  const numericMinor = isNumericMinorAge(input.age ?? "");

  // Clause 6 — a contradiction that authoring rejects; stored, it fails closed.
  if (declaration === "adult" && numericMinor) {
    sink?.push(
      diag("error", ADULT_ELIGIBILITY_CONFLICT_CODE, "declared adult on a record whose numeric age reads as a minor", {
        ...(path === undefined ? {} : { path }),
        context: { age: input.age ?? "" },
      }),
    );
    return "ineligible";
  }
  // Clause 2 — declared minor, or a known numeric minor.
  if (declaration === "minor" || numericMinor) return "ineligible";
  // Clause 1 — the only route to a positive answer.
  if (declaration === "adult") return "eligible";
  // Clauses 3 and 4 — including a perfectly parseable adult age with no declaration.
  return "unresolved";
}
