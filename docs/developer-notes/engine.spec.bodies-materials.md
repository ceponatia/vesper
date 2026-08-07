# Engine spec — bodies and materials (§25–§26)

Status: companion to [engine.spec.md](engine.spec.md) — §25–§26, bodies and materials.

Part of the [engine.spec.md](engine.spec.md) contract set (split 2026-07-21).
Section numbering is GLOBAL across the engine.spec.* files — cite sections as
"engine.spec §N" exactly as before; the hub's index maps every § to its file. The
normative-keyword rules (MUST/SHOULD/MAY) are defined in the hub.

## 25. Bodies, meters, conditions, and modifiers

### 25.1 Three layers

1. **Substrate:** stored body fact such as reserve, arousal, freshness, condition, or
   capability.
2. **Resolution:** rates, sources, couplings, modifiers, thresholds, and event outcomes.
3. **Read:** pure, total, contextual, perception-gated description or UI value.

Narrators receive reads and relevant causal events, never raw meters by default.

### 25.2 Analytical integration

A continuously changing scalar stores:

- value in fixed-point units;
- lastIntegratedAt;
- base rate;
- active modifier IDs;
- next material threshold.

When queried or when a related trigger is due, integrate piecewise across modifier
boundaries. Schedule only the next material threshold or modifier expiry. Do not tick
every minute.

### 25.3 Modifier engine

All temporary effects SHOULD use one modifier contract:

- source event;
- target path;
- operation such as add, multiply, clamp, override, or rate change;
- stacking group and priority;
- valid interval;
- conditions;
- visibility and provenance.

Overlay-specific paths that bypass ordering or expiry SHOULD be removed.

### 25.4 Couplings

Cross-system effects use an explicit resolver graph. Examples:

- sleep reserve and circadian phase influence energy read;
- illness changes energy rate and capability;
- exertion changes hygiene and fatigue;
- bathing changes freshness and may affect wardrobe;
- stress affects sleep onset but does not directly rewrite history.

Cycles require a declared solution strategy and iteration bound. Hidden mutual writes
between post-turn agents are forbidden.

### 25.5 Rhythm and window crossing

Schedule-driven body support is a current-lane migration aid, not the successor's final
action history.

The owner-approved rhythm body behavior is window crossing: landing at 6am may not cross
the same routine window as landing at 8am. It MUST NOT blanket-restore meals, hygiene, or
sleep. The arrival-covering rhythm outfit behavior is a different function and does not
prove the body algorithm.

inferScheduleKind is a temporary migration adapter. New schedule data MUST use a typed
kind. Unknown text MUST remain unknown and MUST NOT cause hard body or location effects.

## 26. Materials, inventory, and resources

### 26.1 Holding locus

Every material object (item) has exactly one holding locus at any story second:

- **held** — carried by an actor (`actorId`);
- **worn** — on an actor in a named slot (`actorId`, `slotKey`; free-text slot keys in
  v1 — the chat wardrobe's slot vocabulary ports later);
- **container** — inside a container item (`containerItemId`);
- **zone** — resting at a zone (`zoneId`);
- **gone** — terminal: consumed, destroyed, or lost (`basis`).

One holdings row per item (the primary key) is the database-enforced "an item cannot be
in two containers" invariant. `gone` is terminal — no transition leaves it; a
"found again" is a new item (or a later-gate mechanic), never a resurrection.

**Containers are items.** Any item MAY declare a container configuration (capacity,
access policy). Holding chains (item in bag, bag held by actor) resolve to a **root
locus** — an actor or a zone — with a bounded walk (depth cap 8) and cycle rejection at
transfer time. There are no pseudo-container rows for actors or locations; actors and
zones are referenced directly.

### 26.2 Containers

Container capacity is a direct-occupant count in v1 (size/weight classes are headroom,
not schema). Access policy is fail-closed and checked on the **immediate** container at
both ends of a transfer:

- `open` — any co-located actor;
- `holder_only` — only the actor at the chain's root;
- `allow_list` — a named actor set.

### 26.3 Ownership

Ownership is distinct from holding: a nullable `ownerActorId` on the item, changed only
by an `item_ownership_set` event (storyteller principal, or the current owner
reassigning). v1 never physically blocks a transfer on ownership — holding law is
physical, ownership is social. A transfer whose acting actor is not the set owner
records `againstOwnership: true` on the event; consequences land through the E5.5
social ledger, not through movement rejection.

### 26.4 Transfer law

`transfer_item` (v2) names the acting actor, the item, the asserted source locus, and
the destination locus. Validation is fail-closed, in order: branch, actor existence and
control, actor embodied at a zone (§13.2), item extant, asserted source matches current
truth (staleness defense), destination well-formed, **root co-location** (the acting
actor's zone must equal the root zone of both source and destination chains),
person-sovereignty (a source chain rooted at another actor is rejected — no taking from
another's person or worn slots before E5.5 consent; a destination chain rooted at a
co-located other actor is allowed — giving), self-dressing (`worn` destination only on
the acting actor), container access at both immediate ends, destination capacity, cycle
rejection, and no-op rejection (same locus). Scheduled transfers re-validate all of
this at fire time.

Perception: material events derive observations through the §20 rule table (an obvious
manipulation, same-zone sight; a worn-slot change under clothing stays v2 headroom).
The Gate 1 `observedContainerIds` stand-in is deleted with this section's
implementation.

### 26.5 Action resource costs and reservations

`SimulationActionDefinition` gains `resourceCosts`: each cost names a `materialKindKey`
(an authored key on item rows), a quantity, and a disposition — `consume` (destroyed
into the body/world effect at completion) or `use` (required and reserved for the
activity's span; wear/cleanliness effects apply on completion). Starting an activity
selects concrete items deterministically (eligible = extant, matching kind, root-located
with the actor — held first, then at the actor's zone; lexicographic item-id
tie-break), captures the selection on the `activity_started` event, and **reserves**
them exclusively. Reservations are projected from live activity state exactly like
claims (held across every claim-holding phase, released terminally, no separate store —
no orphaned reservation is possible). A transfer, consumption, or destruction of a
reserved item by anyone but the reserving activity's machinery is rejected
(`item_reserved`). Completion re-validates reserved items at fire time before
consuming.

### 26.6 Consumption

`consume_item` (and the completion path of a `consume`-disposition cost) emits
`item_consumed` — the locus moves to `gone/consumed` — with trailing
`body_source_applied` events for each of the item's authored `consumptionEffects`
(meter key, source kind `meal`/`drink`/`adjustment`, operation), causation-chained to
the consumption event and integrated through the §25 kernel in the same transaction
(threshold and collapse alarms retire and re-arm exactly as any body material event).
A meal is a material event with a body effect — one command, one atomic record.

### 26.7 Item condition

Wear and cleanliness are item condition meters on the §25 machinery — the same
fixed-point kernel, registry-as-data, modifier contract, and analytical integration,
under an item-scoped registry (`item-condition-v1`) and item-scoped tables (the body
tables are not reused; the kernel is). v1 registry: `cleanliness` (linear law, zero
at-rest rate; wearing applies a standard negative `rate_add` modifier for the worn
window, so a garment fouls only while worn) and `wear` (no drift; discrete deltas from
`use`-disposition activity completions). Threshold crossings (grimy falling, worn-out
rising) are registry data, alarm through an `item_condition_threshold_due` trigger, and
are witnessed by co-location with the item's root locus when marked noticeable. Raw
item meters never enter a cut; reads are perception-gated like §25.1 layer 3.

### 26.8 Households and membership (E5.4)

A household is a branch-scoped entity representing a shared domestic unit: a named
group of actors who share stores, a residence, and a coarse economic footprint. A
household MUST exist only through a `household_created` event; it is never implied by
co-residence alone.

Membership is a typed relation between an actor and a household
(`household_membership_set`), carrying a role (`resident | dependent | guest`) and a
status (`active | ended`). Role is descriptive in v1 and does not gate stock access on
its own (see below); status MUST be `active` for an actor to draw from the household's
shared stores.

A household declares:

- a `residenceZoneIds` set — the zone(s) where its shared stores and routine live;
- a `stockAccessPolicy` — fail-closed, checked on every command that debits or promotes
  from the household's stores: `members_only` (any actor with an ACTIVE membership row)
  or `allow_list` (a named actor set, for access without membership, e.g. a hired hand).

Every command that debits or promotes from a household-locus material lot (§26.9) MUST
validate, in order: the acting actor is embodied at a zone (§13.2); that zone is a
member of the household's `residenceZoneIds`; the stock access policy admits the actor.
Failure at any step is a rejection, never a silent no-op or partial success — a shared
household store is handled with the same physical-presence discipline as an item
transfer (§26.4), not a remote-banking convenience. Storyteller/system authoring
commands (§26.9's `adjust_material_lot`) are privileged and exempt from this
co-location check, exactly as ruling 4 exempts other privileged commands from ordinary
movement rules.

### 26.9 Fungible material lots and conservation (E5.4)

A fungible material lot is a branch-scoped account: a quantity of one authored
`materialKindKey` resting at one of three flat loci — `household` (a named household's
shared store), `actor` (an actor's personal holding, carried with them, no co-location
check), or `zone` (stock resting at a place, e.g. a shop's shelf). Unlike an item's
holding locus (§26.1), a lot has no container nesting, and a zero quantity is not
terminal — a lot MAY return from zero to a positive balance, and its row persists
indefinitely once initialized (lazily, on first touch, mirroring §26.7's item-condition
meter initialization).

Quantities are integers and MUST NOT be floats. Each authored material kind declares a
`quantityKind`: `fixed_point` (10 000 ≡ 1.0, the §25/§32 convention — used for currency
and any kind whose narrative unit is fractional) or `count` (a plain non-negative
integer — the default for any kind absent from the registry, so an unregistered kind
degrades to the simpler, safer representation rather than failing closed). The reserved
kind key `currency` MUST be `fixed_point`. A lot row captures the `quantityKind` and
registry version that produced it at initialization and MUST NOT reinterpret its stored
raw value under a later registry change (mirrors `BodyMeterState.registryVersion`).

**Conservation law.** Every quantity change is an event. A movement between two lots of
the SAME `materialKindKey` (`transfer_lot_quantity`) is one event whose payload commits
both the source debit and the destination credit — conserved by construction, not by a
separate reconciliation step, exactly as `item_transferred` moves one locus in one
event rather than emitting a paired "removed"/"added" pair. A negative quantity MUST be
impossible — enforced by both the pure resolver (insufficient balance rejects before
any event is built) and a database CHECK on the stored column, so even a projection bug
cannot commit a negative lot.

Conservation applies **within one `materialKindKey`**. An exchange across kinds (buying
food stock with currency) is modeled as two causally-linked boundary adjustments — a
debit of the currency lot and a credit of the stock lot, both `material_lot_adjusted`,
the second causation-chained to the first — not a single conserved transfer, because
the wider market that would balance the OTHER side of the trade is not itself modeled
as a ledger.

A quantity change with no conserving counterparty at all — an authored/storyteller
injection, a promotion's stock debit, a means-band-funded restock's stock credit — is
`material_lot_adjusted`, carrying a `reason`
(`authoring | promotion_cost | restock_purchase | restock_topup_unconserved`) and a
signed delta. This is the lot analogue of a body `source` application (§25.1): an
external application to the modeled economy, not a transfer within it.
`restock_topup_unconserved` is the ONE reason that intentionally breaks conservation as
a matter of design — a means-band-funded restock (§26.11) credits stock with no debited
counterpart anywhere in the ledger, because a low-detail household's "budget" is a
coarse band, not a tracked account. Every other reason either has a causally-linked
counterpart event in the same transaction or is an explicit, audited authoring act.

### 26.10 Means: bands and promotion (E5.4)

A means SUBJECT is an actor, a household, or — E6.3 — a population cohort (§27.6; a
cohort is always band-tracked or unknown, since lot loci never name one). A subject's
means read derives from EXACTLY ONE of two sources, never both blended into one figure:

1. **Lot-tracked** — if the subject has an initialized `currency` lot, the read derives
   from that lot's balance. This is the exact path: a promoted actor, or a household
   whose economy is played at full detail.
2. **Band-tracked** — otherwise, if a `means_band_set` record exists for the subject,
   the read derives from the band alone. Bands are a closed, versioned world-type
   vocabulary (registry-as-data, mirroring the body condition-key vocabulary), ordered
   from least to most means; the read exposes the band and nothing numeric.
3. Absent either, the read is the explicit degraded default `unknown` (resilience.md: a
   diagnostic code, never a fabricated number or band).

Precedence is structural, not a policy toggle: the lot wins whenever it exists. Setting
a means band on a lot-tracked subject is legal (useful for narrative color) but MUST
NOT be consulted by the means read while the lot exists.

**Promotion (§27.2 concretized).** `promote_item_from_stock` is the ONLY way an
aggregate material fact becomes an explicit `sim_items` row. It MUST:

1. validate the acting actor's authority and, for a `household`-locus funding source,
   the §26.8 access preconditions (an `actor`-locus source needs no co-location check
   — the actor's own stock travels with them);
2. resolve funding — either `stock` (debit N whole units of the SAME `materialKindKey`
   the promoted item declares — one unit of a `clothing` stock lot becomes one shirt)
   or `purchase` (debit an authored unit price from a `currency` lot) — and reject
   `insufficient_balance` if the funding lot cannot cover it;
3. sample any detail the command did not supply (e.g. a display name) from an authored
   per-`materialKindKey` pool using a named deterministic stream keyed by the promoting
   command's ID and a purpose label (§6.3) — the stream identity and drawn result are
   captured on the resulting event so replay never re-samples;
4. emit, in one transaction: a `material_lot_adjusted` event (`reason:
   "promotion_cost"`) debiting the funding lot, and a causation-chained
   `item_instantiated_from_promotion` event carrying the full new item shape (§26.1's
   `SimulationMaterialItem`) and its locus;
5. never contradict an existing observation, assertion, or belief about the promoted
   fact — the command's caller (never the narrator directly, per invariant 3.2.4) is
   responsible for supplying any narratively-established detail explicitly in the
   payload, which bypasses sampling for that field entirely.

An item MUST NOT come to exist in `sim_items` by any path other than the branch seed or
this event. The narrator MAY describe an aggregate fact ("there's probably tea in the
cupboard") without promotion; it MUST NOT hand a player or NPC command a concrete item
reference until a `promote_item_from_stock` command has run.

### 26.11 Household restock routine (E5.4)

A household's replenishment of its own stock is deterministic, scheduled routine, not a
per-consumption side effect. `configure_restock_routine` authors, per household and
`materialKindKey`, a target quantity, a low-water threshold, a cadence in seconds, and a
funding source (a `currency` lot purchase, or — for a band-tracked household — a
means-band-gated non-conserved top-up, §26.9's `restock_topup_unconserved`). Configuring
arms a `household_restock_due` trigger through the §12 scheduler at
`now + cadenceSeconds`, keyed by a `household_restock_due:<householdId>:<materialKindKey>`
uniqueness prefix versioned by the arming sequence (mirrors §26.7's threshold re-arm
idiom) — reconfiguring retires any stale pending alarm unconditionally, exactly as a
worn-ness change unconditionally retires cleanliness's prior alarm.

At fire time, `run_household_restock` (system principal, trigger-dispatched) MUST
re-validate: the routine still exists and is active (else the alarm is simply not
re-armed — it was retired by the reconfiguration/removal that superseded it); the
household's current stock is below target (else `household_restock_deferred`, reason
`already_stocked`, and the next cycle re-arms); the funding source can cover the top-up
(else `household_restock_deferred`, reason `insufficient_funds` — a household MAY run
dry, a true and intended failure mode, not silently ignored). On success it debits the
funding source and credits the stock lot to the target quantity in one transaction
(`household_restock_fulfilled`), then re-arms the next cycle at
`fireSecond + cadenceSeconds` regardless of outcome — a deferred cycle keeps trying.

