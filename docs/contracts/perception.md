[← Contracts index](README.md)

# Perception

`contracts/perception/` holds the pure rules that answer two questions each turn: **who is present?** and **who perceived what?** (The behavior and engine seams that *consume* these rules live in [perception.md](../perception.md).) This doc covers the shapes and extension points.

## Presence channels (`channels.ts`)

Every participant is classified, relative to the player's scene, into one channel:

| Channel | Meaning |
| --- | --- |
| `sight` | Co-located — full presence. |
| `sound` | Audibility-linked. (Reserved enum slot; the cross-location sound channel is phase 4.) |
| `comms` | Active call/text link — may speak, but not physically present. |
| `absent` | Referenced or remembered only. |

Built by `classifyPresenceChannels` and `buildPresenceRoster`.

## Attention (`attention.ts`)

`deriveAttention({ activity, posture, hint? })` → `{ state, facesAway }` over four states:

> `engaged_with` · `absorbed` · `idle_alert` · `asleep_or_impaired`

`idle_alert` is the neutral/degraded default. The optional `hint` comes from `ItemDefinition.attentionHint` (`absorbing` / `faces_away` / `outward`).

## Salience (`salience.ts`)

Every notable action carries how noticeable it is:

```ts
{ visual: "obvious" | "subtle", audible: "loud" | "quiet" | "silent" }   // default: obvious + quiet
```

A stealth marker lowers salience **only when a concealment target exists**. "Quietly" to a lover is just tone; the same act with her unaware mother present is a sneak.

## Witness matrix (`witness.ts`)

`perceives(observer, salience, mods?)` is the single arbiter: an observer perceives an action if their attention admits its **visual or audible** channel. `mods` stack environmental and per-observer effects — `dark`, per-sense `reduced` / `blocked`, and `proximityOverride`.

## Darkness (`darkness.ts`)

`darknessVerdict(band, ambient.light)` is a v1 keyword heuristic over the daylight `band` × authored `ambient.light`; darkness downgrades visual `obvious` → `subtle`. Per-observer sense impairment derives from conditions (`senseModsFromConditions`, reading `ActiveCondition.senseEffects` or a known label map).

## Proximity primitive (`proximity.ts`)

The tier ladder:

> `distant` → `apart` → `near` → `close` → `contact` → `entwined`

plus scale helpers `defaultEntryTier(scale)` and `distantExists(scale)`. Phase 3 uses only what `sight` needs (co-located ⇒ `sight`); per-pair tracking is phase 4.
