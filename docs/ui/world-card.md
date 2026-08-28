# The world card

`components/chat/chat-world-card.tsx` — the successor lane's "Where you are" panel, rendered
below the clock card on successor-engine chats only (the `/worlds` front door). It is the
conversation page's only travel surface, so unlike the clock it is **also folded into the phone
Roster sheet**: the desktop right aside is hidden below `lg` and the card has no other mobile
home.

The card renders nothing for a legacy or degraded chat (`world === null` from `GET …/world`) —
an unavailable affordance is hidden rather than shown disabled.

## Where you are

The panel shows the player's place ("At home", "At the town square") or an in-transit line
("Walking to the town square — there in ~4 min"), then each cast member's whereabouts ("Nora —
here with you", "Sable — at the town square").

## Destinations

**Destination chips** follow the skip-chip idiom (`Button size="sm" variant="quiet"` plus a
`~5 min walk` caption row). A tap is **skip-style travel**: the server composes `move` plus a
drain to the journey's earliest arrival, the clock jumps the walk, a toast names the landing in
skip-parity, and the card and state refresh.

A refused move renders the public face — `publicReason` plus legal alternatives — inline. That is
the first real UI consumer of that shape, and every refusal on this card uses it.

Each destination also carries a **"Walk together"** chip beside its "Go to …" chip, rendered
**only when the primary is present** (`cast[].isPrimary` + `present`). A tap invites the co-present
primary to travel together via `move_together` — ONE atomic command that decides, ends the scene,
and creates a single shared journey carrying both, so the pair cannot be stranded mid-move.
Acceptance is NPC agency: a bounded deterministic policy, re-run inside the locked authority view,
accepting unless a body-claiming activity or a firm or hard commitment blocks her. Both walk to
the destination, one `together` world beat lands, and the scene reopens at the far end. Her
decline renders through the same refusal surface ("{primary} can't come with you right now.").

## In your pocket

A row of the player's `held` items, each with a **"Hand to {primary}"** affordance (`give_item` —
the only legal transfer today is player→primary, held→held). The button disables with a muted
"{primary} isn't here to take it." caption when the primary is not present
(`cast[].isPrimary` + `present`), and a handoff writes a `gave_item` world beat.

## Things to do

The branch's zone-gated actions render as skip-style chips ("Rest · ~10 min"). Only `available`
actions show — the seeded rest's `at_zone_kind: home` shows it at home and hides it at the square,
the same affordance-hiding rule the whole card follows. A fresh world seeds a second,
market-gated "Browse the stalls" beside it, plus a third zone — the market, one link past the
square — so the destination and affordance rows both change as you move.

A tap is **skip-style `do_activity`**: start plus a drain through the activity's duration, with
the completion trigger firing inside the drain, writing a `rested` beat.

A claim conflict (resting mid-scene) and an away-primary handoff both surface through the same
refusal surface as a refused move.
