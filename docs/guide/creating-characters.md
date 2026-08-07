# Creating characters

## The fast path: the forge

1. **Characters → Forge**, describe the person in prose ("a weary harbor-master in her forties, dry humor, bad knee…"). Heritage, profession, age and era cues all feed the attribute inference — the richer the prompt, the better the defaults.
2. The forge drafts three sections independently — profile, attributes, outfit — and each has its own **Regenerate** button. Nothing is saved yet; abandoning the page writes nothing.
3. **Profile** also carries an **Age** field (basic info) — the character's *real* age, a number or free phrase ("ancient", "312 years"). It is deliberately separate from the **Apparent age** attribute (how old they *look*): the narrator reads the real age, while the portrait studio reads apparent age, so a centuries-old being can still read late-thirties on the page.
4. **Attributes**: core visuals (gender, hair color, eye color, skin tone, height, frame, apparent age) are always filled — inferred from the prompt when possible, seeded defaults otherwise. Everything is editable in the attribute picker; AI-filled values carry the `AI` chip until you touch them.
5. **Outfit**: garments that match items already in your library by name link to them; the rest appear under "Suggested new items".
6. **Save character**. Suggested outfit items become real library items automatically (tagged `suggested`, reused by name if one already exists) and land in the character's default outfit. Nothing silently disappears — anything dropped during save shows up as a notice.

## Portraits

On the character page, **Generate avatar** builds the canonical portrait from the saved attributes *and the default outfit* — dress the character before generating, or you'll get invented clothing. Variants (pose / outfit / expression / setting) are identity-locked edits of the avatar; any variant can be promoted to canonical.

## Character chat

Once a character is saved, the **Chat** tab lets you talk to them one-on-one — no world, no session, just a quick way to hear their voice and feel out their personality. **Scenario setup** sets the stage for the conversation: a short premise for the moment, what they're wearing (with an intimate-reveal toggle), and which social cards apply. (The **starting relationship** is set elsewhere — a saved profile field on the character editor's **Chat defaults** card that applies to every conversation.) As you talk, the character's mood and how they're warming to you shift in response. When a moment is worth seeing, **Generate scene** paints an image from your recent exchange. Everything here stays in the chat — it never touches the character's saved bio or personality.

## Manual editing

Every forge field is a normal form field; the same editor serves hand-built characters from **Characters → New**. Diagnostics (red = failed, amber = something was dropped/adjusted) appear above the tabs.

## Finishing a half-written sheet

Start typing whatever you have — a bio fragment, a few attributes, three trait
sliders — and let the AI do the rest, from the editor itself:

- **✦ Forge the rest** (top of the editor): completes every *empty* part of the
  sheet from what you entered. It never changes anything you wrote — text you
  typed, attributes and sliders you set, tags you added all stay byte-identical;
  it only adds. Your edits are saved first, and the AI's additions arrive
  *unsaved* so the save bar is your review step (revert discards them).
- **↻ Re-draft tab** (on each content tab): rewrites *that one tab* from the whole
  sheet, formatted for the narrator — e.g. personality prose you left in the bio
  moves into the personality field, or the Attributes tab derives values from what
  your text says. Unlike the Forge, this rewrites the tab's text; attribute and
  trait values you set yourself are still kept (a disagreement shows up as a
  notice instead of a change).
- **◉ From portrait** (Attributes tab, once a portrait exists): a vision model
  looks at the portrait and fills in appearance attributes it clearly shows —
  only blanks, only what's visible; a mismatch between portrait and sheet is
  reported, never applied.
