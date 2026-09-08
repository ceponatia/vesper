# Creating characters

## The fast path: the forge

1. **Characters → Forge**, describe the person in prose ("a weary harbor-master in her forties, dry humor, bad knee…"). Heritage, profession, age and era cues all feed the attribute inference — the richer the prompt, the better the defaults.
2. The forge drafts the character's profile, appearance and outfit. Review the result in the editor. The browser keeps your creation draft so you can return to it; the library character is created when you save.
3. **Profile** also carries an **Age** field (basic info) — the character's *real* age, a number or free phrase ("ancient", "312 years"). It is deliberately separate from the **Apparent age** attribute (how old they *look*): the narrator reads the real age, while the portrait studio reads apparent age, so a centuries-old being can still read late-thirties on the page.
4. **Appearance**: core visuals (gender, hair color, eye color, skin tone, height, frame, apparent age) are filled — inferred from the prompt when possible, seeded defaults otherwise. Everything is editable in the attribute picker; AI-filled values carry the `AI` chip until you touch them.
5. **Outfit**: garments that match items already in your library by name link to them; the rest appear under "Suggested new items".
6. **Save character** opens the persisted character on the section you were editing. Or open Portrait studio and choose **Save and open Portrait Studio** to save and go there directly. Suggested outfit items become library items automatically (tagged `suggested`, reused by name if one already exists) and land in the character's default outfit. Anything dropped during save shows up as a notice. A failed save keeps the draft for retry.

## Portraits

On the character page, **Generate avatar** builds the canonical portrait from the saved attributes *and the default outfit* — dress the character before generating, or you'll get invented clothing. Variants (pose / outfit / expression / setting) are identity-locked edits of the avatar; any variant can be promoted to canonical.

Choose **Use this portrait** to establish the character's accepted appearance. Open a reference
image to compare it with that portrait, move between views, and approve or reject it. Unreviewed
references are not used in other images. Rejection can record a reason and an optional correction;
these notes stay with the attempt. They do not change generation prompts.

**History** lets you choose **Use this version** for a retained, compatible image. Restoring it
creates an unreviewed candidate, which needs approval again. Expired or incompatible versions
explain why they cannot be restored.

## Character chat

Once a character is saved, **Chat** lets you start a conversation. **Scenario setup** sets a short
premise, clothing and social cards. Author the player's **starting relationship** under
**Relationships**; it seeds new conversations, while existing stories keep their own relationship.
The narrator model choice lives on Chat and explains its applicability there. As you talk, mood
and regard shift in response. **Generate scene** paints an image from the recent exchange. These
conversation changes do not rewrite the character's saved bio or personality.

## Manual editing

Every forge field is a normal form field; the same creation draft serves hand-built characters
from **Characters → New**. Character sections remain beneath the site navigation while scrolling.
On phones, a section selector keeps the current section visible. On desktop, arrow keys, Home and
End move selection and focus through the tabs. Generation diagnostics are available in
**Generation notes**.

## Finishing a half-written sheet

Start typing whatever you have — a bio fragment, a few attributes, three trait
sliders — and let the AI do the rest, from the editor itself:

- **Complete missing details** suggests additions for the selected section while preserving
  authored values. The sheet completion action applies that rule across the character.
- **Rewrite this section** proposes replacements for the selected section, including manually
  authored values. Other sections and the original creation brief stay intact.
- **Complete using portrait** in Appearance proposes details visible in the portrait and shows
  disagreements with the sheet for review.

Review the before/after changes, then **Accept** or **Reject** the proposal. If you edited the
same detail while generation was running, choose which value to keep. **Undo** can reverse an
accepted change and checks for later edits before applying. Ordinary edits continue autosaving
on saved characters while proposals wait. Saving or starting another AI operation does not
accept a pending proposal.
