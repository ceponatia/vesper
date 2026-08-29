[← Contracts](README.md)

# Nonvisual sensory presentation

`apps/web/src/contracts/sensory/` holds the presentation owners for touch,
smell, and taste — siblings beside `contracts/visual-state/`, under one shared
presentation architecture (owner ruling 2026-08-22). Each sense keeps its own
observation contract; a routing envelope may carry a sensory channel; the
senses are never collapsed into one generic cross-sensory observation type; and
the shared `AffordanceObservation` carries no channel discriminant. Visual
state stays explicitly visual — these owners sit beside it, not inside it.

## Owns / does not own

- Owns: whether a specific observer can perceive an already-true nonvisual
  fact (each sense's access law), and which perceived facts are worth offering
  to a consumer (the shared selection and its budget).
- Owns: each sense's observation contract (`TactileObservation`,
  `OlfactoryObservation`, `GustatoryObservation`) and its narrator digest.
- Does not own: any truth. Every observation handed to it was resolved by a
  producer from committed state and real owner reads; the owners for that
  state are described in [../character-chat/body-state.md](../character-chat/body-state.md).
- Does not own: visual perception, attention, or narration — see the visual
  material in [../character-chat/visual-memory.md](../character-chat/visual-memory.md).
- Does not own: prose. The only place a nonvisual fact becomes words is the
  server narrator adapter (`server/engine/chat-sensory-cues.ts`), behind the
  default-off `CHAT_SENSORY_CUES` switch.

## Laws

### Routing (the contact seam)

- `routeContactPhenomena` (`contracts/affordances/contact/phenomena.ts`) is
  the only conversion out of the channel-tagged envelope: visual candidates
  adapt into the channel-less core observation the visual-state adapter
  consumes; tactile, olfactory, and gustatory candidates adapt into their own
  sense contracts. Import direction is one-way — contact imports the sensory
  contracts, never the reverse.
- A nonvisual candidate cannot enter visual state: the sense contracts are not
  assignable to `AffordanceObservation`, and the router never places a
  nonvisual channel in its visual result.
- An out-of-vocabulary channel fails closed: withheld from every owner as a
  payload-free suppression with `contact.channel_invalid` (`error`), never
  defaulted to visual.
- A phenomenon is registered only when its complete source → commitment →
  perception path exists; until a producer exists for a phenomenon, it is
  fixture-only.

### Access (per sense, fail closed)

- Tactile: the observer must participate in the qualifying committed contact.
  Visual exposure is irrelevant; proximity admits nothing.
- Olfactory: a real range answer is required, supplied per source as an
  `AdapterRead` by the lane (distance, exposure, permeability, and airflow
  composed by their owners). An unanswered range admits nothing and can never
  read as "odorless" or "clean".
- Gustatory: explicit committed direct oral contact with the qualifying
  surface, matched by locus identity. Proximity alone never creates taste.
  The action/permission scope for the oral contact is enforced where actions
  commit; this owner consumes committed truth only.
- Missing or invalid owner reads are degradations (`warn`); an attested
  refusal — not a participant, out of range, no oral contact — is an answer
  and carries no diagnostic, only its suppression.
- A withheld candidate is payload-free: suppressions carry codes, never the
  observation.

### Presentation (shared)

- One repeat family speaks once, through its strongest member; stronger
  intensity bands outrank weaker ones; exact ties break on the phenomenon id;
  at most `SENSORY_NARRATOR_CUE_BUDGET` cues survive per digest.
- Digests carry structured observations and counts, never prose.
- The owners are stateless: no persisted memory, every cut recomputes from
  committed truth, so retakes restore exactly. Sensory notice/mention memory,
  if it ever exists, lives in its own owner under this package — never
  borrowed from visual state.
- There is no constraints half: a must-not-contradict fence requires committed
  always-perceivable facts, and those need real temperature/texture/source
  owners behind them — a fence built on absent owners would be a claim, not a
  law.

### Narration

- `server/engine/chat-sensory-cues.ts` is the only module that renders
  nonvisual sense facts as words, from digests only. The pipeline may call it
  only when `chatSensoryCuesEnabled()` (`CHAT_SENSORY_CUES`, default off,
  literal `on`, env-only) says so.
- Clauses are verbless noun phrases built from the observation's own semantic
  tags, band, and locus. Only "your" or the digest character's possessive may
  name a participant; an un-nameable participant or an object locus yields
  silence, never an id in prose.
- The rendered block keeps the same strict budget a single digest does, in
  sense order touch → smell → taste — a calibration default, not product law.

## Extension points

- A new sense joins as a new module beside the existing three: its own
  observation contract and access law, composed through the shared
  `composeSensoryPresentation`. Auditory belongs here when a phenomenon
  actually produces one.
- Producers in any domain adapt into the sense contracts; the package never
  imports a producer, so adding a producer touches routing in that producer's
  own layer only.

## Diagnostics

- `sensory.tactile.not_participant` — suppression only; the observer was not
  part of the committed contact.
- `sensory.olfactory.range_unavailable` — `warn` + suppression; no owner could
  answer scent range (detail: `unavailable` or `invalid`).
- `sensory.olfactory.out_of_range` — suppression only; an attested answer.
- `sensory.gustatory.oral_contact_unavailable` — `warn` + suppression; no
  owner could answer what the observer's oral contact touches.
- `sensory.gustatory.no_oral_contact` — suppression only; committed oral
  contact does not touch the tasted surface.
- `contact.channel_invalid` — `error` at the routing seam; an
  out-of-vocabulary channel failed closed.
