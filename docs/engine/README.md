# The successor simulation engine

The engine is Vesper's event-sourced world model: an authoritative simulation of
places, people, bodies and things that runs on its own clock and hands the
narrator a perspective-filtered view of what just happened. It is the world
authority for **successor chats** — conversations born through the `/worlds`
front door and bound to their own simulated world. The other lane, ordinary
[character chat](../character-chat/README.md), does not run on it.

Nothing here is a plan. These pages describe the engine as it runs today.

## Reading order

| Doc                                        | What it covers                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| [kernel.md](kernel.md)                     | What the engine is: invariants, identity, story time, determinism        |
| [commands-events.md](commands-events.md)   | How change happens: envelopes, authority, persistence, the scheduler     |
| [world.md](world.md)                       | Where things are: places, access and consent, journeys                  |
| [activities.md](activities.md)             | What characters do: commitments, actions, live-scene arbitration        |
| [mind.md](mind.md)                         | How an NPC decides: policy, deliberation, routines, perception          |
| [knowledge.md](knowledge.md)               | What a character knows: beliefs, gossip, relationships, memory          |
| [narration.md](narration.md)               | How state becomes prose: the NarrativeCut, the narrator contract        |
| [bodies.md](bodies.md)                     | Embodied state: meters, conditions, modifiers, rhythms                  |
| [materials.md](materials.md)               | The material economy: items, condition, households, restock             |
| [lod.md](lod.md)                           | Level of detail: how a large world stays affordable                     |
| [boundaries.md](boundaries.md)             | The edges: package boundaries, the numeric contract, deliberate limits  |
| [operations.md](operations.md)             | Running it safely: replay, resilience, security, observability          |

Start with `kernel.md` and `commands-events.md`. Together they are the causal
spine every other page assumes: a command produces events, events project into
state, and story time advances deterministically so the same inputs replay to
the same world.

## Where the normative contract lives

These pages explain the engine. The **normative contract** — the precise
MUST/SHOULD wording, with globally stable section numbers — lives in
`docs/developer-notes/engine.spec.md` and its cluster files.

The two are cited together throughout the codebase. Source comments reference
sections as `engine.spec §N`, and those numbers never renumber, which is what
makes them safe to embed in code. When a page here says what the engine does and
you need the exact rule it is obeying, follow the § citation.

The split is deliberate: a reference page can be rewritten for clarity whenever
it helps, while the numbered contract stays stable for the code that points at
it. Where the two ever disagree, the spec is authoritative and the page is the
one to correct.

## What the engine does not own

- **Character chat.** The legacy lane has its own pipeline, state model and
  prompts ([character-chat/](../character-chat/README.md)). New interaction
  patterns are still proven there first.
- **Registries.** Attributes, meters, conditions, fact kinds and body locations
  are data, defined once in [contracts/](../contracts/README.md) and shared by
  both lanes. Vocabulary changes are edits there, never engine changes.
- **Images.** Scene and portrait rendering is a separate stack
  ([images/](../images/pipelines.md)) that the engine only schedules work for.
