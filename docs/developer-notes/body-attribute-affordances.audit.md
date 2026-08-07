# Body-attribute affordances — promotion readiness audit

Status: reference (audit run 2026-07-28) — detail for
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md).
A dated snapshot, deliberately not maintained; see §"Changed since this audit"
for the one ruling the code has since overtaken.

## Purpose

Record which proposed inputs had authoritative producers on the audit date.
This was the baseline for Slice 0; it prevents a coding agent from satisfying a
missing state contract by parsing narrator prose or assigning an optimistic
default.

## Changed since this audit

Coarse posture, support, proximity, and active contact gained an owner on
2026-07-31 (details in the plan's §"Dependencies and related plans"). Every
**fixture-only** ruling below that names a missing contact, pose, or support
owner is therefore about wiring now, not about a gap. Body impulse is the
exception: still unowned, so `hair.sheds_droplets` stays fixture-only for the
original reason.

## Capability matrix

Each capability below records the legacy character-chat position, the successor
chat position, and the ruling.

- **Canonical attributes and realized body locations.** Legacy: present through
  shared contracts. Successor: present through shared contracts. Ruling: safe
  foundation after attribute-specific vocabulary audits.
- **Hair executable axes.** Legacy: `hair.length`, `hair.texture`, and
  entangled `hair.quality` exist; density, strand thickness, and structured
  arrangement do not. Successor: same shared definitions. Ruling: split/add or
  conservatively quarantine before profile compilation.
- **Garment structure and current state.** Legacy: clothing-state slices 0–6
  provide chat-scoped instances, part presentation, coverage, wetness/crease
  gradients, deposits, and damage. Cue flag remains default off. Successor:
  clothing-state Slice 7 adapter is not shipped. Ruling: garment affordances
  may prove against legacy fixtures; no successor parity claim yet.
- **Effective coverage.** Legacy: structured chat garments produce computed
  coverage; the free-text bridge remains only for degraded legacy rows.
  Successor: existing worn-item reads are coarser; shared garment adapter
  pending. Ruling: unknown coverage fails closed for hidden/intimate detail.
- **Fine posture and articulation.** Legacy: no authoritative regional pose
  model. Scene/image posture is text. Successor: no authoritative regional body
  pose model. Ruling: missing; text is not an input.
- **Body/body and body/surface contact.** Legacy: no typed active contact
  owner. Successor: no typed regional contact owner. Ruling: missing; reach or
  prior narration cannot manufacture contact.
- **Support and clearance.** Legacy: no regional support/contact facts.
  Successor: world space and zones exist, but not furniture/body support or
  appendage clearance. Ruling: missing for support-, compression-, and
  clearance-dependent phenomena.
- **Wind, precipitation, and body impulse.** Legacy: may appear in
  narration/conditions but has no normalized current-cut force read. Successor:
  lore/events may mention weather; no general normalized force read for these
  phenomena. Ruling: missing unless a slice adds an authoritative
  adapter/owner.
- **Hair/skin wetness and contamination.** Legacy: coarse conditions may exist;
  there is no shared regional body-surface state. Successor: body
  meters/conditions exist, but no shared regional surface
  wetness/contamination read. Ruling: missing for production surface
  phenomena. Synthetic fixtures remain valid.
- **Physiology signs.** Legacy: existing meter projections expose only a small
  witness-visible sign vocabulary. General physiology is deferred. Successor:
  same body-meter substrate; contact/exposure-specific signs are intentionally
  absent. Ruling: consume only named existing signs; do not derive swelling,
  lubrication, sweat, or temperature locally.
- **Persistent body marks and acquired topology.** Legacy: no lane-neutral
  located body-mark/anatomy-state store. Successor: no general fine-detail
  anatomy delta store. Ruling: missing; required before persistent marks or
  missing-digit recognition.
- **Perception.** Legacy: coverage plus a turn-level sensory allowance; no
  per-sense proximity/exposure mask. Successor: witness/channel/detail-tier
  observations and world perception are stronger. Ruling: shared normalized
  perception may represent unsupported channels as unavailable, never
  permissive.
- **Retake boundary.** Legacy: pre-exchange scenario/state snapshots restore
  chat state. Successor: retake re-renders the same committed cut. Ruling:
  adapters differ; shared output must be captured through the real lane
  boundary.
- **Observer visual memory.** Legacy: general chat memory exists, not exact
  visual notice/mention records. Successor: observations are rebuildable, but
  no recognition projection exists. Ruling: new structured projection required;
  no RAG-only cooldown.

## Adapter result law

Every lane adapter reports one of:

- **supported** — parsed authoritative input plus provenance;
- **unavailable** — the lane has no owner or no fact for this cut;
- **invalid** — a trust-boundary value failed parsing, with a bounded
  diagnostic.

`unavailable` and `invalid` suppress dependent phenomena. They never become
dry, uncovered, motionless, in contact, or otherwise convenient defaults.

## Slice 0 exit

Before Slice 1 starts:

1. each phenomenon in the first hair corpus names all required capabilities;
2. every capability maps to an owner/adapter or the phenomenon is explicitly
   fixture-only/deferred;
3. hair vocabulary and structured arrangement have an accepted migration/
   authoring path;
4. both retake adapters identify where the selected physical/perception read
   is captured;
5. the first production lane and the exact second-lane parity claim are
   recorded;
6. missing inputs have diagnostic codes and conservative test fixtures.

## Slice 0 source map (recorded 2026-07-28)

Owner rulings at promotion (2026-07-28): full `hair.quality` refactor with no
legacy preservation (new axes blank on existing characters is acceptable; the
registry-driven character form exposes them for manual authoring); hair
wetness and a coarse scene wind/precipitation read get authoritative chat-lane
owners via the extraction pattern; contact/pose stays unowned this release;
the second domain is **garment wet-state/cling** (skin surface waits for
physiology).

**First production lane: legacy character chat.** Second-lane parity claim:
**fixture-level only** — the successor engine currently provides no
attribute-derived appearance to its narrator, no weather/wind state, and no
body-surface wetness, so a successor adapter would report `unavailable` for
every live input. The successor adapter + cut-capture integration is a named
follow-up, not part of this release; shared calculations stay lane-neutral so
that adapter forks nothing.

### Capability → owner

Each capability below records the legacy owner for this release, the successor
position, and the ruling.

- **Stable hair structure.** Legacy owner: canonical attributes
  (`hair.length`, `hair.density`, `hair.strand_thickness`, `hair.texture`,
  `hair.condition`) via `resolveAttributes(profile.attributes, overlays)`.
  Successor: same shared contracts (static). Ruling: supported after the Slice
  0 vocabulary split.
- **Structured arrangement.** Legacy owner: new `hair.arrangement` enum
  attribute (presentation, mutable); live updates arrive through the archivist
  `attributeChanges` lane, which already accepts mutable non-inherent
  attributes. Successor: static authored value only. Ruling: supported
  (legacy); successor has no live update path.
- **Hair wetness.** Legacy owner: new per-character body-surface wetness state
  on `ChatState` (Slice 4): extraction-proposed, fixed-point, lazy drying on
  the story clock (garment-condition precedent). Review-round laws
  (2026-07-28): standing outdoor precipitation **holds** committed wetness
  (never raises it); a corrupt stored entry is **quarantined** and reads
  `invalid` — suppressing the domain, never reading as dry — and heals on the
  next authoritative write; invalid extraction proposals are dropped **and
  reported** (`chat_surface.proposal_invalid`), never repaired into valid
  magnitudes. Successor: none. Ruling: supported (legacy) after Slice 4;
  successor `unavailable`.
- **Wind / precipitation.** Legacy owner: new scene-level environment read on
  `ChatScenario` (Slice 4): extraction-proposed typed state. Successor: none.
  Ruling: supported (legacy) after Slice 4; successor `unavailable`.
- **Hair coverage (headwear).** Legacy owner: `garmentEffectiveCoverage` +
  wardrobe `partVisibility` when the garment lane is armed. Review ruling
  (2026-07-28): opaque headwear maps to perception `hinted` (ordinary
  hoods/hats leave ends visible; mechanics still constrain via
  `coveredFraction`); `hidden` returns for headwear only once a finer coverage
  read can distinguish full concealment (wrapped headscarf, veil). Successor:
  coarser worn projection only. Ruling: supported (legacy); unknown coverage
  fails closed.
- **Hair ↔ skin contact.** Legacy owner: none. Successor: none. Ruling:
  **fixture-only** — no typed contact owner exists; reach never invents
  contact.
- **Body impulse events (shake/run/impact).** Legacy owner: none. Successor:
  none. Ruling: **fixture-only** — no committed impulse owner.

> **Ruled 2026-07-28 (owner):** the missing pose/support/contact/impulse
> entries above get ONE future owner — the shared scene/body-relations state
> (architecture spec §"Scene/body-relations owner"), shipped first in
> character chat and restored with the scenario on retakes. Until it ships,
> every ruling in this list stands unchanged.

- **Perception.** Legacy owner: wardrobe visibility
  (`visible`/`hinted`/`hidden`) + turn-level sensory allowance. Successor:
  witness/channel observations (unused this release). Ruling: normalized
  perception marks unsupported channels `unavailable`, never permissive.
- **Retake boundary.** Legacy owner: `pre_exchange_state` /
  `pre_exchange_scenario` anchors; the read is a pure function of rolled-back
  committed state and its cue/repeat memory rides that state (garment
  `cueState` precedent), so a retake reproduces the identical read. Successor:
  immutable narrative cut (deferred with the adapter). Ruling: supported
  (legacy); successor deferred.
- **Recognition memory.** Legacy owner: none. Successor: none. Ruling: slice 7;
  outside this release (slices 0–5).

### Phenomenon → production status (first hair corpus)

| Phenomenon                     | Requires                                      | Production status                   |
| ------------------------------ | --------------------------------------------- | ----------------------------------- |
| `hair.wet_clumping`            | structure + wetness (+ arrangement)           | production once slice 4 lands       |
| `hair.wind_or_motion_response` | mechanics + current wind or motion            | wind only; motion is fixture-only   |
| `hair.strands_adhere_to_skin`  | reach + asserted contact + wetness + exposure | **fixture-only** — no contact read  |
| `hair.sheds_droplets`          | retained water + committed impulse            | **fixture-only** — no impulse owner |

### Diagnostic convention for missing inputs

Lane adapters report `supported` / `unavailable` / `invalid` per input (see
"Adapter result law" above). Missing-input diagnostics use stable dotted codes
under the `affordance.` namespace (e.g. `affordance.input.unavailable`,
`affordance.input.invalid`, plus per-phenomenon suppression codes from the
hair spec); conservative fixtures asserting silence + code land with Slice 1.
