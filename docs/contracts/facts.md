# Facts

`facts/taxonomy.ts` — a trimmed aionchat taxonomy: `factKindIds` (relationship, knowledge, commitment, attribute_revelation, item, location, event, preference, secret) as a closed enum, extendable by array edit. A fact:

```ts
type FactDraft = {
  kind: FactKind;
  verb?: FactVerb;                           // optional normalized verb (small registry, e.g. "promise",
                                             // "reveal_trait", "show_affection"); invalid → omitted + diagnostic
  subjectName: string;                       // resolver maps → participant/entity
  subjectKind: "character" | "player" | "location" | "item" | "world";
  text: string;                              // one declarative sentence
  tags: string[];                            // lowercase; exact-match keys for lore unlocks
  confidence: number;                        // 0–1
};
```

Lifecycle (`active | superseded | retracted`) and storage live in the db layer; see [memory.md](../memory.md).
