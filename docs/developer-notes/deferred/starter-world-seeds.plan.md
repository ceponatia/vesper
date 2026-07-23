# Seed the life the engine already supports

Status: draft (stub — successor-engine backlog item B8, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

The engine machinery is built but `starter-world.ts` seeds none of the data that
would exercise it: no commitments, no meal items, no extra zones/actions, no
lore memories. The ruling-21 vignette collapses to "she is at home and stays
there," `eat_meal` is always illegal, and RAG recalls nothing on turn 1. The
standout cheap win — pure data, zero engine code. (S)

## Why it matters

Most of the living-world machinery already exists and is simply unseeded;
seeding it instantly gives the vignette real MUSTs and `decideDepartures`
something to act on.

## Sketch

Seed 2–3 `create_commitment`s on the primary (a midday obligation at the square,
a soft evening plan), a third zone + second link + second action definition, a
consumable food item (un-breaks `eat_meal` at any LOD), and a handful of
authored-lore memory documents (the keepsake's meaning, backstory beats) via the
existing `authored_lore` projector. Pairs with
[primary-lod-ruling.plan.md](primary-lod-ruling.plan.md) — seeds give the
vignette MUSTs regardless of how the LOD ruling lands.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
