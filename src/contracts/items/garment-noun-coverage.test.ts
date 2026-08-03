import { describe, expect, it } from "vitest";
import { expectRefsResolve } from "@/test/registry-invariants";
import { bodyLocationRegistry } from "../body/locations";
import {
  bareStateWords,
  conditionalSplitters,
  coordinatorSplitters,
  displacementMarkers,
  exclusionMarkers,
  garmentNounCoverage,
  negatedWearingLeads,
  negationCarryWords,
  negationExceptions,
  negationMarkers,
  overlayGarmentReads,
  overlayWornInputs,
  sheerModifiers,
  windowSplitters,
} from "./garment-noun-coverage";
import { exposedRegions } from "./visibility";

/** The four regions the rows exist to answer for, straight through the shared classifier. */
const regionsOf = (text: string) => exposedRegions(overlayWornInputs(text));

const rowFor = (text: string, identity: string) => overlayWornInputs(text).find((row) => row.name === identity);

describe("garment-noun coverage registry", () => {
  it("every mapped coverage id is a registered body location", () => {
    // A coverage id missing from the registry is silently SKIPPED by
    // exposedRegions, so a typo here would read as "this garment covers nothing"
    // — the exact silent failure this suite exists to catch.
    expectRefsResolve(
      [...garmentNounCoverage],
      ([, mapping]) => mapping.coverage,
      (id) => bodyLocationRegistry.byId(id),
      ([identity], id) => `${identity} → ${id}`,
    );
  });

  it("every mapping covers something (an empty row would be a dead entry)", () => {
    const empty = [...garmentNounCoverage].filter(([, mapping]) => mapping.coverage.length === 0);
    expect(empty.map(([identity]) => identity)).toEqual([]);
  });
});

describe("overlayWornInputs — the coverage a described look contributes", () => {
  it("reads a described gown as a gown (the defect: it contributed nothing)", () => {
    // The reported failure: a thong plus this overlay computed torso "bare", and
    // the scene prompt drew chest anatomy through the beading.
    const regions = regionsOf("pale lavender gown with delicate beading");
    expect(regions.torso).toBe("covered");
    expect(regions.pelvis).toBe("covered");
    expect(regions.legs).toBe("covered");
    // A dress says nothing about the feet — it must not silently shoe her.
    expect(regions.feet).toBe("bare");
  });

  it("answers PER REGION, so 'only a thong' is pelvis-covered and torso-bare", () => {
    const regions = regionsOf("wearing only a red thong");
    expect(regions.pelvis).toBe("covered");
    expect(regions.torso).toBe("bare");
  });

  it("names no garment ⇒ no rows at all", () => {
    expect(overlayWornInputs("wrapped in shadows and nothing else")).toEqual([]);
    expect(overlayWornInputs("")).toEqual([]);
  });

  it("an ambiguous-coverage garment contributes nothing rather than a guess", () => {
    // The noun registry knows "scarf"/"cloak"; this table deliberately does not.
    // A cloak may hang open over a bare chest, so mapping it would suppress
    // anatomy on nothing better than a coin flip.
    expect(overlayWornInputs("a long silk scarf")).toEqual([]);
    expect(overlayWornInputs("a heavy travelling cloak")).toEqual([]);
    expect(regionsOf("a long silk scarf").torso).toBe("bare");
  });

  it("carries the compound heads the noun registry resolves", () => {
    expect(rowFor("a paint-streaked tank top", "tank_top")?.coverage).toContain("chest");
    expect(regionsOf("a tank top and jeans").pelvis).toBe("covered");
  });

  it("keeps synthetic rows identifiable and out of anyone's id space", () => {
    const rows = overlayWornInputs("a linen shirt");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.instanceId).toBe("overlay:shirt");
    expect(rows[0]?.garmentId).toBe(rows[0]?.instanceId);
    expect(rows[0]?.opacity).toBe("opaque");
  });

  it("folds a repeated identity to one row", () => {
    expect(overlayWornInputs("a shirt over another shirt")).toHaveLength(1);
  });

  it("reads bikini SEPARATES as their own panel, never the pair", () => {
    // The defect: both resolved to the unigram, so a top covered the pelvis and
    // bottoms covered the chest — anatomy suppressed on a garment that is
    // demonstrably not there. Fixed in the vocabulary (compound heads), not here.
    const top = regionsOf("a bikini top");
    expect(top.torso).toBe("covered");
    expect(top.pelvis).toBe("bare");
    const bottoms = regionsOf("bikini bottoms");
    expect(bottoms.torso).toBe("bare");
    expect(bottoms.pelvis).toBe("covered");
    // The bare noun is still the pair, and still covers both.
    const pair = regionsOf("a bikini");
    expect(pair.torso).toBe("covered");
    expect(pair.pelvis).toBe("covered");
  });
});

describe("overlayWornInputs — named, but not covering", () => {
  it("a DENIED garment contributes nothing (the P1: stated bareness read as covered)", () => {
    expect(overlayWornInputs("without a shirt")).toEqual([]);
    expect(regionsOf("without a shirt").torso).toBe("bare");
  });

  it("denies only what the denial names", () => {
    const text = "no panties, just his hoodie";
    expect(rowFor(text, "panties")).toBeUndefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("covered");
    expect(regions.pelvis).toBe("bare");
  });

  it("carries a denial across a conjunction — 'a shirt or bra' is ONE denial", () => {
    expect(overlayWornInputs("without a shirt or bra")).toEqual([]);
  });

  it("stops carrying at the first word that is not filler", () => {
    // Window-scoped on purpose. Clause-scoped negation would strip the sweater
    // here and bare a covered torso — the one direction that must never happen.
    const text = "no bra under her sweater";
    expect(rowFor(text, "bra")).toBeUndefined();
    expect(rowFor(text, "sweater")).toBeDefined();
    expect(regionsOf(text).torso).toBe("covered");
  });

  it("every negation marker denies the garment after it", () => {
    for (const marker of negationMarkers) {
      expect(overlayWornInputs(`${marker} a robe`), marker).toEqual([]);
    }
  });

  it("reads a contextual 'not wearing' as a denial", () => {
    // The opaque row this used to emit reported a stated-bare torso as covered.
    const text = "jeans and not wearing a shirt";
    expect(rowFor(text, "shirt")).toBeUndefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("bare");
    // Per region, as always: the jeans are still on.
    expect(regions.pelvis).toBe("covered");
  });

  it("carries a 'not wearing' denial across a conjunction, like any other", () => {
    expect(overlayWornInputs("not wearing a shirt or bra")).toEqual([]);
  });

  it("a standalone lead is NOT a denial — only the bigram is", () => {
    // "not" is a hedge far more often than a denial, and suppressing a covering
    // garment on a hedge is the one failure direction this module refuses.
    expect(rowFor("not the shirt she meant to wear", "shirt")).toBeDefined();
    expect(regionsOf("not the shirt she meant to wear").torso).toBe("covered");
    // The verb alone is equally inert, or the canonical free-text look would undress.
    expect(regionsOf("wearing only a red thong").pelvis).toBe("covered");
  });

  it("every lead denies through 'wearing', and none of them denies alone", () => {
    for (const lead of negatedWearingLeads) {
      expect(overlayWornInputs(`${lead} wearing a robe`), `${lead} wearing`).toEqual([]);
      expect(overlayWornInputs(`${lead} a robe`), `${lead} alone`).toHaveLength(1);
    }
  });

  it("a DISPLACED garment contributes nothing, marker before or after the noun", () => {
    expect(overlayWornInputs("her shirt hanging open")).toEqual([]);
    expect(overlayWornInputs("gown pooled at her waist")).toEqual([]);
  });

  it("displaces only the garment it qualifies — the layer under it still covers", () => {
    const text = "unbuttoned jacket over a tee";
    expect(rowFor(text, "jacket")).toBeUndefined();
    expect(rowFor(text, "tee")).toBeDefined();
    expect(regionsOf(text).torso).toBe("covered");
  });

  it("every displacement marker reaches from BOTH windows", () => {
    for (const marker of displacementMarkers) {
      expect(overlayWornInputs(`her ${marker} robe`), `${marker} before`).toEqual([]);
      expect(overlayWornInputs(`her robe ${marker}`), `${marker} after`).toEqual([]);
    }
  });

  it("keeps hyphenated compounds whole, so a cut is not a displacement", () => {
    // "off-the-shoulder" is ONE token (the shared tokenizer), so the `off` marker
    // never appears in it — the same choice that keeps "lace-trimmed" opaque.
    expect(rowFor("off-the-shoulder gown", "gown")).toBeDefined();
    expect(regionsOf("off-the-shoulder gown").torso).toBe("covered");
  });

  it("a suppressed noun still closes the sheer window (the modifier was ITS adjective)", () => {
    expect(rowFor("no sheer bra under her sweater", "sweater")?.opacity).toBe("opaque");
  });

  it("an exception word ENDS the denial — what it excepts is worn", () => {
    // The defect: this denied the thong, and a denied garment is now read as its
    // own region BARE — the exact opposite of what the sentence says, where the
    // thong is the one thing that IS on.
    const text = "not wearing anything but a thong";
    expect(rowFor(text, "thong")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.pelvis).toBe("covered");
    expect(regions.torso).toBe("bare");
  });

  it("excepts a plain negation marker as readily as the 'wearing' bigram", () => {
    expect(rowFor("isn't wearing anything except a bra", "bra")).toBeDefined();
    expect(rowFor("without anything but a thong", "thong")).toBeDefined();
  });

  it("every exception word un-negates both denial shapes", () => {
    for (const word of negationExceptions) {
      expect(overlayWornInputs(`not wearing anything ${word} a robe`), `bigram + ${word}`).toHaveLength(1);
      expect(overlayWornInputs(`without anything ${word} a robe`), `marker + ${word}`).toHaveLength(1);
    }
  });

  it("alone, only an EXCLUSION denies — every other exception word is inert", () => {
    // The split the `exclusionMarkers` subset exists for: with no negation to
    // except from, "excluding a robe" is itself the denial, while a bare "but" is
    // an ordinary coordinator and must leave the garment on.
    for (const word of negationExceptions) {
      const rows = overlayWornInputs(`${word} a robe`);
      expect(rows.length, `${word} alone`).toBe(exclusionMarkers.has(word) ? 0 : 1);
    }
  });

  it("an exception BEFORE the negation is inert — it excepts nothing yet denied", () => {
    // Positional, not a presence check: the denial is the LAST word of the two.
    expect(overlayWornInputs("but not wearing a shirt")).toEqual([]);
  });

  it("carries the un-negated verdict across a conjunction, like any other", () => {
    const text = "not wearing anything but a bra or panties";
    expect(rowFor(text, "bra")).toBeDefined();
    expect(rowFor(text, "panties")).toBeDefined();
  });

  it("an exception is not filler, so it breaks the carry", () => {
    // The half of the rule that keeps the exceptions OUT of `negationCarryWords`:
    // the denial has to stop at "but", or the jeans go with the shirt.
    expect([...negationExceptions].filter((word) => negationCarryWords.has(word))).toEqual([]);
    const text = "without a shirt but jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    expect(regionsOf(text).pelvis).toBe("covered");
  });

  it("multiword exceptives stay out of scope, and fail the benign way", () => {
    // This scanner reads unigrams, and a bare "apart" is not reliably exceptive,
    // so the denial stands and the garment contributes nothing — the direction
    // that costs coverage rather than baring a body. "aside" would never reach
    // the negation scan anyway: it is a displacement marker first.
    expect(overlayWornInputs("not wearing anything apart from a thong")).toEqual([]);
    expect(overlayWornInputs("not wearing anything aside from a thong")).toEqual([]);
  });
});

/**
 * The third reading of an exception word: with no negation anywhere before it to
 * except FROM, an `exclusionMarkers` word is itself the denial. "jeans, excluding
 * a bra" and "everything except a bra" state what is NOT on, and reading them as
 * mere exceptions emitted an opaque chest row over a bared one — the
 * over-covering direction this module exists to close.
 *
 * The subset is the whole precision story, and it is why the flip cannot be read
 * off `negationExceptions` wholesale: a standalone "but" is an ordinary
 * coordinator ("without a shirt but jeans"), so promoting it would strip a
 * garment the prose plainly puts on.
 *
 * "Nothing to except from" is scoped to the DENIAL, not to the segment: a noun
 * denied one step back is still something to except from, so "not wearing
 * underwear except a bra" wears the bra. Only a clause that has denied nothing
 * yet reads the exclusion as a denial of its own.
 */
describe("overlayWornInputs — an exclusion with nothing to except from", () => {
  it("denies the garment an exclusion names", () => {
    const text = "jeans, excluding a bra";
    expect(rowFor(text, "bra")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("bare");
    expect(regions.pelvis).toBe("covered");
  });

  it("reads the total-wardrobe phrasing too", () => {
    expect(rowFor("everything except a bra", "bra")).toBeUndefined();
    expect(regionsOf("everything except a bra").torso).toBe("bare");
  });

  it("rides the conjunction carry like any other denial", () => {
    expect(overlayWornInputs("excluding a bra or panties")).toEqual([]);
  });

  it("excepts from the PREVIOUS noun's denial rather than opening a new one", () => {
    // The defect: the underwear's denial stopped at its own segment, so the bra's
    // lone "except" read as a standalone exclusion and stripped the one garment
    // the sentence puts ON — free-text exposure then reported a bare torso
    // straight through a worn bra.
    const text = "jeans and not wearing underwear except a bra";
    expect(rowFor(text, "underwear")).toBeUndefined();
    expect(rowFor(text, "bra")).toBeDefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("covered");
    expect(regions.pelvis).toBe("covered");
  });

  it("inherits a plain negation marker's denial as readily as the bigram", () => {
    expect(rowFor("no shirt except a camisole", "camisole")).toBeDefined();
    expect(regionsOf("no shirt except a camisole").torso).toBe("covered");
    // Every exclusion cancels an inherited denial exactly as it cancels a local
    // one — the same word, the same reading, one noun further back.
    for (const word of exclusionMarkers) {
      expect(overlayWornInputs(`not wearing a shirt ${word} a robe`), `${word} inherits`).toHaveLength(1);
    }
  });

  it("an excepted noun ENDS the denial, so the carry keeps what follows", () => {
    // The kept verdict propagates like any other: the bra un-negates, and the
    // pure-filler "and" carries that un-negated state onto the panties.
    const text = "not wearing underwear except a bra and panties";
    expect(rowFor(text, "underwear")).toBeUndefined();
    expect(rowFor(text, "bra")).toBeDefined();
    expect(rowFor(text, "panties")).toBeDefined();
  });

  it("a clause boundary resets the scope, so the exclusion denies again", () => {
    // What keeps the standalone reading alive at all: the second clause has
    // denied nothing, so "excluding" is the denial rather than a cancel.
    const text = "no shirt, jeans excluding a bra";
    expect(rowFor(text, "bra")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    expect(regionsOf(text).torso).toBe("bare");
    expect(regionsOf(text).pelvis).toBe("covered");
  });

  it("keeps the coordinating 'but' out of it — the protected phrasing", () => {
    // The reason `exclusionMarkers` is a strict subset rather than the whole
    // exception registry: here "but" joins two clauses, and denying on it would
    // strip jeans the sentence puts on.
    const text = "without a shirt but jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    // Same word, other order: a negation AFTER the exception still stands.
    expect(rowFor("jeans but no shirt", "shirt")).toBeUndefined();
    expect(rowFor("jeans but no shirt", "jeans")).toBeDefined();
    expect(overlayWornInputs("but not wearing a shirt")).toEqual([]);
  });

  it("every exclusion word is an exception word first", () => {
    // Subset, not a parallel registry: an exclusion still CANCELS a real negation
    // ("not wearing anything except a bra" wears the bra), and only flips to a
    // denial when there is no negation to cancel.
    expect([...exclusionMarkers].filter((word) => !negationExceptions.has(word))).toEqual([]);
    for (const word of exclusionMarkers) {
      expect(overlayWornInputs(`not wearing anything ${word} a robe`), `${word} cancels`).toHaveLength(1);
      expect(overlayWornInputs(`${word} a robe`), `${word} alone`).toEqual([]);
    }
  });

  it("a bare-state word is the negation an exception flips, and nothing else", () => {
    // `bareStateWords` deny no garment of their own — they state a bare BODY — but
    // they are negation hits, which is what keeps "nothing but a thong" a worn
    // thong now that a standalone exclusion denies.
    expect(rowFor("nothing but a thong", "thong")).toBeDefined();
    expect(regionsOf("nothing but a thong").pelvis).toBe("covered");
    expect(rowFor("she wore nothing except the apron", "apron")).toBeDefined();
    for (const word of bareStateWords) {
      expect(overlayWornInputs(`wearing ${word} but a robe`), `${word} + exception`).toHaveLength(1);
      // …and the layering hinge fences the hit off the garment underneath.
      expect(overlayWornInputs(`wearing ${word} under a robe`), `${word} + hinge`).toHaveLength(1);
    }
  });

  it("keeps the bare-state words in their own registry", () => {
    // In `negationMarkers` they would deny the noun they precede, which is the
    // opposite of what "wearing nothing under her dress" says; in
    // `negationExceptions` or `negationCarryWords` they would cancel or carry
    // denials they are supposed to BE.
    const words = [...bareStateWords];
    expect(words.filter((word) => negationMarkers.has(word) || negatedWearingLeads.has(word))).toEqual([]);
    expect(words.filter((word) => negationExceptions.has(word) || negationCarryWords.has(word))).toEqual([]);
    expect(
      words.filter(
        (word) => windowSplitters.has(word) || coordinatorSplitters.has(word) || conditionalSplitters.has(word),
      ),
    ).toEqual([]);
  });
});

/**
 * Who owns a SHARED window (`windowSplitters`, plus the marker-gated
 * `conditionalSplitters`). The span between two garment nouns is the first one's
 * post-modifier ground and the second one's pre-modifier ground at once, and
 * reading it whole suppressed both: "a shirt under an open jacket" lost the shirt
 * as well as the jacket and reported a covered torso as BARE — the under-covering
 * direction the module forbids. Splitting at the wrong word inverts it instead:
 * "a shirt with buttons open and jeans" dressed the open shirt and stripped the
 * jeans, which is why "with" hinges only when it has something to fence.
 */
describe("overlayWornInputs — which garment a shared window modifies", () => {
  it("a layering hinge keeps the displacement off the garment underneath", () => {
    const text = "a shirt under an open jacket and jeans";
    expect(rowFor(text, "jacket")).toBeUndefined();
    expect(rowFor(text, "shirt")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("covered");
    expect(regions.pelvis).toBe("covered");
  });

  it("splits the same window from the other side — the marker before the hinge is the FIRST garment's", () => {
    // Pure forward attachment would have displaced the tee here, which is the
    // covering layer: the hinge is what tells the two apart.
    const text = "jacket unbuttoned over a tee";
    expect(rowFor(text, "jacket")).toBeUndefined();
    expect(rowFor(text, "tee")).toBeDefined();
    expect(regionsOf(text).torso).toBe("covered");
  });

  it("a clause-final window attaches wholly BACKWARD, hinge or no hinge", () => {
    // Nothing follows, so every word of it is the last noun's post-modifier —
    // including a hinge with no garment on the far side of it.
    expect(overlayWornInputs("her shirt hanging open")).toEqual([]);
    expect(overlayWornInputs("gown pooled at her waist")).toEqual([]);
    expect(overlayWornInputs("her shirt hanging open over her hips")).toEqual([]);
    // …and it belongs to its OWN noun only: the shirt goes, the bra under it stays.
    const text = "a bra under a shirt hanging open";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "bra")).toBeDefined();
  });

  it("a clause transition hinges like a preposition", () => {
    // The inversion this fixes: with no hinge in "hanging open while wearing",
    // the whole span attached forward, so the participle displaced the JEANS and
    // the stated-open shirt kept covering — the sentence read backwards.
    const text = "a shirt hanging open while wearing jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("bare");
    expect(regions.pelvis).toBe("covered");
    // The forward half is the inert standalone "wearing", exactly as it is in
    // "wearing only a red thong".
    expect(rowFor("a shirt hanging open whilst wearing jeans", "jeans")).toBeDefined();
  });

  it("'as' is a clause transition too — the same inversion, one word smaller", () => {
    // Missing from the hinge registry, the span attached wholly forward and
    // `hanging open` displaced the JEANS while the stated-open shirt covered.
    const text = "a shirt hanging open as she wears jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("bare");
    expect(regions.pelvis).toBe("covered");
  });

  it("a comparative 'as' costs nothing — the hinge fences an empty segment", () => {
    // The reading that made "as" look risky. It hinges on first hit, but nothing
    // fenceable stands before it, so both garments keep covering — and the same
    // is true of the correlative "as well as".
    const soft = "a robe soft as silk over a chemise";
    expect(rowFor(soft, "robe")).toBeDefined();
    expect(rowFor(soft, "chemise")).toBeDefined();
    expect(regionsOf(soft).torso).toBe("covered");
    expect(rowFor("a gown as dark as night", "gown")).toBeDefined();
    expect(overlayWornInputs("a bra as well as a thong").map((row) => row.name)).toEqual(["bra", "thong"]);
  });

  it("a clause-initial window attaches FORWARD from its hinge", () => {
    // Hinge-less, that is the whole span: the marker is the jacket's.
    expect(overlayWornInputs("unbuttoned jacket")).toEqual([]);
    expect(overlayWornInputs("unbuttoned jacket over a tee").map((row) => row.name)).toEqual(["tee"]);
    // Hinged, only the remainder reaches the noun — the tokens before the hinge
    // qualify a garment the text never named, so no noun owns them. Without the
    // split, the `nothing` hit sailed forward and stripped a dress that is ON.
    expect(rowFor("wearing nothing under her dress", "dress")).toBeDefined();
    expect(regionsOf("wearing nothing under her dress").torso).toBe("covered");
    expect(rowFor("with nothing on under her coat", "coat")).toBeDefined();
    // The same rescue for a negation that was never about the later garment.
    expect(rowFor("not wearing anything under her dress", "dress")).toBeDefined();
  });

  it("a hinge-less shared window attaches FORWARD (English stacks adjectives ahead of the noun)", () => {
    // Terse overlay prose with no punctuation: the modifier is the stockings'.
    const text = "a black bra sheer stockings";
    expect(rowFor(text, "stockings")?.opacity).toBe("sheer");
    expect(rowFor(text, "bra")?.opacity).toBe("opaque");
  });

  it("'with' opening a POSTMODIFIER is not a hinge — the phrase stays on the garment it describes", () => {
    // The inversion this rule exists for: splitting at the "with" left the shirt
    // opaque and sent "buttons open" forward to displace the JEANS — exactly
    // backwards from the prose, and a stated-open torso read as covered. Unmarked,
    // the "with" is transparent and the hinge lands on the coordinator instead.
    const text = "a shirt with buttons open and jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("bare");
    expect(regions.pelvis).toBe("covered");
  });

  it("'with' IS a hinge once a marker precedes it — the layering reading", () => {
    // The other half of the ambiguity: here "with" joins two garments, and the
    // marker before it is the shirt's alone.
    const text = "shirt unbuttoned with jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    expect(regionsOf(text).pelvis).toBe("covered");
  });

  it("an ordinary adjective does not arm the conditional hinge", () => {
    // "loose" is no marker registry's word, so there is still nothing to fence:
    // the "with" stays transparent and the whole phrase is the shirt's.
    const text = "a shirt loose with buttons open and jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
  });

  it("plain accompaniment dresses both garments", () => {
    // Nothing to apportion on either side of the "with", so the hinge-less window
    // attaches forward and neither noun picks up a qualifier it never had.
    const text = "a jacket with a tee";
    expect(rowFor(text, "jacket")).toBeDefined();
    expect(rowFor(text, "tee")).toBeDefined();
    expect(regionsOf(text).torso).toBe("covered");
  });

  it("a transparent 'with' still breaks the negation carry — it is not filler", () => {
    const text = "no shirt with jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("bare");
    expect(regions.pelvis).toBe("covered");
  });

  it("the negation carry still reads the window WHOLE — a hinge breaks it", () => {
    // Apportioned, the jacket's segment is the pure filler "her", which would
    // carry the denial onto it and bare a covered torso.
    const text = "no shirt under her jacket";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jacket")).toBeDefined();
    expect(regionsOf(text).torso).toBe("covered");
  });

  it("only the coordinators may be both a hinge and negation filler", () => {
    // A layering preposition or clause transition in `negationCarryWords` would
    // carry the denial above, and so would a conditional hinge — "no shirt with
    // jeans" must keep the jeans, and "no jacket while wearing a shirt" the shirt.
    // The coordinators are in both on purpose: "or" hinges AND carries, which is
    // what makes "without a shirt or bra" one denial. Asserted as set identity
    // against `coordinatorSplitters` rather than a literal, so neither registry can
    // drift into the other's job. All three hinge sets are read, so splitting the
    // registry cannot open a gap in the invariant.
    const hinges = [...windowSplitters, ...coordinatorSplitters, ...conditionalSplitters];
    expect(hinges.filter((word) => negationCarryWords.has(word)).sort()).toEqual([...coordinatorSplitters].sort());
    // …and the three sets stay disjoint: a word in two of them would match the
    // first gate the scan reaches and the other's condition would never run.
    expect([...coordinatorSplitters].filter((word) => windowSplitters.has(word))).toEqual([]);
    const conditional = [...conditionalSplitters];
    expect(conditional.filter((word) => windowSplitters.has(word) || coordinatorSplitters.has(word))).toEqual([]);
  });
});

/**
 * When a coordinator is NOT a garment boundary. "and" joins two garments ("a
 * shirt and jeans") or two postmodifiers of ONE garment ("shirt unbuttoned and
 * hanging open with jeans") — and hinging at the second shape inverted the whole
 * look: `hanging open` sailed forward to displace the jeans while the
 * stated-open shirt kept covering, so a torso the prose bared read as covered.
 * The lookahead that tells them apart is grammatical, not lexical: displacement
 * markers are participial POSTmodifiers, so one after the coordinator means the
 * coordination is still inside the previous garment's postmodifier phrase.
 */
describe("overlayWornInputs — when a coordinator is not a hinge", () => {
  it("keeps a coordinated participle phrase on the garment it describes", () => {
    const text = "shirt unbuttoned and hanging open with jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("bare");
    expect(regions.pelvis).toBe("covered");
  });

  it("reads the reported look whole — bra on, jeans on, open shirt covering nothing", () => {
    const text = "a bra, shirt unbuttoned and hanging open with jeans";
    // The "and" declines the hinge and the "with" takes it, which is what leaves
    // the jeans with an empty pre-segment instead of the shirt's participles.
    expect(overlayWornInputs(text).map((row) => row.name)).toEqual(["bra", "jeans"]);
    const regions = regionsOf(text);
    expect(regions.torso).toBe("covered");
    expect(regions.pelvis).toBe("covered");
  });

  it("still hinges when nothing displacing follows it", () => {
    const text = "shirt unbuttoned and jeans";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "jeans")).toBeDefined();
  });

  it("leaves a bare coordination alone — both garments are on", () => {
    const text = "a shirt and jeans";
    expect(rowFor(text, "shirt")).toBeDefined();
    expect(rowFor(text, "jeans")).toBeDefined();
  });

  it("a sheer PREmodifier does not defer the hinge", () => {
    // The other half of the grammar: `sheerModifiers` premodify the noun AFTER
    // them, so they say nothing about whether the shirt's phrase has ended — and
    // the marker still has to reach the stockings it qualifies.
    const text = "a shirt unbuttoned and sheer stockings";
    expect(rowFor(text, "shirt")).toBeUndefined();
    expect(rowFor(text, "stockings")?.opacity).toBe("sheer");
  });

  it("a displacing PREmodifier lands forward either way", () => {
    // The happy accident that makes the lookahead cheap: skipped, the window goes
    // hinge-less and attaches wholly forward; hinged, everything past the
    // coordinator attaches forward too. Discarded jeans are not worn on either
    // reading, and the shirt never picks the marker up.
    const text = "a shirt and discarded jeans";
    expect(rowFor(text, "jeans")).toBeUndefined();
    expect(rowFor(text, "shirt")).toBeDefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("covered");
    expect(regions.pelvis).toBe("bare");
  });
});

/**
 * The second output (`overlayGarmentReads.deniedCoverage`). A suppressed garment
 * leaves no row, and for the union path that is the whole story — but "not
 * wearing a shirt" alone then produced ZERO rows, the same shape as prose naming
 * no clothing, which the free-text caller reads as fully covered. A stated-bare
 * chest came back dressed.
 *
 * So the scan reports both sides. The worn half is untouched (`overlayWornInputs`
 * is now a thin wrapper over the same scan, so the two can never disagree), and
 * the denied half is bounded by the SAME coverage table — an unmapped noun bares
 * nothing, exactly as it dresses nothing.
 */
describe("overlayGarmentReads — the coverage a denial reports", () => {
  it("hands the worn half back unchanged (the wrapper reads one scan)", () => {
    for (const text of ["a linen shirt", "not wearing a shirt", "a bra, shirt unbuttoned and hanging open with jeans"]) {
      expect(overlayGarmentReads(text).worn, text).toEqual(overlayWornInputs(text));
    }
  });

  it("reports what a DENIED garment would have covered", () => {
    const reads = overlayGarmentReads("not wearing a shirt");
    expect(reads.worn).toEqual([]);
    // The top template's chest is what makes this answerable per region; the
    // caller expands and maps it to torso.
    expect(reads.deniedCoverage).toContain("chest");
  });

  it("counts a DISPLACED garment as denied — it is the same claim", () => {
    // "not covering what it names" is one verdict however the text phrases it;
    // splitting them would leave "her shirt hanging open" reading as covered
    // prose that mentions a shirt.
    expect(overlayGarmentReads("her shirt hanging open").deniedCoverage).toContain("chest");
    expect(overlayGarmentReads("gown pooled at her waist").deniedCoverage).toContain("pelvis");
  });

  it("an UNMAPPED noun contributes to NEITHER side", () => {
    // The genuinely different case: nobody knows what a cloak covers, so a denied
    // one can no more bare a region than a worn one can dress it.
    const reads = overlayGarmentReads("not wearing a cloak");
    expect(reads.worn).toEqual([]);
    expect(reads.deniedCoverage).toEqual([]);
  });

  it("a worn garment reports no denial, and a denial no row", () => {
    expect(overlayGarmentReads("a linen shirt").deniedCoverage).toEqual([]);
    expect(overlayGarmentReads("not wearing a shirt").worn).toEqual([]);
  });

  it("dedupes across the whole text, however many nouns claim the same location", () => {
    const reads = overlayGarmentReads("no shirt, no blouse, not wearing a camisole");
    expect(reads.deniedCoverage.filter((id) => id === "chest")).toHaveLength(1);
  });

  it("carries the denial across a conjunction, exactly as the rows do", () => {
    const reads = overlayGarmentReads("not wearing a bra or panties");
    expect(reads.deniedCoverage).toContain("chest");
    expect(reads.deniedCoverage).toContain("pelvis");
  });

  it("an EXCEPTED garment is worn, not denied", () => {
    const reads = overlayGarmentReads("not wearing anything but a thong");
    expect(reads.worn.map((row) => row.name)).toEqual(["thong"]);
    expect(reads.deniedCoverage).toEqual([]);
  });

  it("a bare-state word with no noun denies nothing — there is no garment to bound it", () => {
    // Documented, and the reason it is acceptable: this scanner only ever speaks
    // through garment nouns, so "not wearing anything" leaves the caller on its
    // covered default and the archivist's exposure flag carries that beat.
    const reads = overlayGarmentReads("not wearing anything");
    expect(reads.worn).toEqual([]);
    expect(reads.deniedCoverage).toEqual([]);
  });
});

describe("overlayWornInputs — the sheer window", () => {
  it("a modifier before a garment makes THAT garment see-through", () => {
    expect(rowFor("a sheer black negligee", "negligee")?.opacity).toBe("sheer");
    expect(regionsOf("a sheer black negligee").torso).toBe("sheer");
  });

  it("every listed modifier reaches the garment it qualifies", () => {
    for (const modifier of sheerModifiers) {
      expect(rowFor(`a ${modifier} robe`, "robe")?.opacity, modifier).toBe("sheer");
    }
  });

  it("does not leak across a clause boundary", () => {
    const text = "a lace-trimmed cotton robe, sheer stockings";
    // "lace-trimmed" is one token (the shared tokenizer keeps hyphenated
    // compounds whole), so the trim never reads as the fabric…
    expect(rowFor(text, "robe")?.opacity).toBe("opaque");
    // …and the comma stops the modifier that follows from reaching backwards.
    expect(rowFor(text, "stockings")?.opacity).toBe("sheer");
    expect(rowFor("a sheer camisole, a wool skirt", "skirt")?.opacity).toBe("opaque");
  });

  it("is spent on the first garment it reaches", () => {
    const text = "a sheer robe over a cotton shift dress";
    expect(rowFor(text, "robe")?.opacity).toBe("sheer");
    expect(rowFor(text, "dress")?.opacity).toBe("opaque");
    // Opaque wins the region even under a sheer layer — the classifier's own rule.
    expect(exposedRegions(overlayWornInputs(text)).torso).toBe("covered");
  });

  it("an unmapped garment still closes the window (the modifier was ITS adjective)", () => {
    expect(rowFor("a sheer scarf and a linen dress", "dress")?.opacity).toBe("opaque");
  });

  it("does not bleed forward past a layering hinge", () => {
    // A postposed modifier belongs to the garment BEFORE it, where it is inert —
    // which beats dressing the jacket in the chemise's fabric.
    const text = "a chemise sheer beneath a jacket";
    expect(rowFor(text, "jacket")?.opacity).toBe("opaque");
    expect(rowFor(text, "chemise")?.opacity).toBe("opaque");
  });
});
