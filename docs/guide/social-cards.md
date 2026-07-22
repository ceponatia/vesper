# Social cards

A **social card** is a reusable taboo or social rule. When someone does a social
act — flirts, propositions, shows affection in public, pushes a boundary — a
matching card decides how the people around them react. Cards are a library
entity like characters and items: build one, reuse it, attach it to a character,
share it.

## What a card holds

Open `Social cards → New` (or the inline editor on a character) and you
configure:

- **Kind** — *Social rule* or *Taboo*. This is just an authoring label; the
  mechanics are driven by severity.
- **Severity** (0–100 slider) — how badly the act lands. The editor shows the
  **tier** it falls into live: `0–25` **odd**, `26–50` **disapproval**, `51–75`
  **shunning**, `76–100` **ostracized**. Higher tier ⇒ stronger base reaction.
  You set one severity number; the engine's response curve (the reactor's
  affinity, mood, and traits) scales the actual reaction from there.
- **Triggers** — which **interaction concepts** breach this card. These are a
  fixed vocabulary, not free keywords: `flirt`, `proposition`, `public_display`,
  `physical_affection`, `compliment`, `gift`, `tease`, `insult`, `criticize`,
  `boundary_push`, `jealousy_trigger`, `reassure`, `confide`, `foot_contact`.
  Autocomplete offers the full list. A card with no triggers never fires.
- **Tag overrides** — a per-tag flip. A character carrying a given disposition
  tag reacts *differently* to this card. The canonical example: a `foot-fetish`
  taboo defaults to revulsion, but a character tagged `foot-fetish-positive`
  flips to *enjoy*. Add as many as you like; the first matching tag wins. Each
  override sets the **tag** (canonical tags are suggested, but any free-form tag
  a character carries works — matching ignores case/spacing/underscores), the
  **reaction kind**, an optional **intensity** (1–10; left on *tier base* it
  inherits the tier's ramped intensity), and an optional **reaction hint** (a
  short note of narrator flavour, e.g. "secretly thrilled").

A live preview box shows how the card resolves before the curve: the tier, base
intensity, default reaction, and each tag flip.

## Where cards apply

Cards live **on a character** (the Personality tab, alongside likes & dislikes) —
that character's **own** lines and taboos. When a character reacts, the first card
whose triggers match the act governs the reaction (a bespoke like/dislike resolves
ahead of any card).

## Reusing cards: import & save

Cards are always **copies**, never live links — editing or deleting a library
card never changes a character already using it.

- **Import from library** (on a character's card editor) — search the
  library and drop a snapshot copy in.
- **Save to library** (on an inline card) — promote it to a reusable library row
  so you can import it elsewhere.

## The gallery

The `/social-cards` page is a library grid with **All / Public / Owned** tabs.
Toggle a card **public** to share it; anyone can then **Clone to my library** a
public card to get their own editable copy. Viewing someone else's public card
shows it read-only with that clone button instead of edit controls.
