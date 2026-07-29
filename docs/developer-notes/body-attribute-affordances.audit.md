# Body-attribute affordances — promotion readiness audit

Status: detail for
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(code/docs re-verified 2026-07-28)

## Purpose

Record which proposed inputs have authoritative producers today. This is the
baseline for Slice 0; it prevents a coding agent from satisfying a missing
state contract by parsing narrator prose or assigning an optimistic default.

## Capability matrix

| Capability | Legacy character chat | Successor chat | Ruling |
| --- | --- | --- | --- |
| Canonical attributes and realized body locations | Present through shared contracts. | Present through shared contracts. | Safe foundation after attribute-specific vocabulary audits. |
| Hair executable axes | `hair.length`, `hair.texture`, and entangled `hair.quality` exist; density, strand thickness, and structured arrangement do not. | Same shared definitions. | Split/add or conservatively quarantine before profile compilation. |
| Garment structure and current state | Clothing-state slices 0–6 provide chat-scoped instances, part presentation, coverage, wetness/crease gradients, deposits, and damage. Cue flag remains default off. | Clothing-state Slice 7 adapter is not shipped. | Garment affordances may prove against legacy fixtures; no successor parity claim yet. |
| Effective coverage | Structured chat garments produce computed coverage; the free-text bridge remains only for degraded legacy rows. | Existing worn-item reads are coarser; shared garment adapter pending. | Unknown coverage fails closed for hidden/intimate detail. |
| Fine posture and articulation | No authoritative regional pose model. Scene/image posture is text. | No authoritative regional body pose model. | Missing; text is not an input. |
| Body/body and body/surface contact | No typed active contact owner. | No typed regional contact owner. | Missing; reach or prior narration cannot manufacture contact. |
| Support and clearance | No regional support/contact facts. | World space and zones exist, but not furniture/body support or appendage clearance. | Missing for support-, compression-, and clearance-dependent phenomena. |
| Wind, precipitation, and body impulse | May appear in narration/conditions but has no normalized current-cut force read. | Lore/events may mention weather; no general normalized force read for these phenomena. | Missing unless a slice adds an authoritative adapter/owner. |
| Hair/skin wetness and contamination | Coarse conditions may exist; there is no shared regional body-surface state. | Body meters/conditions exist, but no shared regional surface wetness/contamination read. | Missing for production surface phenomena. Synthetic fixtures remain valid. |
| Physiology signs | Existing meter projections expose only a small witness-visible sign vocabulary. General physiology is deferred. | Same body-meter substrate; contact/exposure-specific signs are intentionally absent. | Consume only named existing signs; do not derive swelling, lubrication, sweat, or temperature locally. |
| Persistent body marks and acquired topology | No lane-neutral located body-mark/anatomy-state store. | No general fine-detail anatomy delta store. | Missing; required before persistent marks or missing-digit recognition. |
| Perception | Coverage plus a turn-level sensory allowance; no per-sense proximity/exposure mask. | Witness/channel/detail-tier observations and world perception are stronger. | Shared normalized perception may represent unsupported channels as unavailable, never permissive. |
| Retake boundary | Pre-exchange scenario/state snapshots restore chat state. | Retake re-renders the same committed cut. | Adapters differ; shared output must be captured through the real lane boundary. |
| Observer visual memory | General chat memory exists, not exact visual notice/mention records. | Observations are rebuildable, but no recognition projection exists. | New structured projection required; no RAG-only cooldown. |

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

| Capability | Legacy owner (this release) | Successor | Ruling |
| --- | --- | --- | --- |
| Stable hair structure | Canonical attributes (`hair.length`, `hair.density`, `hair.strand_thickness`, `hair.texture`, `hair.condition`) via `resolveAttributes(profile.attributes, overlays)` | Same shared contracts (static) | Supported after the Slice 0 vocabulary split |
| Structured arrangement | New `hair.arrangement` enum attribute (presentation, mutable); live updates arrive through the archivist `attributeChanges` lane, which already accepts mutable non-inherent attributes | Static authored value only | Supported (legacy); successor has no live update path |
| Hair wetness | New per-character body-surface wetness state on `ChatState` (Slice 4): extraction-proposed, fixed-point, lazy drying on the story clock (garment-condition precedent). Review-round laws (2026-07-28): standing outdoor precipitation **holds** committed wetness (never raises it); a corrupt stored entry is **quarantined** and reads `invalid` — suppressing the domain, never reading as dry — and heals on the next authoritative write; invalid extraction proposals are dropped **and reported** (`chat_surface.proposal_invalid`), never repaired into valid magnitudes | None | Supported (legacy) after Slice 4; successor `unavailable` |
| Wind / precipitation | New scene-level environment read on `ChatScenario` (Slice 4): extraction-proposed typed state | None | Supported (legacy) after Slice 4; successor `unavailable` |
| Hair coverage (headwear) | `garmentEffectiveCoverage` + wardrobe `partVisibility` when the garment lane is armed. Review ruling (2026-07-28): opaque headwear maps to perception `hinted` (ordinary hoods/hats leave ends visible; mechanics still constrain via `coveredFraction`); `hidden` returns for headwear only once a finer coverage read can distinguish full concealment (wrapped headscarf, veil) | Coarser worn projection only | Supported (legacy); unknown coverage fails closed |
| Hair ↔ skin contact | None | None | **Fixture-only** — no typed contact owner exists; reach never invents contact |
| Body impulse events (shake/run/impact) | None | None | **Fixture-only** — no committed impulse owner |

> **Ruled 2026-07-28 (owner):** the missing pose/support/contact/impulse rows
> above get ONE future owner — the shared scene/body-relations state
> (architecture spec §"Scene/body-relations owner"), shipped first in
> character chat and restored with the scenario on retakes. Until it ships,
> every ruling in this table stands unchanged.
| Perception | Wardrobe visibility (`visible`/`hinted`/`hidden`) + turn-level sensory allowance | Witness/channel observations (unused this release) | Normalized perception marks unsupported channels `unavailable`, never permissive |
| Retake boundary | `pre_exchange_state` / `pre_exchange_scenario` anchors; the read is a pure function of rolled-back committed state and its cue/repeat memory rides that state (garment `cueState` precedent), so a retake reproduces the identical read | Immutable narrative cut (deferred with the adapter) | Supported (legacy); successor deferred |
| Recognition memory | — | — | Slice 7; outside this release (slices 0–5) |

### Phenomenon → production status (first hair corpus)

| Phenomenon | Requires | Production status |
| --- | --- | --- |
| `hair.wet_clumping` | structure + wetness (+ arrangement) | Production (legacy) once Slice 4 lands the wetness owner |
| `hair.wind_or_motion_response` | mechanics + current wind or motion | Production (legacy) for **wind** via the environment read; body-motion/impulse input fixture-only |
| `hair.strands_adhere_to_skin` | reach + asserted contact + wetness + exposure | **Fixture-only** (no contact owner) |
| `hair.sheds_droplets` | retained water + committed impulse | **Fixture-only** (no impulse owner) |

### Diagnostic convention for missing inputs

Lane adapters report `supported` / `unavailable` / `invalid` per input (see
"Adapter result law" above). Missing-input diagnostics use stable dotted codes
under the `affordance.` namespace (e.g. `affordance.input.unavailable`,
`affordance.input.invalid`, plus per-phenomenon suppression codes from the
hair spec); conservative fixtures asserting silence + code land with Slice 1.
