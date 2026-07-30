# Adult eligibility — technical spec

The coding-agent companion to [adult-eligibility.plan.md](adult-eligibility.plan.md).
The plan owns scope, rollout, and open questions; this file owns the contract shapes,
the resolver law, the storage decision, and the proof points. Owner rulings are recorded
in the plan and in
[romantic-contact-affordances.audit.md](romantic-contact-affordances.audit.md#owner-decisions-needed)
§1; every ruling below is theirs, not this document's.

## 1. The shared schema

Defined **once**, in `src/contracts/eligibility/declaration.ts`, and imported by every
record that stores it:

```ts
export const adultEligibilityDeclarations = ["adult", "minor", "unresolved"] as const;
export const adultEligibilityDeclarationSchema = z
  .enum(adultEligibilityDeclarations)
  .catch("unresolved")
  .default("unresolved");
```

Two record kinds hold it, under the same key `adultEligibilityDeclaration`:

| Record | Schema | Line |
| --- | --- | --- |
| Character | `characterProfileObjectSchema` | `src/contracts/world/profile.ts` (immediately after `age`) |
| Persona | `personaProfileSchema` | `src/contracts/players/persona-profile.ts` (after `intimacy`) |

The persona keeps it despite that schema's deliberate narrow-pick rule (its docblock
omits every field that exists to *voice* a character) because this is not narrator
guidance — it is a gate input, and the gate needs an answer for the second person in
every scene.

**Not in the attribute registry.** Attributes are model-generated, visually inferred,
default-filled, and read by unrelated consumers (the portrait studio reads
`identity.apparent_age`; the appearance summarizer reads the rest). This is
policy-grade authorial metadata that only a human may set, so it is a first-class
profile field.

## 2. Storage: no migration, no backfill

Both profiles ride an existing JSONB `profile` column:

- `characters.profile` — `src/server/db/schema.ts:164` (`jsonb("profile").notNull().default({})`)
- `personas.profile` — `src/server/db/schema.ts:222` (same shape)

Neither column has a per-field DDL shape, so adding a key to the zod schema is not a
schema change. The evidence that **every existing row reads `unresolved` without a
sweep**:

1. Every server read of `characters.profile` goes through
   `parseOr(characterProfileSchema, …)` — 18 call sites across `src/server` and
   `src/app/api`, e.g.
   `src/app/api/characters/[id]/route.ts:59`, `src/server/engine/chat-pipeline.ts:704`,
   `src/server/memory/library-search.ts:132`. Personas go through
   `parseOr(personaProfileSchema, …)` at `src/server/players/persona.ts:50` and
   `src/app/api/personas/[id]/route.ts:38`. A row missing the key hits `.default` and
   reads `unresolved`.
2. `.catch("unresolved")` covers the corrupt case: a row holding `"ADULT"`, `18`, or an
   object self-heals to `unresolved` **without failing the rest of the profile**
   (docs/resilience.md §1). Pinned by
   `src/contracts/world/profile.test.ts` → *"self-heals a corrupt value rather than
   failing the whole profile"*.
3. Writes are shallow merges over a re-parsed current profile
   (`characters` PATCH `route.ts:58-61`; `personas` PATCH `[id]/route.ts:38-44`), and
   the PATCH body uses `partialWithoutDefaults` (`src/server/api/schemas.ts:38-47`),
   which strips `.default()` so an unsent field is never reset. A row that never sends
   the field keeps whatever it had.
4. No new API route. The field rides `characterCreateSchema` / `characterPatchSchema`
   and `personaCreateSchema` / `personaPatchSchema` unchanged — they wrap the profile
   schemas whole.

## 3. Resolver law

`resolveAdultEligibility(input, sink?, path?)` in `src/contracts/eligibility/resolve.ts`.
Pure and total. Input is exactly `{ adultEligibilityDeclaration?: unknown; age?: string }`
— field names match the stored profiles, so a `CharacterProfile` and a `PersonaProfile`
are structurally inputs with no mapping step to get wrong.

| # | Condition | Result | Note |
| --- | --- | --- | --- |
| 1 | declared `adult`, no numeric-minor conflict | `eligible` | the only route to a positive answer |
| 2 | declared `minor` **or** numeric age < 18 | `ineligible` | the declaration never overrides the numeric fence |
| 3 | missing, malformed, or declared `unresolved` | `unresolved` | "we could not ask" ≠ "yes" |
| 4 | parseable **adult** numeric age, no declaration | `unresolved` | age alone is never positive proof |
| 5 | `identity.apparent_age` | *not an input* | structurally impossible to pass |
| 6 | declared `adult` **and** numeric-minor age (stored) | `ineligible` + `error` diagnostic | authoring rejects it up front |

Clause 5 is enforced by the signature, not by discipline: the resolver takes no
attribute channel. A mechanical guard scans the three module sources (comments stripped)
for `attribute` / `apparent` / `portrait` / `appearance` and for any import of the
attribute registry — `src/contracts/eligibility/resolve.test.ts` →
*"the resolver is structurally starved of attribute input"*.

Clause 6's diagnostic: `severity: "error"`, code
`eligibility.declaration_conflicts_age` (`ADULT_ELIGIBILITY_CONFLICT_CODE`), `path` as
supplied by the caller, `context: { age }`.

Only one direction is a conflict. Declaring `minor` on a numeric-adult record is always
allowed — it is the stricter statement, and a number never overrules an author who says
a participant is a minor.

### 3.1 Numeric-minor derivation (a recorded decision)

`isMinorAge` / `lifeStageForAge` (`src/contracts/world/life-stage.ts:140-151`) are
**read, never modified** — the repo-wide fail-open fallback is untouched by ruling.

Their semantics are life-stage *bands*, not a literal `< 18`: only a bare numeral within
`LIFE_STAGE_MAX_HUMAN_YEARS` (120) maps, and the child (0–12) + teen (13–17) bands make
that exactly "below 18" for the shapes they accept. They decline `"17.5"` and `"-5"`,
where a literal reading says minor.

Per the instruction to reconcile toward the **stricter** answer for `ineligible`,
`isNumericMinorAge(age)` is `isMinorAge(age) || (a signed/decimal numeral < 18)`. It can
only ever add `ineligible` verdicts; it never widens eligibility, and it changes nothing
outside this module. Fantasy-scaled ages (`"312"`, `"500"`) and non-numerals
(`""`, `"ancient"`, `"seventeen"`) stay un-minored and therefore stay `unresolved`
without a declaration — which is the whole point of the feature.

## 4. Adapter seam

`src/contracts/eligibility/contact-adapter.ts`, deliberately **outside**
`affordances/contact/`. That layer is domain-neutral and its own
`domain-neutrality.test.ts` polices it; teaching it about profiles, personas, or ages
would end that. Direction is one-way: profiles → eligibility → the contact read.

```ts
adultEligibilityParticipant(id: AffordanceSubjectId, profile: AdultEligibilityInput): AdultEligibilityParticipant
contactParticipantEligibility(
  participants: readonly AdultEligibilityParticipant[],
  sink?: DiagnosticSink,
  path?: string,
): ContactParticipantEligibilityRead
```

Combination rule: **every** participant `eligible` ⇒ `eligible`; **any** `ineligible` ⇒
`ineligible`; everything else — including an empty participant list, meaning the lane
could not say who was in the scene — ⇒ `unresolved`. `not_required` is never produced
here: whether eligibility matters at all is the action kind's business
(`contactActionRequiresAdultEligibility`, `affordances/contact/decisions.ts:63`).

Evidence is one `adapter` entry per participant, `ref: "adult_eligibility:<id>"`,
`detail` = that participant's verdict; the empty case records
`ref: "adult_eligibility", detail: "no_participants"`.

**Nothing wires this into the chat pipeline.** Slice 3 of the romantic-contact plan owns
that.

## 5. File map

| File | What |
| --- | --- |
| `src/contracts/eligibility/declaration.ts` | shared schema, labels, editor option order, deep-link anchor id |
| `src/contracts/eligibility/resolve.ts` | the law, `isNumericMinorAge`, `adultEligibilityConflict`, the diagnostic code |
| `src/contracts/eligibility/contact-adapter.ts` | the `ContactParticipantEligibilityRead` seam |
| `src/contracts/eligibility/index.ts` | barrel (re-exported from `src/contracts/index.ts`) |
| `src/contracts/world/profile.ts` | the character field |
| `src/contracts/players/persona-profile.ts` | the persona field **and** its explicit copy in `personaToCharacterProfile` |
| `src/app/api/characters/route.ts` | POST conflict rejection (before item materialization) |
| `src/app/api/characters/[id]/route.ts` | PATCH conflict rejection (on the merged profile) |
| `src/components/characters/character-editor.tsx` | the control, Profile tab |
| `src/components/personas/persona-editor.tsx` | the control, Profile tab |

## 6. The persona adapter — the load-bearing copy

`personaToCharacterProfile` parses **through** `characterProfileSchema`, which defaults
the declaration to `unresolved`. Omitting the field from that call would therefore
silently demote a declared-adult persona every time a character-shaped consumer took it
— a fail-closed bug no type would catch, because the output would still be a valid
`CharacterProfile`. The field is copied explicitly, and
`src/contracts/players/persona-profile.test.ts` → *"copies the adult-eligibility
declaration explicitly — the default would silently demote it"* asserts both halves: the
value a dropped copy would produce, and the value the adapter must produce instead.

## 7. Authoring surfaces

Both editors get a plain `<Field>` + `<Select>` on their **Profile** tab, options in the
order `Not stated` / `An adult` / `A minor` (default first), driven by
`ADULT_ELIGIBILITY_DECLARATION_OPTIONS` + `ADULT_ELIGIBILITY_DECLARATION_LABELS`. The
`onChange` runs the value back through `readAdultEligibilityDeclaration`, so no cast is
needed and a tampered `<option>` cannot store garbage.

Copy is a statement about the fictional participant and says what it buys, in both
editors: *"…Romantic and intimate framing stays unavailable until everyone in a scene is
declared an adult. Leaving it unstated changes nothing else."* No modal, no prompt, no
interruption — an author who never touches it is unaffected.

The character editor additionally shows an inline `error` when the declaration
contradicts the age (`adultEligibilityConflict(draft.profile)`), which is the same check
the API enforces — so the contradiction reads as a validation error at the field rather
than as an opaque save failure. The persona has no age field and so has no conflict case.

**Deep-link anchor.** Both controls are wrapped in
`<div id={ADULT_ELIGIBILITY_ANCHOR_ID} className="scroll-mt-24 …">`, where
`ADULT_ELIGIBILITY_ANCHOR_ID = "adult-eligibility-declaration"`
(`src/contracts/eligibility/declaration.ts`). This exists **only** as a stable target;
the "blocked romantic action deep-links here" UX is romantic-contact slice-3 work and is
not built. Note the shared `Field` component generates its control id from `useId()`
(`src/components/ui/field.tsx:17`), which is not stable across renders — the wrapper div
is why an anchor exists at all.

## 8. Non-rendering proof points

No prompt builder in the repo serializes a whole profile: every one enumerates the fields
it renders (`buildCharacterChatPromptParts` at `src/server/engine/prompts/character-chat.ts:1571`,
the ensemble sheet at `:2317`, `buildCanonBlock` at `src/server/engine/prompts/sim-render.ts:235`,
the shared section builders in `profile-sections.ts`). There is no `JSON.stringify(profile)`,
no `Object.entries(profile)` loop, and no generic render-every-field helper anywhere in
`src/`. The declaration is therefore inert by construction. Three tests turn that from a
habit into a guarantee:

- `src/server/engine/prompts/character-chat.test.ts` → *"the adult-eligibility
  declaration never reaches the narrator"* — the built prompt is **byte-identical** for
  `adult`, `minor`, and `unresolved`, on the single-character path, the split
  prefix/tail path, and the ensemble roster path; and it still renders the real age.
- `src/server/engine/prompts/sim-render.test.ts` → the same byte-identical pin for the
  successor narrator (`system` and `prompt` both).
- `src/server/authoring/character-fill.test.ts` → `renderSheetConcept` (the
  forge/redraft *input* sheet, `character-fill.ts:46-129`) omits it entirely. The
  authoring model cannot infer a field it never reads.

The player persona reaches prompts through a narrow explicit pick
(`playerPromptSlice`, `src/server/engine/chat-pipeline.ts:2156-2169`, and
`loadSimPlayerPersonaFields`, `sim-exchange.ts:758-774`) — `persona`, `wearing`,
`exposed`, `voice`, `intimacy` only. The declaration has no channel there.

## 9. Preservation proof points

**Forge / redraft / fill.** The LLM section schemas (`profileSectionSchema`,
`buildAttributeSectionSchema`, `outfitSectionSchema` in
`src/server/authoring/character-forge.ts`) do not include the field, so no grounding
function can produce it and `applyCharacterSectionPatch` (`:115`, a shallow spread of
patch keys over the draft) has nothing to overwrite. The three merges all start from
`...base.profile` and name their fields explicitly:

| Path | Function | Behaviour |
| --- | --- | --- |
| Forge section patch | `applyCharacterSectionPatch` | key absent from the patch ⇒ preserved |
| Re-draft (per-tab full re-sync) | `mergeRedraftScope` (`src/lib/character-scopes.ts:33`) | in no scope's owned-key list ⇒ preserved in all five scopes |
| Sheet fill (additive) | `mergeFillDraft` (`src/lib/character-fill.ts:162`) | not enumerated ⇒ inherited from `base.profile` |

Tests: `character-forge.test.ts` (*"survives a section patch untouched"*, *"never
generates the declaration — the model has no channel for it"*, which also asserts each
section patch lacks the key), `character-redraft.test.ts` (*"round-trips an authored
declaration untouched"* through the real demo-mode redraft), `character-scopes.test.ts`
(all five scopes), `character-fill.test.ts` (authored kept, generated never adopted,
undeclared stays undeclared).

**Clones.** `cloneToLibrary` (`src/server/api/clone.ts:26-42`) copies `src.profile` as a
raw JSONB value — whole-object, no field pick — so a valid declaration carries and a
row that never had one reads `unresolved` on the next parse. Pinned in
`src/app/api/library-routes.int.test.ts` (the clone case now creates the source with
`adultEligibilityDeclaration: "adult"` and asserts the copy carries it) and, purely, in
`src/contracts/world/profile.test.ts` → *"round-trips an authored declaration through a
save/read cycle"*.

**Imports.** There is no character/persona JSON-import feature in the repo — clone from
the library is the only copy path. Nothing to wire; recorded so the next reader does not
go looking.

**Public previews.** The declaration is deliberately **not** in
`PublicCharacterProfile`: a foreign viewer sees presentation data only, and that
projection's docblock is explicit that a new field stays private until someone adds it
there. Pinned by *"stays out of the public preview"*. A clone still carries it, because
a clone copies the row, not the preview.

**Scenario / world templates.** No template → cast-participant profile merge exists.
The old World Model's `world_cast.snapshot` copy-on-instantiate was deleted outright in
engine rollout R6 (2026-07-22). What survives today never carries a
`characterProfileObjectSchema`-shaped object: chat **scenario presets** are
`{name, premise, outfit, outfitExposed, socialCards, startingRelationship}`
(`src/app/api/chat-presets/route.ts:20-27`), **supporting cast** is a list of named
extras (`src/contracts/turns/chat-supporting-cast.ts:37-54`), and the successor lane's
`provisionStarterWorld` builds simulation actors that hold no profile — the primary
actor's identity is read straight from the caller's chosen library character
(`src/app/api/successor-chats/route.ts:318`). So the ruling *"a template value must not
override a participant's own declaration"* is satisfied vacuously today: the two never
meet. Any future template surface that carries a profile must re-open this line.

## 10. Validation at the write boundary

`adultEligibilityConflict` is enforced on the two character write paths, returning
`{ error: { code: "eligibility_conflict", … } }` with status 400:

- `POST /api/characters` — checked immediately after body validation and **before**
  `materializeSuggestedItems`, so a rejected create leaves no stray library items.
- `PATCH /api/characters/[id]` — checked on the **merged** profile, not the patch: a
  PATCH that sends only the declaration (or only the age) still has to agree with the
  field it did not send.

Personas carry no age, so no conflict is possible and no persona-route change was needed.

## 11. Test map (clause → test)

| Clause / rule | Test |
| --- | --- |
| 1 declared adult ⇒ eligible | `eligibility/resolve.test.ts` *"clause 1"* |
| 2 declared minor / numeric minor ⇒ ineligible | *"clause 2"* |
| 3 missing / malformed / unresolved | *"clause 3"* |
| 4 adult age without declaration stays unresolved | *"clause 4"* |
| 5 apparent age is never evidence | *"clause 5"* + *"structurally starved of attribute input"* (2 cases) |
| 6 stored contradiction fails closed + diagnostic | *"clause 6: a stored contradiction fails closed with a diagnostic"* |
| 6 authoring rejects the contradiction | *"clause 6: authoring rejects the same pair up front"* |
| stricter numeric reconciliation | `isNumericMinorAge` describe (3 cases) |
| schema default / catch (no migration) | `resolve.test.ts` + `world/profile.test.ts` + `players/persona-profile.test.ts` |
| adapter combination rule | `eligibility/contact-adapter.test.ts` (6 cases) |
| persona adapter copy | `players/persona-profile.test.ts` *"copies the adult-eligibility declaration explicitly"* |
| never in narrator prompts | `prompts/character-chat.test.ts` (4 cases), `prompts/sim-render.test.ts` |
| never in the authoring model's input | `authoring/character-fill.test.ts` |
| forge never generates it | `authoring/character-forge.test.ts` (2 cases) |
| redraft / fill preserve it | `character-scopes.test.ts`, `character-fill.test.ts`, `authoring/character-redraft.test.ts` |
| clone carries it | `library-routes.int.test.ts` (clone case) + `world/profile.test.ts` round-trip |
| not in the public preview | `world/profile.test.ts` |

## 12. Deviations and notes

- **`AdultEligibilityInput` field naming.** The resolver's input key is
  `adultEligibilityDeclaration`, matching the stored profiles, rather than a shorter
  `declaration`. This makes both profile types structurally valid inputs and removes the
  mapper that a call site could get wrong (an incorrect mapping would fail *silently*,
  as `unresolved`, which is exactly the failure this feature exists to prevent).
- **Two write-path changes** were made in existing route handlers to satisfy clause 6's
  "rejected at validation time". No new route was added; the field itself rides existing
  profile persistence.
- **`isMinorAge` is untouched**, as ruled. `isNumericMinorAge` lives in the eligibility
  module and is used by nothing else.
- The declaration is **not** consumed by any lane yet. Until romantic-contact slice 3
  calls `contactParticipantEligibility`, this feature changes no narrated behaviour for
  anyone — which is the plan's fourth success criterion.
