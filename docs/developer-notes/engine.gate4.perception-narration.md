# Engine plan — Gate 4: perception, knowledge, narration, and RAG

Status: **CLOSED — 2026-07-19.** E4.1–E4.5 shipped in dependency order (2026-07-18/19,
see §"Gate 4 build order") and the deterministic exit corpus ran green (4 scenarios,
zero model calls, 2 771 pure + 372 integration tests) — which closes the gate per the
owner's 2026-07-18 exit-scope ruling. The one non-deterministic criterion (the live
paired voice/chemistry eval — the only human-in-the-loop check) is deferred to
[deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs and does not hold the
verdict. Both Gate 4-blocking decisions were resolved by the owner on 2026-07-18:
ruling 14 (soft-canon promotion → safe documented auto-promotion; normative wording in
[engine.spec.md](engine.spec.md) §39) and that exit scope.

Part of the [engine.plan.md](engine.plan.md) gate set (split 2026-07-21; one doc per
gate — see the hub's gate index). Sequencing and current status live in
[roadmap.md](roadmap.md) and the hub; normative contracts live in the
[engine.spec.md](engine.spec.md) §-index.

## Gate 4 — perception, knowledge, narration, and RAG

Rough effort: **10–25 developer-days**.

### Deliverables

- observations with channel, witness, evidence, confidence, and source event;
- assertions distinct from events;
- beliefs with holder, provenance, confidence, validity, contradiction, and
  supersedence;
- disclosure and gossip as causal events;
- relationship ledgers derived from witnessed interaction and explicit changes;
- a typed NarrativeCut with must-enact, perceptible, believed, allowed, forbidden, and
  failure-presentation fields;
- perspective eligibility applied before vector ranking;
- memory documents linked back to assertions or events;
- an ArmedEffect confirmation path for speech and other semantic effects;
- a continuity/physics auditor that flags presentation defects but cannot mutate truth.

### RAG migration rule

The vector store indexes eligible representations. It does not decide whether a memory
is true, current, known, or visible. Eligibility is resolved from normalized ledgers
before top-k ranking, and every returned item carries provenance.

### Gate 4 exit

- deterministic tests show zero cross-viewpoint leaks — **PROVEN** (E4.5 corpus EXIT 1:
  cut + serialized prompt input + retrieval swept per viewpoint under knowledge
  asymmetry, similarity cannot widen);
- contradictions and retractions do not leave both claims presented as current truth —
  **PROVEN** (EXIT 2: cross-source contradiction excludes both assertions from recall,
  stances stay labeled with doubt, retraction narrows relationally);
- rerendering the same cut does not create new memories or events — **PROVEN** (EXIT 3:
  full row-count invariance across events, cuts, observations, knowledge, soft canon,
  memory documents, and outbox);
- narrator failures can be retried from the same cut — **PROVEN** (EXIT 3/4:
  `loadPersistedCut` re-reads bit-identical after a failed render, and only explicit
  idempotent confirmation commits);
- added context improves causal enactment without degrading median voice or chemistry —
  **DEFERRED** (live paired eval; owner-gated spend, see below).

Ruled 2026-07-18: the first four (the deterministic corpus) close the gate. The fifth is
a live paired eval and rides the owner-gated spend list — it does not hold the verdict.
The corpus also proves gossip-provenance chains end-to-end (3 hops, per-hop confidence
decay, "who told whom" reconstructible from belief → event → captured chain, retraction
reaching only earshot).

### Gate 4 build order

Like Gates 2 and 3, Gate 4 splits into dependency-ordered targets. The IDs describe
order, not GitHub PR numbers; each stays reviewable on its own and ships to the
long-lived `engine` branch.

1. **E4.1 — perception and observation.** Status: **shipped — 2026-07-18.** The §20
   perception engine: typed `Observation` rows (`sim_observations`, migration 0063) —
   channel, evidence class, fixed-point confidence, detail tier, derivation version
   (`perception-v1`) on every row. One pure rule table (`lib/simulation/perception.ts`,
   exhaustive over the event union so a new event kind cannot ship without a perception
   ruling): participants perceive embodied at full detail; a zone-anchored physical event
   is seen clearly in its zone and only heard across zones of the same location; captured
   payload witness sets are trusted as-is (the action's noticeability profile already
   encoded them — a private activity stays private); engagement events split by channel
   (co-present participants embodied with location-level bystander glimpses, remote
   participants device-only); a co-present speech act can be overheard at its location, a
   remote one cannot; storyteller relocation grants destination-zone glimpses only —
   never the mechanism (ruling 4); scheduler/commitment bookkeeping derives nothing.
   Every command transaction now ends by deriving observations against the post-command
   locus rows (the §11.1 shell hook covers all shell stores; the pre-shell space and
   item-transfer stores got the same one-line hook), and replay grades each command's
   events against its group-final space folded through `applySpaceEvent` — live and
   rebuilt rows are identical by construction, proven bit-for-bit in the int suite and
   wired into `forkBranch` (a mid-journey fork carries exactly the observations its
   inherited history explains). The E3.5 interim witness rule is DELETED: `compileGate3Cut`
   takes `viewpointObservations` and re-decides nothing about witnessing (corpus green
   unchanged), and the E3.3 knowledge gate's new `observed` member fires notice only for
   an actor holding a real observation of the named event — fails closed otherwise.
   9 pure + 4 integration cases; CI runs `test:engine-e4-1`. Delivery notes:
   confidence/tier constants are deliberately coarse (graded by how evidence arrived, not
   who witnessed — impairment/lighting/distance refine under a bumped derivation
   version); `activity_interrupted`/`activity_resumed` grade participants only until a
   command emits them; `touch`/`smell`/`social` channels and `reported`/`inferred`
   evidence classes are reserved vocabulary for E4.2 gossip; the legacy Gate-1
   observed-containers mechanism still feeds `ItemTransferObservation` for the Gate 1/2
   proofs — typed rows now derive alongside it, and folding it in is a later cleanup.
2. **E4.2 — assertions, beliefs, disclosure, and gossip.** Status: **shipped —
   2026-07-19.** The §21 knowledge substrate: `sim_assertions` + `sim_beliefs`
   (migration 0064) with provenance (basis observations, learned-from chains capped at
   16 hops), validity intervals stored for E4.4, and both status machines
   (assertion: active/contradicted/superseded/retracted; belief:
   active/doubted/rejected/superseded) as exported transition tables. A new
   `disclosure_made` causal event (family "knowledge", distinct from the narrator-lane
   `speech_act_delivered` effectType — E4.3 bridges them) carries a typed content union
   — original **claim**, **relay** (a gossip hop), **retraction** — plus a §6.4
   captured-derivation block (assertion id, teller confidence at speaking time,
   provenance chain), emitted by the new `make_disclosure` command (`knowledge-store`,
   §11.1 shell; channel ruling: co-present only when speaker and every listener share a
   location, else device and unoverhearable). Both ledgers are DERIVED like §20
   observations: the shell's `recordCommandKnowledge` step (in `knowledge-recorder`,
   split from the store so the shell imports acyclically) folds each disclosure through
   the pure kernel (`lib/simulation/knowledge`) against the observation rows written
   moments earlier, and `forkBranch` replays the identical fold — live and rebuilt rows
   proven equal in the int suite. Perception ruling: named listeners receive content as
   the reserved `social`/`reported` class (tier 3 co-present at 9 000, tier 2 remote at
   8 500); the belief fold keys off exactly that class, so the speaker (direct) and
   muffled bystanders (sensory) form no belief. v1 belief rules, coarse and tunable
   under a bumped `knowledge-v1` derivation version: relays cost a flat 1 000; belief
   confidence = min(how well heard, teller confidence − hop cost); re-hearing supersedes
   and keeps the higher confidence; a contradicting claim flips a holder only with
   strictly higher confidence, else enters doubted; cross-source conflicts contradict
   BOTH assertions (neither presents as current truth), same-source changes supersede;
   retraction rejects only the beliefs of listeners who heard it — everyone else keeps
   believing; no self-beliefs (a liar asserts what they do not believe). The E3.3
   knowledge gate widens with `asserted` (live belief in the named assertion) and
   `believed` (the named row, live and the actor's own) members, all failing closed;
   §21.3 ships as the typed evidence seam — `deriveRelationshipEvidence` +
   `summarizeRelationshipDyads` map speech acts, disclosures, and completed engagements
   to dyadic evidence entries (the persisted promises/favors/debts ledger stays Gate 5).
   13 pure + 5 integration cases; CI runs `test:engine-e4-2` (2 733 pure + 360 int
   green).
3. **E4.3 — NarrativeCut v2, narrator integration, and soft canon.** Status:
   **shipped — 2026-07-19.** The full §22.1 contract replacing the Gate 3 deterministic
   subset: `speakerBeliefs` (the viewpoint's live E4.2 beliefs joined to their
   assertions — voiceable, possibly false), `perceptibleNow` as E4.1 evidence views
   with event kinds, `currentActivities` (co-located claim-holding), typed
   `forbiddenClaims` (the §22.2 code vocabulary plus contextual absent-participant
   bans), `failurePresentations` (§14.4 public faces, caller-supplied from command
   rejections), `creativeLicenses` (ambient/inner-monologue/small-talk plus
   `established_detail` reuse of live soft canon), `allowedTransitions` (observed soft
   beats — winding-down, resumptions, past speech — portrayable, never required), and
   per-field `provenance` refs. Cut rows persist immutable in `sim_narrative_cuts`
   (migration 0065): rerender and ruling-8 retry are `loadPersistedCut` — a pure read
   proven to create nothing — and a same-id different-hash write throws the §22.3
   version diagnostic (cut ids now include the story-time bounds so quiet back-to-back
   turns never collide). §23.1 ships as `parseNarratorResult` (`parseOr`, empty-result
   default, proposals stamped with the cut id at the boundary — a model never cites
   itself) and the §23.2 auditor (`auditPresentation`): deterministic and structural,
   it checks DECLARED beat/effect ids against the persisted cut, bridges ≤2 missing
   hard beats from their neutral summaries, sends empty or beat-blind prose back for
   rerender, and can mutate nothing. `confirm_narrator_result` v2 confirms by ID
   against the persisted row (unknown ids ignored, unenacted effects expire, only the
   engagement's newest cut is confirmable — older cuts reject `cut_superseded`), and
   the E4.2 bridge is live: an enacted armed `disclosure_made` carrying typed content
   appends a real §21 knowledge event, so narrator-spoken gossip lands in the belief
   ledgers with full provenance (capture failure degrades to the speech act alone).
   §23.4 soft canon ships under ruling 14: `sim_soft_canon` is a bounded expiring
   store of §6.4 snapshot-derived rows (fork replay bit-identical, proven in the int
   suite); proposals pass wrong-cut/confidence/value-size/subject-containment/
   conflict/duplication/scope-bound checks (rejection is a diagnostic, never a failed
   turn); reuse across the ruled number of distinct committed cuts (default 3)
   auto-promotes through an audited `soft_canon_promoted` event carrying provenance
   and the firing thresholds, and `demote_soft_canon` (storyteller-only, ruling 4)
   retracts without touching history. Every knob is a versioned world-type value in
   the `soft-canon.ts` registry with tuning rationale documented inline. The §19.3
   seam ships as the pure admission/outcome kernel (`lib/simulation/deliberation`)
   wired into `prepareEngagementTurn` for multi-candidate departures: gates checked in
   spec order, opaque bounded candidates, injected deliberate/timeout, rationale
   recorded on the turn, and refusal/timeout/nonsense all landing on the
   deterministic earliest-boundary fallback — stub-exercised, zero live calls.
   30 pure + 4 integration cases; CI runs `test:engine-e4-3` (2 763 pure + 364 int
   green). Delivery notes: the auditor is structural (it audits declarations, not
   semantics — model-graded forbidden-claim detection is an owner-gated spend item);
   scene-scope soft canon validates against engagement participants, so a scene
   entry's lifetime is its TTL rather than its engagement; persisted cuts are not
   copied by forks (presentation artifacts — a retaken scene re-prepares).
4. **E4.4 — RAG eligibility and memory linkage.** Status: **shipped — 2026-07-19.**
   The §24 retrieval redesign. `sim_memory_documents` (migration 0066) holds REDACTED
   recall representations — never authority — each carrying source id/kind, the
   originating event, branch + sequence interval, an eligibility surface (`public`,
   fixed `actors`, or `belief_holders` resolved relationally at query time), validity/
   supersedence intervals, deterministic template text (no model), a nullable pgvector
   embedding, and doc-schema + embedding-model versions. Indexing is outbox-driven
   (§24.3): every accepted command enqueues one `memory_index` obligation per
   knowledge-lane or observed event (the §11.1 shell hook, plus the same one-line hook
   in the pre-shell space and item-transfer stores) through the generalized outbox
   claim/release lane; the consumer projects documents from persisted source rows —
   observation docs graded by evidence (glimpses carry no names, spoken content only
   ever enters participant-eligible speech-act and holder-eligible belief docs),
   assertion docs recallable only by live belief holders, soft-canon docs scoped by
   their subjects (world/location scope public) — and re-projects rows a disclosure
   superseded so their documents pick up supersedence. The embedding seam is injected
   (`MemoryEmbedder`, stub-exercised, zero live calls); an embedder failure still
   indexes text-only and shows up as `unembeddedEligible`, and outbox lag is exposed
   through `memoryIndexLag` + on every query result (§24.3 — degrade visibly, never
   widen). `queryMemoryDocuments` runs §24.1 steps 1–7 in order: authenticate
   world/branch/viewpoint (a viewpoint with no locus errors), R4 ancestry bounds with
   nearest-branch dedupe (a fork child's re-indexed copy of an ancestor doc wins),
   relational eligibility and validity — belief/assertion/soft-canon docs re-check
   the QUERY branch's live ledger rows, so a child that diverged recalls its own
   truth — then structured filters, then deterministic in-app ranking (same-model
   cosine, else token-overlap lexical, else recency; round-robin diversification
   across source kinds) inside the eligible set only, with provenance + epistemic
   label (`observed`/`glimpsed`/`heard_about`/`believed`/`claimed`/`witnessed_speech`/
   `established_detail`/`authored_lore`) on every result. Authored lore ships as
   seeded documents with explicit visibility; `rebuildMemoryIndex` reproduces the
   derived index (lore preserved). 8 pure + 4 integration cases (privacy sweeps prove
   a bystander recalls talking-not-content and that the right query text or embedding
   never widens a stranger's recall); CI runs `test:engine-e4-4` (2 771 pure + 368 int
   green). Delivery notes: dialogue episodes index per speech act — model-written
   episode compression stays a §23.4 post-turn concern; ranking is in-app over a
   bounded relational candidate set (SQL-side HNSW is a later optimization; no vector
   index shipped); the Gate-2 soak's queue-depth proof and E2.3 assertions are scoped
   to the item-transfer lane the soak pumps, since the memory lane has its own lag
   diagnostics; principal-level auth on queries rides the server seam until a public
   API needs more.
5. **E4.5 — the Gate 4 exit corpus.** Status: **shipped — 2026-07-19; the corpus is
   green and Gate 4 is CLOSED** (per the 2026-07-18 exit-scope ruling). Four
   deterministic scenarios (`gate4-corpus.int.test.ts`, zero model calls, CI runs
   `test:engine-e4-5`): **EXIT 1** — cross-viewpoint leak sweep with knowledge
   asymmetry over a four-actor world (confidant, speaker, same-location bystander,
   remote outsider): the secret appears in the knowers' cuts and recall, never in a
   non-knower's cut (the serialized cut being the narrator's prompt input), and
   directly querying for the secret widens nothing; **EXIT 2** — cross-source
   contradiction contradicts both assertions (neither recallable as current truth,
   the holder's stances labeled with the weaker marked doubted) and retraction
   removes claim and belief relationally, leaving exactly the surviving doubted
   stance in the next cut; **EXIT 3** — rerender-creates-nothing proven as full
   row-count invariance across all eight persistence surfaces while re-reading the
   persisted cut, parsing a narrator reply, and auditing it; **EXIT 4** — retry-from-
   the-same-cut re-reads bit-identical after a simulated render failure, with commit
   only through the idempotent confirmation; plus the gossip-provenance sweep — a
   3-hop chain (co-present → co-present cross-zone → device cross-location) decaying
   9 000 → 8 000 → 7 000, the route reconstructible from belief → hop event →
   captured §6.4 chain, recall voicing "heard through A then B then C", and a
   retraction reaching only its earshot while downstream believers keep the old
   story. The fifth exit criterion (live paired voice/chemistry eval) is the only
   human-in-the-loop item and is deferred to
   [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs.

E4.2 consumes E4.1's observations; E4.3 consumes both; E4.4 consumes the E4.1–E4.3
ledgers and the persisted cuts; E4.5 closes the gate. Deferred design notes: pressure
acknowledgment and the resumed-activity re-arm (E3.4 notes) were not demanded by any
E4.3 scenario and **carry to Gate 5** as planned.

