# Bodies

A character's embodied state in the successor simulation: the three-layer
body model, the meters and conditions that live on it, the one modifier
contract every temporary effect uses, the coupling graph between systems, and
the authored daily rhythms — sleep, wash, meal — that give a body a schedule.
Items, inventory, and households are a separate model; see
[materials.md](materials.md), which reuses this same kernel for item
condition and receives a body effect whenever an item is consumed.

## How it works

### Three layers

Every body fact is modeled in three layers, and the boundary between them is
deliberate — it's what keeps a narrator from ever reasoning about a raw
number:

- **Substrate** — a stored body fact: reserve, arousal, freshness, condition,
  or capability.
- **Resolution** — the rates, sources, couplings, modifiers, thresholds, and
  event outcomes that move the substrate.
- **Read** — a pure, total, contextual, perception-gated description or UI
  value.

The narrator receives reads and the causal events relevant to a turn, never a
raw meter by default. A read is total: whatever the
asking context can perceive, it always gets a sensible description, gated by
what that context can actually see — never a leaked number and never a
missing answer.

### Analytical integration

A continuously changing scalar — reserve, arousal, and the rest — stores its
value in fixed-point units, the story-time it was last integrated, its base
rate, the IDs of any active modifiers, and the next material threshold it's
moving toward.

Nothing ticks every meter every minute. The engine integrates piecewise,
across modifier boundaries, only when a value is actually queried or a
related trigger comes due, and it schedules only the next material threshold
or modifier expiry rather than a recurring wakeup. A world with many tracked
actors, each with several meters, would make a per-minute tick prohibitively
expensive for no narrative benefit — nothing observes a meter between the
moments it's asked about or crosses a threshold that matters.

### The modifier engine

A temporary effect on a body fact — a stimulant raising an energy rate, an
injury capping a capability — goes through one modifier contract: a source
event, a target path, an operation (`rate_multiplier`, `rate_add`, or `suspend`
— those three, and no others), a stacking group and priority, a valid interval, conditions, and
visibility/provenance. An overlay-specific path that
bypasses this ordering or expiry is debt to remove, not a second valid
pattern — a modifier that skips the stacking and priority rules is a modifier
whose interaction with every other modifier on the same target is
unpredictable by construction.

### Couplings

Cross-system effects — sleep reserve and circadian phase shaping the energy
read, illness changing energy rate and capability, exertion changing hygiene
and fatigue, bathing changing freshness and possibly wardrobe, stress
affecting sleep onset without rewriting history — run through an explicit
resolver graph. A cycle in that graph needs a declared
solution strategy and iteration bound; a hidden mutual write between two
post-turn agents isn't a degraded version of this pattern, it's the failure
the pattern exists to rule out — two systems quietly rewriting the same fact
in response to each other is exactly the kind of write with no traceable
cause that event sourcing is supposed to make impossible.

### Rhythm and window crossing

An actor's authored daily rhythm is a set of `sim_body_rhythms` rows: a typed
kind, a window in minutes of day, and the actor it belongs to. Rhythms are
seeded like action definitions and copied to a branch's fork children. Three
kinds are live:

- **`sleep`** anchors the circadian pressure curve (see
  [Couplings](#couplings) above). Pressure
  derives purely from the story clock read against the actor's own window and
  is never itself stored.
- **`wash`** rows are window-crossing self-care. A crossing is a
  deterministic clock point folded into the piecewise integration and the
  threshold solver, so landing at 6am and landing at 8am genuinely differ,
  and a crossing can suppress or preempt a pending hygiene threshold. A skip
  credits only the windows it actually crossed.
- **`meal`** rows are routine-controller boundaries (see
  [mind.md](mind.md)'s routine controller), never a crossing credit. A
  background-level actor's routine alarm fires at the window start, and
  eating happens as a real item-consumption event — see
  [materials.md](materials.md).

A wash crossing never blanket-restores meals, hygiene, or sleep — the point
of modeling windows at all is that skipping one has a cost, and a credit that
restored everything regardless would erase that cost. There's no per-day tick
and no per-rhythm trigger: a window is a boundary the threshold solver
already sees, so nothing needs to poll for it separately. Schedule kind is
typed data; there's no text inference over authored schedule prose, and
untyped text never produces a hard body or location effect — a character's
"usually up by seven" flavor text describes them, it doesn't move a meter.

## Invariants

- The narrator sees reads and causal events, never a raw meter — the read
  layer is the only sanctioned crossing point.
- Integration is piecewise and lazy: a meter advances only when queried or
  when a scheduled threshold or modifier expiry comes due, never on a fixed
  per-minute tick.
- Every temporary effect uses the one modifier contract; no system keeps a
  bypass path that skips its stacking, priority, or expiry rules.
- Cross-system effects run only through the declared resolver graph; a cycle
  carries a declared strategy and iteration bound, and a hidden mutual write
  between post-turn agents is disallowed outright.
- Rhythm kind is typed, registry-shaped data, never inferred from authored
  prose, and untyped schedule text can't produce a body or location effect.
- A `wash` crossing credits only the windows actually crossed and never
  blanket-restores meals, hygiene, or sleep.
- `meal` rows are routine boundaries, not crossing credits — a meal's body
  effect always comes from a real item-consumption event, never from the
  rhythm row itself.

## Extending it

The engine keeps **its own** meter and condition vocabulary — `bodyMeterRegistryV1`
and `bodyConditionKeys` in `packages/simulation-core/src/contracts/bodies.ts`,
versioned by `bodyDerivationVersion`. It is deliberately not shared with the chat
lane's registry ([../contracts/meters.md](../contracts/meters.md)): it ported that
lane's semantics, but a package cannot import from the app, so the two are
parallel by construction. Adding an engine meter or condition means editing that
registry array and bumping the version — a code change, not a data edit.
Body-location anatomy ([../contracts/body.md](../contracts/body.md)) is a
separate registry this module does not read. What the engine adds
on top is the substrate/resolution/read machinery in this document: a body
fact's fixed-point representation, the modifier operations that can act on
it, and any coupling edges it needs in the resolver graph.

A new coupling is a new edge on the explicit resolver graph, with a declared
cycle strategy the moment two edges could feed back into each other. A new
rhythm kind extends the typed `sim_body_rhythms` kind vocabulary and needs its
own piecewise-integration and threshold-solver hook — it never falls back to
inferring behavior from authored schedule prose.

## Degradation

Per [../resilience.md](../resilience.md), a body fact degrades rather than
guesses:

- Untyped or unrecognized schedule prose never produces a hard body or
  location effect — the degraded outcome is no effect at all, not a best
  guess.
- The read layer's perception gating means a context that can't see a fact
  gets a total, contextual default rather than an error or a leaked raw
  value.

## Related

- [materials.md](materials.md) — items, containers, consumption, and
  households; where a `meal` rhythm's body effect actually lands, and the
  item-condition meters that reuse this same kernel.
- [mind.md](mind.md) — the routine controller that fires on an actor's
  `sleep` or `meal` rhythm window for background-level actors.
- [../contracts/body.md](../contracts/body.md) — the anatomy and
  body-location registry engine embodiment places facts against.
- [../contracts/meters.md](../contracts/meters.md) — the chat lane's parallel
  continuous-meter and mood model, and the shared meter-id vocabulary.
- [../resilience.md](../resilience.md) — the degrade-over-fail discipline
  this doc's rhythm and read-layer rules follow.
