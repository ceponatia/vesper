# Creating characters

## The fast path: the forge

1. **Characters → Forge**, describe the person in prose ("a weary harbor-master in her forties, dry humor, bad knee…"). Heritage, profession, age and era cues all feed the attribute inference — the richer the prompt, the better the defaults.
2. The forge drafts three sections independently — profile, attributes, outfit — and each has its own **Regenerate** button. Nothing is saved yet; abandoning the page writes nothing.
3. **Profile** also carries an **Age** field (basic info) — the character's *real* age, a number or free phrase ("ancient", "312 years"). It is deliberately separate from the **Apparent age** attribute (how old they *look*): the narrator reads the real age, while the portrait studio reads apparent age, so a centuries-old being can still read late-thirties on the page.
4. **Attributes**: core visuals (hair color, eye color, skin tone, height, frame, apparent age) are always filled — inferred from the prompt when possible, seeded defaults otherwise. Everything is editable in the attribute picker; AI-filled values carry the `AI` chip until you touch them.
5. **Outfit**: garments that match items already in your library by name link to them; the rest appear under "Suggested new items".
6. **Save character**. Suggested outfit items become real library items automatically (tagged `suggested`, reused by name if one already exists) and land in the character's default outfit. Nothing silently disappears — anything dropped during save shows up as a notice.

## Portraits

On the character page, **Generate avatar** builds the canonical portrait from the saved attributes *and the default outfit* — dress the character before generating, or you'll get invented clothing. Variants (pose / outfit / expression / setting) are identity-locked edits of the avatar; any variant can be promoted to canonical.

## Character chat

Once a character is saved, the **Chat** tab lets you talk to them one-on-one — no world, no session, just a quick way to hear their voice and feel out their personality. **Scenario setup** sets the stage for the conversation: the relationship you start out in, a short premise for the moment, what they're wearing, and which social cards apply. As you talk, the character's mood and how they're warming to you shift in response. When a moment is worth seeing, **Generate scene** paints an image from your recent exchange. Everything here stays in the chat — it never touches the character's saved bio or personality.

## Manual editing

Every forge field is a normal form field; the same editor serves hand-built characters from **Characters → New**. Diagnostics (red = failed, amber = something was dropped/adjusted) appear above the tabs.
