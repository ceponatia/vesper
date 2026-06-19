[← Contracts index](README.md)

# Facts

A fact is one durable thing the game has learned and can later recall — a promise made, a trait revealed, a relationship established. `facts/taxonomy.ts` defines a trimmed aionchat taxonomy.

The **fact kinds** (`factKindIds`) are a closed enum, extendable by array edit:

> relationship · knowledge · commitment · attribute_revelation · item · location · event · preference · secret

A drafted fact:

```ts
type FactDraft = {
  kind: FactKind;
  verb?: FactVerb;
  subjectName: string;
  subjectKind: "character" | "player" | "location" | "item" | "world";
  text: string;
  tags: string[];
  confidence: number;   // 0–1
};
```

| Field | Meaning |
| --- | --- |
| `kind` | One of the fact kinds above. |
| `verb` | Optional normalized verb from a small registry (e.g. `promise`, `reveal_trait`, `show_affection`). An invalid verb is omitted + a diagnostic emitted. |
| `subjectName` | Who/what it's about; the resolver maps this to a participant/entity. |
| `subjectKind` | `character` / `player` / `location` / `item` / `world`. |
| `text` | One declarative sentence. |
| `tags` | Lowercase; exact-match keys for lore unlocks. |
| `confidence` | 0–1. |

The fact **lifecycle** (`active` / `superseded` / `retracted`) and storage live in the db layer — see [memory.md](../memory.md).
