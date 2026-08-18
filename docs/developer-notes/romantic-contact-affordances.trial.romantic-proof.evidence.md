# First romantic contact proof — evidence appendix

Status: evidence appendix for
[romantic-contact-affordances.trial.romantic-proof.md](romantic-contact-affordances.trial.romantic-proof.md)
(trial closed — passed 2026-08-18)

The auditable record of the first player-authored romantic contact proof: run
configuration, full identifiers, result codes, evidence entries, durable ledger
rows, and scene projections. No credentials, connection strings, or session
material appear here.

The separate
[affectionate-contact trial appendix](romantic-contact-affordances.trial.evidence.md)
covers the earlier closed trial and is unrelated to this run.

## Run configuration

- **App:** `vesper` on Fly.io, version **209**, image
  `vesper:deployment-01M0B6V3NQRWHQ9N5CX6AZDVKT`.
- **Source:** `main` at `c9d7aed1`; `pnpm verify:full` passed before the deploy.
- **Account:** QA account `uxtest-main@vesper.local`.
- **Character:** Sabrina Vale, id `wdijgtnp5dnosx3or16wwsvv`.
- **Fixture chat:** `qndnm0jrif6n5skvi9qkl3lt`, deleted after the run.

### Flags

Enabled **for the proof window only**:

- `CHAT_ROMANTIC_PERMISSION=on`
- `CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE=on`

**Both reverted after the run.** Production is back to contact actions, physical
constraints, and NPC scene-decision shadow only; NPC authority and romantic
permission are off.

## Results in order

### 1 — no grant, romantic act produced and refused

Input: `I caress your arm.`

| Field       | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| status      | `unresolved`                                                     |
| resultCodes | `contact.locus.arms`, `contact.unresolved.permission_unresolved` |
| evidence    | `adapter:permission.derive (no_answer)`                          |
| rendered    | `[]`                                                             |
| ledger      | empty                                                            |
| contact row | none                                                             |

The producer built a real `actionKind: "romantic"` act and the permission owner
answered it — the first execution of that gate in production.

### 2 — grant seeded by developer override

| Field          | Value                      |
| -------------- | -------------------------- |
| event id       | `jec4mhhz3hkmrkh7ygvz9wgp` |
| standingBefore | `null`                     |
| standingAfter  | `granted`                  |

### 3 — grant present, reach not established

| Field    | Value                                                                |
| -------- | -------------------------------------------------------------------- |
| status   | `unresolved`                                                         |
| reason   | `geometry_unavailable`                                               |
| evidence | `event:permission:jec4mhhz3hkmrkh7ygvz9wgp (granted_romantic_touch)` |

The reach premise rendered and the narrator obeyed it: the character drew her arm
back rather than letting the touch land. Permission passed; geometry refused.
Core physical law 6 (permission and feasibility remain separate) observed live.

### 4 — approach and act in one turn, committed

| Field       | Value                                                                     |
| ----------- | ------------------------------------------------------------------------- |
| status      | `committed`                                                               |
| resultCodes | `contact.locus.arms`, `contact.gesture.caress`, `contact.material.direct` |

Narrator line, verbatim:

```text
- Physical fact: the player's hand caresses Sabrina Vale's arm. That contact is
  true right now — do not narrate it as missed, refused, or still being
  attempted. How Sabrina Vale responds to it is not decided here.
```

The reply wrote the touch as landing.

### 5 — withdrawal while the contact was live

| Field           | Value       |
| --------------- | ----------- |
| standingBefore  | `granted`   |
| standingAfter   | `withdrawn` |
| endedContactIds | non-empty   |

Durable rows, in order:

```text
contact:sk7w4fo7f99kpcpfiabbm01g               | contact_started
permission-override:wxilp4oog090vv0ecjnmf7v5   | contact_ended | reason: policy_withdrawn
```

Scene projection after the withdrawal:

```json
{"version":1,"contacts":[]}
```

The next reply did not continue the touch. Both the active-contact authorization
sweep and the stop-guidance path that filters on the `permission-` event ref
fired for the first time in production.

### 6 — retake

Re-granted, re-established, then regenerated the committing take.

| Field                       | Value                                       |
| --------------------------- | ------------------------------------------- |
| total contact events        | 3                                           |
| duplicate `contact_started` | none                                        |
| active contacts             | 1                                           |
| persisted policy status     | `allowed`                                   |
| persisted policy scopes     | `["romantic_touch"]`                        |
| persisted policy evidence   | names the grant event                       |
| committed motion            | `{band: "sliding"}` from the caress gesture |

## Findings

### F1 — an unresolved refusal renders nothing

With no grant the resolver returns `unresolved` / `permission_unresolved` and
`rendered` is empty, so no narrator line is produced and the reply described the
caress as landing. Only an explicit `attempt_denied` yields a blocking line.

This follows the resolver's own law that unknown is not refused, so it is not a
defect. Its consequence is that the flag governs committed world state rather
than prose. This is the most decision-relevant fact for the rollout ruling and is
written for the owner in the trial report.

### F2 — reach does not survive across turns; bare first names do not resolve

`I walk over to Sabrina.` left no usable proximity, and a caress the following
turn resolved `geometry_unavailable`. Only approach-and-act in one message
committed.

Separately, the bare first name `Sabrina` does not resolve against a roster
character named `Sabrina Vale`; a pronoun or the full name is required.

Both are usability sharp edges outside the contact lane, not contact defects.

### F3 — one prose/state mismatch

The committed material fact was `contact.material.direct` while the reply
described the touch landing "through the soft cotton of the work shirt".
Narration quality, not state correctness.
