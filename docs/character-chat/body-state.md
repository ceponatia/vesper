# Scene environment & body surface

What the chat lane knows about the physical scene and the bodies standing in it: the
chat-wide `environment` (wind, precipitation, indoors) and the per-character
`body_surface` wetness — the two authoritative owners that let the visual layer read
*state* rather than parse prose — plus everything projected from them: the affordance read
and its narrator cue block, recognizable features and visual memory, and the narrator's
physical-consistency constraints and premise checks. Everything else a conversation carries
between exchanges — the state row and the chat-wide scenario, wardrobe, scene memory,
emotional weather, plans, off-screen life, and drives — is in [state.md](state.md).


## Scene environment & body surface

Two authoritative owners the lane simply did not have
(`body-attribute-affordances.plan.md`
· `body-attribute-affordances.audit.md`, slice 4, migration
0091). Both exist so the visual-affordance layer reads *state*, never prose: the law is
that **narrator prose is never parsed at read time** — the continuity extraction leg
proposes typed ops and the fold commits them through `parseOr`, exactly as the garment
lane does.

- **`character_chats.environment`** (`contracts/state/chat-environment.ts`
  `ChatEnvironment`): the scene's `wind` (`none`/`breeze`/`windy`/`gusting`),
  `precipitation` (`none`/`drizzle`/`rain`/`downpour`), `indoors`, and the story minute
  it last CHANGED. Chat-wide like `scene_memory` — one sky for the roster — so it rides
  `pre_exchange_scenario` and rolls back with everything else. **Indoors/still/dry is the
  degraded default**, and `indoors` is a hard zero on both `windForceOf` and
  `precipitationActive`: a downpour seen through a window wets nobody. Weather is
  deliberately NOT a scene-memory detail (that field records durable places).
- **`character_chat_state.body_surface`** (`contracts/state/body-surface.ts`
  `BodySurfaceState`): per-body-location wetness — a fixed-point level, the minute it
  last changed, and what wet it (`rain`/`immersion`/`splash`/`other`). Per character, so
  it rides `storedChatStateSchema` and the `pre_exchange_state` anchor. It **dries lazily
  on the story clock** at a flat rate (saturated → dry in ~3⅓ story hours), the
  garment-condition precedent: reading integrates forward and never mutates, writes touch
  only the locations a proposal named, and `updatedAtMinutes` therefore stays a truthful
  freshness stamp for the cause. **Primary character only** this release — `hair` is the
  one owned location. Two laws about not letting a gap become a physical claim:
  - **Absent, dry, and invalid are three answers.** An absent entry is honestly dry
    (nothing ever recorded wetting it). A stored entry whose `level`/`updatedAtMinutes`
    fails parsing is **quarantined** as `{ status: "invalid" }` — persisted verbatim,
    never pruned, and healed only by the next authoritative write — and
    `bodySurfaceWetnessAt` returns an explicit `invalid` read the caller must handle.
    Repairing it to `0` would be worse than useless: dry hair is *more* mobile than wet
    hair, so a corrupt row would have bought a wind-motion cue. The adapter maps `invalid`
    onto the affordance result law's `invalid`, files `affordance.input.invalid`, and the
    hair domain (for which wetness is structural) falls silent.
  - **Standing outdoor precipitation HOLDS wetness** (`surfaceDryingSuspended` —
    `precipitationActive`, i.e. raining *and* not indoors). Without it a soaked character
    standing in a continuing downpour read bone dry after a few story hours, because
    "unchanged weather" proposes no ops. Holding never *raises* the level; raising still
    requires a committed proposal. The finalize fold applies the environment patch first
    and integrates against the result, so an exchange is attributed to the sky it ends
    under (a documented one-window approximation).
  - **Temporary contact marks** live beside wetness in the same `BodySurfaceState`
    (`marks`, keyed by idempotency identity, `bodySurfaceMarkKinds = ["pressure"]` —
    closed; a stored unknown kind quarantines exactly like corrupt wetness). A mark is
    committed only by the body-surface transaction (`applyBodyMarkProposals` in
    `contracts/turns/chat-contact-effects.ts`) from a `BodyMarkProposal` that contact
    derives from an acknowledged committed touch — firm/moderate pressure with direct
    skin contact, primary character's body only. Marks **fade lazily on the story
    clock** (flat rate; the strongest band is gone in ~30 story minutes), reading never
    mutates, retrying the same causal event cannot double-commit, and the `marks` key is
    absent until the first commit and dropped when the last mark prunes. The commit leg
    is gated by `CHAT_CONTACT_EFFECTS` (off by default, and inert without
    `CHAT_CONTACT_ACTIONS`); the read side projects committed marks into visual state as
    `body_surface.contact_mark` current-state features.
- **The extraction** (`chatArchivistSchema.environment` / `.surfaceWetness`, both on the
  shared continuity leg): a partial weather patch (absent key = unchanged) and a list of
  `{ location, direction, degree 1-3, cause? }`. Semantic, never numeric — the reducer
  owns the delta table and clamps regardless; an unowned location drops with
  `chat_surface.location_unknown`. `surfaceWetness` is carried **raw** on the aggregate
  and parsed per item by `parseSurfaceWetnessProposals`, which drops malformed items and
  reports the count as `chat_surface.proposal_invalid`. `direction` and `degree` are
  strict — the standing law is that **`.catch` is for narration-affecting leaves, never
  for state-mutating magnitudes**, so a hallucinated `degree: 999` fails its item instead
  of being repaired into a real 50% wetness change. `cause` stays lenient (provenance
  only).
- **`character_chats.affordance_cues`** (`AffordanceCueState`): what the affordance read
  has already offered the narrator, and in which band — the garment `cues` precedent. It
  sits on the SCENARIO because the read is a pure function of committed state plus this
  memory (`engine/chat-affordances.ts` `buildChatAffordanceRead`), so restoring both from
  one anchor is what makes a retake reproduce the identical read rather than resolving
  against later weather. Written when the read reaches the prompt; with the narration flag
  off it rides through untouched (never cleared).
- **Narration** (slice 5, behind `CHAT_AFFORDANCE_CUES`, default OFF until the trial run):
  the pipeline takes the read from the committed **pre-fan-out** cut — the drifted state
  row, the ticked scenario, and the wardrobe rows that turn already resolved — and projects
  `read.cues` into at most two short factual clauses ("Wren's auburn hair has separated into
  damp, clinging strands, still wet from the rain") via `engine/chat-affordance-cues.ts`.
  They render as one **attention-only** prompt block after the garment cue block; there is
  deliberately no affordance digest, because the appearance they decorate is already
  authoritative in the Attributes section. Cue projection is the one place `hair.color` is
  read — it is excluded from the domain's required attributes so it can never move a band.
  The block is primary-character-only (it leans on the one Attributes section this prompt
  carries), and `previewChatPrompt` re-derives it read-only, so opening the inspector never
  spends the repeat gate. With the flag off nothing is computed at all and the prompt is
  byte-identical to the pre-feature build (int-tested by splicing the ON block back out).

The adapter itself reports what this lane can honestly answer and refuses the rest:
arrangement/wetness/coverage/wind are owned, while **contact, body motion and
contamination are `unavailable`** — so hair-to-skin adhesion is suppressed by the shared
core before its resolver can read an empty contact list as "nothing is touching", and no
impulse event is ever synthesized. Unknown coverage (no wardrobe read at all) fails
closed: the whole hair read goes silent rather than assuming an uncovered head.

**Coverage constrains what moves; perception only says what an eye reaches.** Worn
headwear maps the `hair` location to exposure `hinted` — opaque *or* sheer — because the
wardrobe's per-location coverage is already partial (`coveredFraction` 0.9 for an opaque
cover, precisely because ends and fringe hang out) and an ordinary hat, cap or hood
genuinely leaves some of the location readable. Mapping opaque to `hidden` had the two
layers contradicting each other and suppressed *every* hair observation under a hat,
including ones coverage does not damp. Genuinely total concealment (a wrapped headscarf, a
veil) should read `hidden`, but that needs a finer coverage signal than the per-location
boolean, so no chat garment produces `hidden` today — the gate itself is unchanged and
still fails closed for an unlisted location (`unknown`).

**The garment domain** (slice 6) rides the same adapter and the same flag. Its wardrobe
normalization lives in `engine/chat-garment-affordances.ts`: worn garment instances, their
blueprint snapshots' materials, presentation-aware per-part coverage, and the condition
gradient's wetness — integrated forward to the story clock *lazily and without writing
back*, so building a prompt can never dry a garment. It answers three reads —
material-dependent wet surface behavior, effective opacity, and wet cling — and refuses the
rest honestly:

- **`contacts` is omitted entirely**, because no lane records garment *fit* and the ruled
  establishment law only lets a `fitted`/`tight` garment claim body contact from wardrobe
  truth. Wet cling is therefore suppressed by the core with `affordance.input.unavailable`,
  exactly as hair adhesion is.
- **`focus` is omitted**, so the domain's closed default blocks every intimate cue
  (`intimate_gated`); the chat lane has no narrative-focus or consent owner yet.
- An **unmodelled** wardrobe means the domain is not run at all — unknown coverage, never a
  bare body.

The read also produces the final **effective-coverage read** (opaque/hinted/exposed per body
location, with contributing garment evidence), and that answer is **captured** onto
`ChatGarmentStore.coverage` rather than recomputed by each consumer — so it rides
`pre_exchange_scenario` with the garments it describes and a retake restores both or
neither. See [../contracts/items.md](../contracts/items.md) §Effective coverage.

**Two narrator cue blocks, one boundary.** `CHAT_GARMENT_CUES` owns garment *state and its
changes* (a placket that came open, a rolled sleeve, the condition band, mud, a tear);
`CHAT_AFFORDANCE_CUES` owns the current derived *visual effect* of that state (water beading
or darkening, opacity, cling). They overlap only at garment wetness, so with both flags on
the pipeline passes the garment ids the wardrobe block already spoke about and the affordance
projection drops its surface line for them.

**The developer preview** (`/chat/:id/inspector`, admin-only) shows the whole staircase
read-only — source inputs → structural profile → mechanics → observations or suppression
reason → perception filtering → selected cue, per domain — computed on demand from the
stored cut and storing nothing (`engine/chat-affordance-preview.ts`; it never persists
`nextCues`, so looking cannot spend the repeat gate). It deliberately ignores the feature
flag and reports its state instead: the question it exists to answer is "why did this cut
say nothing?", which matters most while the flag is off. It does not yet show the
recognition line below — a named follow-up.

### Recognizable features and visual memory

**`chat_visual_memory`** (slice 7, behind `CHAT_RECOGNITION_CUES`, default OFF): what the
player viewpoint has *noticed* about a character's body, and what the narrator has recently
*said* about it. The pipeline projects canonical body truth into per-feature candidates,
scores each against the same perception view the affordance read uses, and appends **at most
one** extra line to that same cue block ("a crooked nose", "the scar across her right
forearm") — standing truth after the physical cues, never competing with them. Contracts in
`contracts/appearance-features/` (what a feature IS) and `contracts/affordances/recognition/`
(what THIS observer can make of it); the lane bridges them in
`engine/chat-recognition-adapter.ts` (pure) over `engine/visual-memory-store.ts`.

- **Scoped to the memory group, not the chat** — PK `(memory_group_id, viewpoint_id,
  subject_id)`, viewpoint = the chat owner. "Continue our history" retains recognition; a
  fresh conversation meets a stranger. `deleteChat` clears the group's rows with its last chat.
- **Two generations per row** (`features` / `features_before` / `applied_message_id`, the same
  rollback guard the state and scenario anchors take): a retake re-runs from the identical
  pre-exchange memory instead of counting the same look twice. There is no event ledger here,
  so one generation of history is what makes the retake law true.
- **Notices persist even when no cue fires.** Looking strengthens recognition; only a cue that
  reached the transcript moves `lastMentionedAt` and starts a cooldown. The commit is a
  serializable value returned by the contract and written only once the exchange settles.
- With `CHAT_AFFORDANCE_CUES` off but this flag on, the affordance read is still built as a
  **perception source only** — its `nextCues` and `coverage` are deliberately dropped, so one
  experiment's flag can never write the other's state.
- **Production-silent today**: the perception view asserts exposure only for garment-covered
  locations and hair, so bare skin (nose, face, forearms) reads `unknown` and recognition fails
  closed — the same shape of missing-owner gap as garment fit above. See
  `body-attribute-affordances.plan.md`
  §Slice 7.

### The narrator's own cue record

**`chat_visual_cues`** (behind each conversation's own visual-continuity switch, default OFF) is the sibling
record for everything `chat_visual_memory` deliberately refuses. Recognition memory holds
what a person could *recognize* — a crooked nose, a scar — and a rolled sleeve, a posture, or
an occupied hand has no business filling it up. That exclusion also left those details with
no cooldown after being mentioned and no record of having been seen, so a recently stamped
sleeve stayed eligible turn after turn and nothing could tell the narrator that an ordinary
detail became *visible* now rather than merely being true now.

Contract in `contracts/visual-state/cue-state.ts`, storage in
`engine/visual-cue-store.ts`. The two records are disjoint: one predicate
(`isMemoryEligible`) decides which answers for a feature, so novelty, the cooldown, and the
mention ledger all follow it and a single cue can never spend both.

- **Keyed by repeat family, not by feature** — both questions it answers are questions about
  the family ("this sleeve's arrangement"), and its stored fingerprint covers every visible
  member of that family, so a change to any of them registers.
- **It counts cuts, not minutes.** "Newly visible" means *not in view at the immediately
  previous cut*. Chat turns move the story clock by wildly varying amounts, so a time
  threshold would call a continuously visible sleeve newly revealed after a long gap and miss
  a coat that came off and back on inside an hour.
- **Seeing and saying are separate events**, exactly as they are for recognition. Every cut
  records what was in view, said or not; only a cue that reached the transcript starts a
  cooldown. A detail in continuous, unchanged view stays quiet; one that reappears or changes
  can earn a beat.
- **Same key and same two-generation retake law** as `chat_visual_memory`, in its own table.
  The counter is why that matters more here: a retake that advanced it twice would make every
  tracked detail read as newly revealed on the following cut.
- **Read either way, written only when the chat's switch is on.** The visual-state shadow reads
  the stored state and ranks against it, so its repetition and newly-revealed counts are real;
  only a conversation with visual continuity turned on commits.
- **A just-said detail leaves the fence for one cut.** The fence otherwise never goes quiet — a
  fact stays contradictable — but a detail the narrator has only just used would otherwise be
  re-presented immediately, and the narrator reads a fence entry as something it may say. The
  ledger of what was spoken, and when, is what closes that loop in the projection rather than in
  prompt wording.

### What the narrator can see

Visibility claims nothing unless it knows the light, the distance, the angle, and whether
anyone is moving; one unknown component suppresses every detail in the snapshot. Distance and
angle come from the scene owner's proximity and facing for the observer/subject pair. Nothing
in the app owns scene lighting or whole-subject motion, so the release **states** a base
value for each (an ordinary lit room, a still scene) and marks it as stated — the marker
rides the evidence on every visible read, one info diagnostic, and the inspector's own panel,
so a stated placeholder can never be mistaken for an observation.

### Narrator physical guidance — constraints and premise checks

The affordance-cue trial closed against volunteering physical detail, so the same committed
truth is now projected the other way round: mostly as what the narrator **must not claim**.
Behind `CHAT_PHYSICAL_CONSTRAINTS` (default OFF) the pipeline compiles two things from the
cut it already has —

- **consistency constraints**, from the hair domain's `hair.bulk_restraint` resolution: a
  braid, a bun, a hood, or a soaking holds the hair's bulk still, and the narrator may not
  write it streaming loose. This is the one phenomenon that emits a `constraint` rather than
  an observation, and it needs no wind: the wind/motion read already computed the same
  restraint but only ever used it as a reason for its own silence, so on a still evening the
  domain knew the hair was braided and nobody was told.
- **premise corrections**, from the current player message: a high-confidence physical claim
  that committed state contradicts (rain when the state records a bath, loose when the style
  is a braid) or cannot support (a claim about an owner this lane could not read). A claim
  counts only in the clause that names the hair — a hair reference in one clause licenses
  nothing in the next, so "your braided hair looks lovely while the curtains go streaming"
  corrects nothing — and a cause word ("a storm", "a pool") is scenery until the same clause
  also says somebody got wet. A clause that names **two** people's hair ("your braid looks
  lovely beside Mira's hair streaming in the wind") corrects nothing either: there is no
  way to tell which head the verb belongs to, and ambiguity is silence.

Both render as ONE binding-tier prompt block with explicit precedence over the general
sensory allowances — see [prompts.md](prompts.md) §"Physical consistency". Wording rules,
the detector's guards, and the verdict laws live in
`narrator-physical-guidance.spec.md`
§"Slice 2".

**A standing fence is stated only when the turn is about it.** A braid is true all day, and
repeating its prohibition on every exchange spends prompt bytes on inventory and risks
priming the very description it forbids. So constraints are compiled only when at least one
relevance signal holds: the message names **this character's** hair (a subject-bound
reference in any span — the claim wording may be absent, "you tuck your hair behind one ear"
is enough), a premise was corrected this turn, something is actually acting on the hair
right now (wind above still air, or falling precipitation), or the turn's sensory beat is
aimed at the hair. No signal means no candidates, no block, and a byte-identical prompt —
with one `guidance.constraint.irrelevant` info diagnostic per withheld fence so the
inspector can explain the silence. Corrections are never gated this way: a correction is
about the current turn by construction.

A bare claim word bound to nobody is **not** a signal. The claim vocabulary is ordinary
English — "river", "pool", "loose", "soaking" — so "it is absolutely soaking wet out there"
is about the weather, and arming a braid fence on it would spend prompt bytes to prime the
very description the fence forbids.

**The two flags share the read and nothing else.** `CHAT_PHYSICAL_CONSTRAINTS` makes the
pipeline build the affordance read when `CHAT_AFFORDANCE_CUES` is off, but cue rendering
**and** the `character_chats.affordance_cues` write stay gated on the cue flag alone — so
running the constraint experiment can never spend or advance the closed experiment's repeat
gate, and the two remain independently measurable. The adapter hands back the committed
facts it derived (`ChatCommittedHairState`: wetness band, single wetting cause, arrangement,
covered fraction, whether a force is currently acting on the hair, and per-owner
availability) rather than letting the guidance layer re-read state, so a fence can never
disagree with the read it accompanies.

**Provenance truth and cue freshness are two different windows.** The 60-minute event
freshness window governs whether the domain may *volunteer* a cause ("still damp from the
rain") — beyond it the hair is simply wet and says nothing about why. The committed cause the
premise fence compares against comes straight off the body-surface entry and lives as long as
the wetness does: three story hours after a bath the hair is still wet *because of* the bath,
and a player blaming the storm is still wrong. It goes `null` when the hair is dry, when the
recorded cause is `other` or absent, or when two causes are live at once (a bath, then rain
on the walk home) — silence, never a guess.

**Nothing is persisted, and that is what makes retakes correct.** Every input is either the
committed cut or the current message text, and both already roll back through
`pre_exchange_state` / `pre_exchange_scenario` and the transcript — so the same take
recomputes identical candidates, identical selection fingerprints, and identical prose for
free. There is no `physical_guidance` row to restore, and adding one would only create a way
for the stored answer and the recomputed one to disagree. (Slice 4's optional
changed-state detail is the case that will need storage, for its cooldown; it has its own
flag and is not built.)

**The developer preview** (`/chat/:id/inspector`, admin-only) shows the staircase read-only —
input authority (which spans of the newest player line were even eligible) → committed state
and per-owner availability → the relevance decision (which signals admitted a fence, or "not
relevant" per constraint) → candidates with their disclosure → what survived the gate and the
budget → the rendered lines. It reports `CHAT_PHYSICAL_CONSTRAINTS` rather than obeying it,
because silence here has six different causes that look identical from the prompt.
