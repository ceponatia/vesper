# Creating characters

## The fast path: the forge

1. **Characters → Forge**, describe the person in prose ("a weary harbor-master in her forties, dry humor, bad knee…"). Heritage, profession, age and era cues all feed the attribute inference — the richer the prompt, the better the defaults.
2. The forge drafts three sections independently — profile, attributes, outfit — and each has its own **Regenerate** button. Nothing is saved yet; abandoning the page writes nothing.
3. **Attributes**: core visuals (hair color, eye color, skin tone, height, frame, apparent age) are always filled — inferred from the prompt when possible, seeded defaults otherwise. Everything is editable in the attribute picker; AI-filled values carry the `AI` chip until you touch them.
4. **Outfit**: garments that match items already in your library by name link to them; the rest appear under "Suggested new items".
5. **Save character**. Suggested outfit items become real library items automatically (tagged `suggested`, reused by name if one already exists) and land in the character's default outfit. Nothing silently disappears — anything dropped during save shows up as a notice.

## Portraits

On the character page, **Generate avatar** builds the canonical portrait from the saved attributes *and the default outfit* — dress the character before generating, or you'll get invented clothing. Variants (pose / outfit / expression / setting) are identity-locked edits of the avatar; any variant can be promoted to canonical.

## Manual editing

Every forge field is a normal form field; the same editor serves hand-built characters from **Characters → New**. Diagnostics (red = failed, amber = something was dropped/adjusted) appear above the tabs.
