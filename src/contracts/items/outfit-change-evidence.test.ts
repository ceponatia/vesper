import { describe, expect, it } from "vitest";
import { classifyOutfitChangeQuote, type OutfitChangeRejection } from "./outfit-change-evidence";

/**
 * The classifier's regression matrix. Every row is a QUOTE the archivist could
 * lift verbatim out of an exchange — grounding is the caller's half of the gate
 * (`outfitChangeEvidenceValidated`), so these rows ask only "do these words say
 * the clothes moved?".
 *
 * The module's contract takes NORMALIZED text (the caller lowercases and
 * collapses whitespace), so the tables feed it through `lower` rather than
 * restating the normalizer.
 *
 * Precision-biased: an accept wipes a modelled wardrobe, a reject keeps it. So
 * the reject table is the long one, and it holds the shapes that a plain
 * verb-pattern match got wrong — non-events that name a wardrobe verb, and
 * idioms whose object is not a garment at all.
 */

const lower = (quote: string): string => quote.toLowerCase();

interface RejectRow {
  readonly quote: string;
  /** Asserted only where the reason is stable — every row asserts the rejection itself. */
  readonly reason?: OutfitChangeRejection;
}

const REJECTS: readonly RejectRow[] = [
  // Negation — the act explicitly did not happen.
  { quote: "She doesn't take off her jacket.", reason: "negated" },
  { quote: "She never takes off her jacket.", reason: "negated" },
  { quote: "She sits down without taking off her coat.", reason: "negated" },
  { quote: "She refuses to take off her jacket.", reason: "refusal" },
  // Modality and intent — it may happen, or someone wants it to.
  { quote: "She might pull on a coat later.", reason: "modal" },
  { quote: "She could change into a dress.", reason: "modal" },
  { quote: "She should probably put on a sweater.", reason: "modal" },
  { quote: "She wants to slip into something more comfortable.", reason: "modal" },
  { quote: "She plans to take off her jacket.", reason: "modal" },
  { quote: "She is about to pull on her boots.", reason: "modal" },
  { quote: "She is going to change into her work clothes.", reason: "modal" },
  { quote: "She thinks about changing into something warmer.", reason: "modal" },
  // Started, not finished.
  { quote: "She almost takes off her jacket.", reason: "incomplete" },
  { quote: "She starts to take off her jacket, then stops.", reason: "incomplete" },
  // Conditioned on something that has not happened.
  { quote: "If she takes off her jacket, she will be cold.", reason: "conditional" },
  { quote: "Unless you put on a coat, you will freeze.", reason: "conditional" },
  // Asked, not reported.
  { quote: "Does she take off her jacket?", reason: "question" },
  { quote: "Should I take off my shoes?", reason: "question" },
  // Ordered, not done — quoted dialogue and the reported form.
  { quote: '"Take off your jacket," she says.', reason: "quoted" },
  { quote: "She tells him to take off his jacket.", reason: "command" },
  { quote: "She asks you to put on the apron.", reason: "command" },
  // Imagined or habitual, never this exchange's event.
  { quote: "Imagine her slipping into a red evening dress.", reason: "hypothetical" },
  { quote: "In the dream she steps into a wedding gown.", reason: "hypothetical" },
  { quote: "Last winter she pulled on that same coat every morning.", reason: "habitual" },
  // Idioms: a wardrobe verb whose object is not a garment.
  { quote: "He takes off for work.", reason: "no_garment_object" },
  { quote: "The plane takes off at noon.", reason: "no_garment_object" },
  { quote: "That sheds light on the problem.", reason: "no_garment_object" },
  { quote: "She sheds a tear.", reason: "no_garment_object" },
  { quote: "They meet behind the garden shed.", reason: "no_garment_object" },
  { quote: "She kicks off the meeting.", reason: "no_garment_object" },
  { quote: "The festival kicks off.", reason: "no_garment_object" },
  { quote: "She swaps stories for drinks.", reason: "no_garment_object" },
  { quote: "They traded barbs for an hour.", reason: "no_garment_object" },
  { quote: "She shrugs off the insult.", reason: "no_garment_object" },
  { quote: "She pulls off the highway.", reason: "no_garment_object" },
  { quote: "She puts on a brave face.", reason: "no_garment_object" },
  { quote: "She steps into the room.", reason: "no_garment_object" },
  { quote: "She slips into silence.", reason: "no_garment_object" },
  { quote: "She ties her hair back.", reason: "no_garment_object" },
  { quote: "She is back in the kitchen.", reason: "no_garment_object" },
  { quote: "She comes back in a moment.", reason: "no_garment_object" },
  { quote: "She is now wearing a scowl.", reason: "no_garment_object" },
  { quote: "He undresses her with his eyes.", reason: "no_garment_object" },
  { quote: "She takes off-white chalk from the tray.", reason: "no_garment_object" },
  { quote: "Uncle Don a week later called.", reason: "no_garment_object" },
  // The standing look, restated — not a change.
  { quote: "She is dressed in a soft white cotton tee.", reason: "no_signal" },
  // The chang* family without adjacent clothing context.
  { quote: "She changed her mind while adjusting her jacket.", reason: "no_garment_object" },
  { quote: "The weather changed and we ran into the barn.", reason: "no_garment_object" },
  { quote: "Nothing changed about the uniform policy.", reason: "negated" },
  // The object window never reaches across a sentence boundary.
  { quote: "She swaps a glance. Then she reaches for the door.", reason: "no_signal" },
  // A garment named BEFORE the verb is not the verb's object.
  { quote: "Wearing her jacket, she takes off for work.", reason: "no_garment_object" },
];

/**
 * Accepts. The last twelve are the strings the wardrobe suites already pin —
 * `chat-wardrobe.int.test.ts`'s eight replacing-evidence clauses and
 * `chat-state.test.ts`'s four — carried here verbatim so this suite fails first
 * if the classifier ever stops licensing a change the folds depend on.
 */
const ACCEPTS: readonly string[] = [
  "She takes off her jacket.",
  "She takes her jacket off.",
  "She pulls on a coat.",
  "She kicks off her boots.",
  "She sheds her jacket.",
  "She changes into a black silk shirt.",
  "She swaps her white cotton shirt for a black silk shirt.",
  "She trades her heels for flats.",
  "I take off my jacket.",
  "She doesn't hesitate. She takes off her jacket.",
  "no longer wearing the apron",
  "She wriggles out of the dress.",
  "now wearing a tank top",
  // chat-wardrobe.int.test.ts — the character fold.
  "She slips out of the work clothes and zips herself into a red evening dress.",
  "She ties a flour-dusted apron over her clothes.",
  "yanks on a paint-streaked tank top",
  "shrugs into a black silk shirt",
  // …and the player fold.
  "I peel off the cotton shirt and pull on a red evening dress.",
  "You tie a flour-dusted apron over your clothes.",
  "tugs you into a paint-streaked tank top",
  "you swap it for a black silk shirt",
  // chat-state.test.ts — the pure suite's positives.
  "shrugs off the work shirt and pulls on a black silk blouse",
  "Sabrina swaps her cotton work shirt for a black silk shirt before the first customer arrives, rolling the new sleeves to the elbow.",
  'pulls on a black silk blouse — "it\'s the good one"',
  "she changed into her sundress",
];

describe("classifyOutfitChangeQuote — non-events never license a wardrobe wipe", () => {
  it.each(REJECTS)("rejects: $quote", ({ quote, reason }) => {
    const verdict = classifyOutfitChangeQuote(lower(quote));
    expect(verdict.asserted).toBe(false);
    if (reason !== undefined && !verdict.asserted) expect(verdict.reason).toBe(reason);
  });
});

describe("classifyOutfitChangeQuote — a stated change still validates", () => {
  it.each(ACCEPTS.map((quote) => ({ quote })))("accepts: $quote", ({ quote }) => {
    expect(classifyOutfitChangeQuote(lower(quote))).toEqual({ asserted: true });
  });
});

describe("classifyOutfitChangeQuote — the boundaries the rows above ride on", () => {
  it("reads each sentence alone: one asserting sentence carries the quote", () => {
    // Sentence 1's negation vetoes only sentence 1.
    expect(classifyOutfitChangeQuote("she doesn't hesitate. she takes off her jacket.").asserted).toBe(true);
    // …and with no asserting sentence, the most informative rejection wins.
    expect(classifyOutfitChangeQuote("she nods. she doesn't take off her jacket.")).toEqual({
      asserted: false,
      reason: "negated",
    });
  });

  it("never splits a sentence on 'and' — the second clause is not an imperative", () => {
    // A clause split would read "pull on a red evening dress" as an order and veto it.
    expect(classifyOutfitChangeQuote("i peel off the cotton shirt and pull on a red evening dress.").asserted).toBe(
      true,
    );
  });

  it("vetoes quoted dialogue POSITIONALLY — a trailing quoted fragment does not", () => {
    expect(classifyOutfitChangeQuote('"take off your jacket," she says.')).toEqual({
      asserted: false,
      reason: "quoted",
    });
    expect(classifyOutfitChangeQuote('pulls on a black silk blouse — "it\'s the good one"').asserted).toBe(true);
  });

  it("keeps 'no longer' out of the negation veto — it is the strongest change there is", () => {
    expect(classifyOutfitChangeQuote("no longer wearing the apron").asserted).toBe(true);
    expect(classifyOutfitChangeQuote("she sits down without taking off her coat")).toEqual({
      asserted: false,
      reason: "negated",
    });
  });

  it("trips the imperative veto on BASE forms only — a third-person report is a report", () => {
    expect(classifyOutfitChangeQuote("pull on a paint-streaked tank top")).toEqual({
      asserted: false,
      reason: "command",
    });
    for (const reported of ["pulls on a coat", "yanks on a paint-streaked tank top", "tugs you into a tank top"]) {
      expect(classifyOutfitChangeQuote(reported).asserted).toBe(true);
    }
  });

  it("counts 'clothes'/'clothing' as the object, and a particle never as one", () => {
    expect(classifyOutfitChangeQuote("she slips out of the work clothes").asserted).toBe(true);
    // "into" is the verb's particle — the object after it decides.
    expect(classifyOutfitChangeQuote("she steps into the room").asserted).toBe(false);
    expect(classifyOutfitChangeQuote("she steps into a wedding gown").asserted).toBe(true);
  });

  it("needs the chang* context ADJACENT, so a far-off garment can't rescue it", () => {
    expect(classifyOutfitChangeQuote("she changed out of the work clothes").asserted).toBe(true);
    expect(classifyOutfitChangeQuote("she changed her mind while adjusting her jacket").asserted).toBe(false);
  });

  it("says nothing at all about a quote carrying no wardrobe verb", () => {
    expect(classifyOutfitChangeQuote("her sleeves are shoved past her elbows, one cuff dusted with flour.")).toEqual({
      asserted: false,
      reason: "no_signal",
    });
    expect(classifyOutfitChangeQuote("")).toEqual({ asserted: false, reason: "no_signal" });
  });
});
