# Gate 0 engine baseline

A versioned, replayable evidence harness for `docs/developer-notes/engine.plan.md` Gate 0.
It runs a fixed corpus through the shipped session/chat prompt builders and the real
narrator provider, then writes enough evidence to compare a later spike without relying
on memory or hand-edited fixtures.

This is a live-spend developer tool and is never part of `pnpm verify` or CI.

## Run

```bash
pnpm eval:engine-baseline --dry-run
pnpm eval:engine-baseline
pnpm eval:engine-baseline --case gate0-locked-door --seeds 1
pnpm eval:engine-baseline --model z-ai/glm-5.2 --seeds 5
pnpm eval:engine-baseline --replay data/eval/engine-baseline/results.json
```

A live run needs `OPENROUTER_API_KEY`. Defaults are deliberately pinned:

- corpus `gate0-baseline-v1`;
- narrator `aion-labs/aion-2.0` (override with `--model`);
- `concise_immersive` prompt shape;
- temperature 0.2;
- three replicates per case.

`--case` accepts a comma-separated exact list. It is the cheap way to rerun one pinned
failure without editing a fixture. `--dry-run` writes `manifest.json` with every full
system prompt, input message, deterministic before/after state and SHA-256 fingerprint;
it performs no model calls. `--replay` re-runs the current deterministic detectors and
summary over saved transcripts without regenerating prose.

## Pinned corpus

The corpus covers a quiet low-stakes exchange, an intimate beat, chat and session
perspective partitions, remote-text register, player-POV sensory grounding, the tracked
state/control pair, and a committed locked-door denial. The denial is important: the
player's prose claims entry and contact, while the authoritative result says the handle
stopped, the player remains in the hallway, and Maya is not co-present. A narrator that
lets the player enter or take her hand has repaired a rejected hard effect.

Cases live in `cases.ts`; their prompt scenarios live in the existing narration
fixtures. The serialized corpus and its hash ride every output file.

## Evidence written per row

`results.json` stores:

- authored expectation and complete input messages;
- complete system prompt plus its hash;
- deterministic state before and after the narration boundary;
- rendered transcript;
- per-leg model, attempted-call count, prompt/completion/total tokens, token source,
  TTFT, total latency, provider, degradation and error;
- deterministic contradiction, perspective-leak, hard-effect-repair and required-cue
  checks;
- explicit nullable manual-review fields for contradiction, perspective leak and
  hard-effect repair.

The summary reports successful rows, attempted model calls, degraded legs, aggregate
tokens, nearest-rank p50/p95 latency, and checked/hit counts for every quality detector.
Degraded rows are excluded from quality rates so provider failure cannot look like a
perfect narrator.

The current adapter intentionally isolates the narration boundary, so its only model leg
is `narrator`. It does not invent token figures for post-turn agents it did not invoke.
The output schema is leg-shaped so a later DB-backed/live-app adapter can add pulse,
memory-scribe, continuity and character-note legs without changing the report contract.

## Quality review

Regexes are sentries, not a prose-quality oracle. They are strong for planted private
tokens, comms grammar and a few positive impossible-action claims, but negation and
paraphrase still require a person. Reviewers fill the three nullable manual fields and a
note in a copy of the result file; replay preserves those fields and summarizes pending
versus reviewed counts.

A spike earns promotion only after baseline and treatment use the same corpus/version,
model/profile/seeds, and blinded transcript review. A detector improvement accompanied by
a new deterministic leak fails the experiment.
