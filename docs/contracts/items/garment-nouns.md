[← Items and wardrobe](README.md)

# Coverage from garment nouns

Free text is wardrobe too. `items/garment-noun-coverage.ts` maps each canonical garment identity
(`garment-nouns.ts`) to the coverage it contributes, so the chat lane's free-text overlay — the
character sheet's "Also / instead" field — stops reading as nothing: `overlayWornInputs(text)`
returns synthetic `WornItemInput` rows (`overlay:<identity>`) that `resolveChatWardrobe` folds into
`exposedRegions`.

Without it, a character in a thong plus an overlay reading "pale lavender gown" computed
`torso: "bare"` and the scene prompt drew chest anatomy through the described gown.

## The coverage table

**Coverage ids come from the category templates** wherever one fits, so the lists live in one
place; the handful that has no template (bikini, corset, hosiery, armor) is spelled out beside
them. Bikini **separates** are compound identities in the noun registry (`bikini top` →
`bikini_top`, `bikini bottoms` → `bikini_bottom`), so each claims only its own panel — the bare
noun is still the pair.

**Precision beats recall, harder than in the noun registry.** An unmapped noun contributes nothing,
which is safe. A wrong one suppresses or bares anatomy nobody asked for. So ambiguous-coverage
garments (scarf, shawl, cape, poncho, cloak, garter, costume) are deliberately absent: a cloak may
hang open over a bare chest.

**Sheer is stated, never assumed.** A modifier from `sheerModifiers` (sheer, gauzy, mesh, lace,
fishnet, …) in the segment a garment owns before it makes THIS garment sheer, and is spent there.
Hyphenated compounds stay one token, so "a lace-trimmed cotton robe" is opaque — the trim is not
the fabric.

## Every qualifier attaches to ONE noun

The tokens between two garment nouns are the first one's post-modifier ground and the second one's
pre-modifier ground at the same time, so the span is apportioned at a hinge. Before it attaches
BACKWARD, after it FORWARD, the hinge itself belongs to neither, and a hinge-less shared span goes
wholly forward — English stacks bare adjectives ahead of the noun.

Three hinge registries, in the order the scan tries them.

### `windowSplitters` — unconditional

The layering prepositions (over, under, underneath, beneath, atop, above, below) plus the clause
transitions (while, whilst, as) hinge on first hit.

A clause transition earns the unconditional treatment for the same reason a preposition does: it
never premodifies the noun after it, so everything before it is finished business. Without it, "a
shirt hanging open while wearing jeans" attached whole and forward, displacing the JEANS while the
open shirt kept covering.

"as" is in for its transition reading ("a shirt hanging open as she wears jeans"), which is the one
that costs a garment when missed; a LONE comparative "as" agrees, since nothing fenceable precedes
one ("a robe soft as silk over a chemise" keeps both garments). The correlative `as … as` **span**
is the exception, and `readComparatives` takes it out of the registry's hands — neither "as" hinges
(see §A compared garment is not a worn one). **"as well as" is additive, not comparative**
(`additiveAsInners`, keyed on the joined inner tokens): it is no span at all, so its first "as"
hinges as ever and "a bra as well as a thong" dresses both.

### `coordinatorSplitters` — conditional

And, or, nor. One does NOT hinge when a `displacementMarkers` word stands between it and the next
hinge candidate, because displacement markers are participial POSTmodifiers: "shirt unbuttoned and
hanging open with jeans" coordinates two descriptions of the SHIRT, and hinging at that "and"
opened the jeans and left the open shirt covering. `sheerModifiers` premodify the noun after them
and so never defer the hinge — "a shirt unbuttoned and sheer stockings" still fences.

### `conditionalSplitters` — "with", conditional on both counts

"with" hinges only when a marker (`displacementMarkers` / `negationMarkers` / `sheerModifiers`)
already stands before it in the span **and** no displacement marker follows it.

Unmarked it introduces the PREVIOUS garment's postmodifier ("a shirt with buttons open and jeans" —
the shirt is open, the jeans are on) or plain accompaniment ("a jacket with a tee"), and splitting
there inverted both.

Marked, it is a layering hinge like the prepositions ("shirt unbuttoned with jeans") — unless its
own phrase runs on into another participle, which is the coordinator's lookahead asking the
coordinator's question. "A shirt hanging open with buttons undone and jeans" is one postmodifier of
the SHIRT, and hinging at that "with" fenced the shirt right and then sent `buttons undone` forward
to strip the jeans as well, reporting a bare pelvis over a worn garment. Being marked says something
needs fencing; only the lookahead says the phrase has ENDED.

Deferring never ends the scan — the hinge lands on the next eligible splitter, the "and" here — and
it pays the coordinator's stranded-marker cost on the same terms: "a shirt unbuttoned with discarded
jeans" keeps the shirt, over-covering by one rather than under-covering the next.

### What ENDS a clause

Every separator prose uses to finish a garment description mid-line: `,` `;` `.` `:` `!` `?` `…`, a
newline, and the dashes — em, en, and a **spaced** ASCII hyphen, never a bare one, which is the
joint of a compound the tokenizer keeps whole.

The dashes had to be in the set because the tokenizer erases them, so a missing separator does not
merely fail to split: "a shirt hanging open — jeans" became one hinge-less shared span, which
attaches forward, displacing the JEANS and leaving the stated-open shirt covering.

A clause-final span is all post-modifier ("her shirt hanging open") — hinge or no hinge, since the
displacement scan wants the whole tail and no negation reads it.

A clause-INITIAL span is pre-modifier ground too, but it splits at the same hinge and keeps only the
remainder: hinge-less it is all the noun's ("unbuttoned jacket"), while the tokens before a hinge
qualify a garment the text never named, so nobody owns them ("wearing nothing under her dress" hands
the dress just "her", and the dress keeps covering). Reading a shared span whole is what "a shirt
under an open jacket" broke: `open` displaced the shirt as well as the jacket and a covered torso
read BARE.

No hinge but the coordinators may join `negationCarryWords` — the carry check reads its window
UNSPLIT, which is exactly why "no shirt under her jacket" and "no shirt with jeans" leave the later
garment covering, while "or" hinges AND carries so that "without a shirt or bra" is one denial.

## Named is not worn

A noun contributes NO row when the segment before it holds a `negationMarkers` word (no, without,
sans, minus, lacking, missing) or a `negatedWearingLeads` word immediately followed by "wearing"
(not, never, isn't, wasn't, stopped, quit …), or when either segment it owns holds a
`displacementMarkers` word (open, unbuttoned, pooled, shoved, hanging, slipped, off, aside, …).
"Without a shirt", "jeans and not wearing a shirt", "her shirt hanging open", "gown pooled at her
waist" all name clothing that is not covering anything.

The "wearing" bigram is the whole rule — a standalone "not" is a hedge ("not the shirt she meant to
wear") and never denies.

### Exceptions end a denial

An **exception word** (`negationExceptions` — but, except, save, besides, excluding, barring, than)
ENDS a denial: the segment denies only when its last negation stands after its last exception, so
"not wearing anything but a thong" wears the thong (pelvis covered, torso bare) while "but not
wearing a shirt" still denies.

Exceptions are deliberately NOT `negationCarryWords` — "without a shirt but jeans" has to keep the
jeans.

With **no negation anywhere to except from**, an exception flips the other way and becomes the
denial itself ("jeans, excluding a bra", "everything except a bra" — a bare chest, not an opaque
chest row), and it carries like any other ("excluding a bra or panties" denies both).

**"Anywhere" reaches back a noun**: a garment denied one step earlier is still something to except
from, so "not wearing underwear except a bra" cancels that denial and wears the bra — a kept noun
then ends the scope, which is how "…except a bra and panties" keeps both. Only a span with nothing
denied in scope reads the exclusion as a denial, which the clause reset restores ("no shirt, jeans
excluding a bra" leaves the bra off).

**A clause OPENING with an exception word inherits instead of resetting.** "Not wearing underwear,
except a bra" is the same sentence with punctuation in it, and the reset made that lone "except" a
standalone exclusion that stripped the one garment the prose puts on. The seed is the previous
clause's closing verdict, and it reaches no further than that first segment's exclusion — the
exception word that armed it sits in that same window and is not filler, so the conjunction carry
can never pick it up.

Only the `exclusionMarkers` subset (except, excluding, barring) flips: a standalone "but" is an
ordinary coordinator, and "save"/"besides" read as verb and additive as readily as exceptive. That
leaves "everything **but** a bra" out of reach on purpose — the coordinator reading is too common to
promote on context this thin.

`bareStateWords` (nothing, none) are what keep the flip honest: they state a bare BODY rather than
deny a named garment, so they are negation hits in their own registry, which is what makes "nothing
but a thong" a worn thong rather than a bare exclusion. The layering hinge is what stops that hit
from stripping a garment that IS on — "wearing nothing under her dress" apportions everything up to
`under` to a span no noun owns.

Multiword exceptives ("apart from", "aside from") are out of scope: this scanner reads unigrams, so
the denial stands and the garment simply contributes nothing — and "aside" is a displacement marker
before it is anything else.

### Carrying a denial

A denial carries to the next noun only across pure filler (`negationCarryWords` — and/or/the/her/a…),
so "without a shirt or bra" denies both while "no bra under her sweater" leaves the sweater covering;
clause-scoped negation would have stripped that sweater. What carries is the segment's verdict, so an
excepted noun carries its un-negated state on ("not wearing anything but a bra or panties" wears
both).

The failure directions are asymmetric on purpose: suppressing wrongly costs that garment's coverage,
and on the free-text path reports that region bare, while a MISSED displacement leaves bared anatomy
reading as covered with nothing but the archivist's exposure flag to fight it. Both cost something;
the second is still the worse one, which is why the qualifier registries stay wide and the coverage
table stays narrow.

Hyphenated compounds stay one token here too, so "off-the-shoulder gown" still covers.

## A compared garment is not a worn one

An `as … as` span (`readComparatives` — an "as" and the next one at least two tokens on, so "as as"
is nothing) is a simile, and it answers in both directions at once.

Its inner words describe the garment BEFORE the span, in both of the readings this scanner has: a
`sheerModifiers` word there makes THAT garment see-through — a postmodifier of one naming rather
than a second naming, which is why it is the single read exempt from opaque-wins — and a
`displacementMarkers` word DENIES it ("a shirt as open as a vest" states an open shirt), the same
verdict displacement carries anywhere else, so the garment lands on the denied side and reads bare
per region.

A span saying both suppresses: a row that is never emitted has no opacity to be sheer. While only
sheer travelled backward, the span swallowed `open` and the yardstick that would otherwise have
carried it emits nothing, so an explicitly open shirt reported a covered torso.

The noun the span's window ends at is the yardstick the comparison measures against, and it
contributes to NEITHER output — no row and no denial, exactly like an unmapped noun.

**What ends a yardstick phrase is a HINGE word, never an adjective**: only `windowSplitters` /
`coordinatorSplitters` / `conditionalSplitters` between the closing "as" and the noun say the simile
is over and a genuinely worn garment follows ("as sheer as glass **over** a negligee", "as sheer as
silk **and** jeans"), while premodifiers ride along with the yardstick. "A blouse as sheer as a
black negligee" is one worn blouse, and reading `black` as the sentence moving on emitted an opaque
negligee row that outranked the blouse's sheer one region-wise. Read as a hinge instead, "a blouse
as sheer as a negligee" left the blouse opaque and put the negligee on the body — both halves of one
sentence backwards.

With no noun before the span there is nothing to upgrade and the object is still an object, so "as
sheer as a negligee" alone claims nothing and the free-text caller keeps its covered default.

## A denial is information, not the absence of it

A suppressed noun leaves no row, and for the union path that is the whole story — but "not wearing a
shirt" alone then produced ZERO rows, which is the same shape as prose naming no clothing, so the
free-text caller's covered default dressed an explicitly bared chest.

So the scan reports both sides: `overlayGarmentReads(text)` returns the `worn` rows **and**
`deniedCoverage`, the deduped coverage ids the denied garments claimed. `overlayWornInputs` is a thin
wrapper over the same scan, so the two can never disagree.

**Displacement counts as denial** — "her shirt hanging open" makes the same claim "not wearing a
shirt" does — while an UNMAPPED noun stays out of both halves: nobody knows what a cloak covers, so a
denied one can no more bare a region than a worn one can dress it.

## Worn beats denied, per region

`resolveChatWardrobe`'s free-text read (`overlayTextExposure`) merges the two.

Worn rows reaching an intimate region answer alone (`exposedRegions` verbatim, so a described outfit
naming no shoes still reads barefoot). Otherwise a denial over torso or pelvis answers, with each
region taken from the worn rows where they cover it (a hat or boots keeps its own), BARE where the
denial reached (`exposureRegionsTouched` in `items/visibility.ts`, which answers the region question
while keeping the four-region location table private), and covered everywhere else — a denial states
what is MISSING and says nothing about the rest of the body.

With neither, the read stays silent and the caller keeps its covered default. A bare-state word with
no noun ("not wearing anything") names nothing to bare and lands there too; the archivist's exposure
flag is that beat's channel.

## Where these rows may reach

**These rows only ever reach `exposedRegions`** — never occlusion, garment cues, or the
effective-coverage read ([visibility.md](visibility.md)). Nothing may mistake described prose for a
garment the wardrobe owns.

`deniedCoverage` is bounded the same way and reaches one place further in: only the free-text
exposure read, never the structured union, where prose must never strip an item the wardrobe
actually models.
