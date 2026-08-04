# Affectionate-contact MVP — internal trial results

Status: **Passed. Approved on 2026-08-01 and enabled on 2026-08-02.**

## Decision

The affectionate-contact feature passed its internal trial. It produced a clear improvement in continuity: the story can now remember when a touch begins, keep it in place across later exchanges, and end it when the people separate or the situation changes.

The trial also confirmed that these improvements do not make the narration feel mechanical or force unwanted physical detail into a scene. Follow-on work in the existing contact plan may continue in its approved order. Ideas that were already deferred remain deferred.

Testing uncovered a separate problem in clothing tracking that could have caused the system to forget what a character was wearing. Enablement was held until that problem was fully corrected, reviewed, merged, and deployed. The feature was then enabled on 2026-08-02.

One monitoring item remains open: the first naturally occurring production conversation in which a character clearly ends an ongoing touch should be reviewed.

## What the trial needed to prove

The trial focused on player-visible behavior:

- A touch should remain in progress until something actually ends it.
- Releasing the touch, stepping away, changing scenes, or advancing time should end it cleanly.
- The narration should not invent an impossible touch when the characters are not close enough.
- When clothing is between the characters, the narration should describe the clothing rather than bare skin.
- The affectionate-contact feature should not silently expand into more romantic actions, such as kissing.
- The improved continuity should still sound natural.

## How the trial was run

The same short conversations were tested with the feature disabled and enabled. Each test used a fresh chat with the same character and setting so the results could be compared fairly.

The first round covered six situations. When that round exposed weaknesses, the affected situations were repeated after repairs. The repeated tests were intentionally run at normal rapid chat speed rather than adding a delay that a player would not normally need.

The detailed transcripts, identifiers, timing, internal records, diagnostics, and automated-test results are kept in the [technical evidence appendix](romantic-contact-affordances.trial.evidence.md).

## What players would notice

### An ongoing touch is remembered

In the baseline conversation, the narration could end a touch and then unexpectedly describe it as happening again a few exchanges later.

With the feature enabled, the touch remained in place while the conversation moved to another topic and ended only when the player released it. This was the clearest visible improvement in the trial.

### Stepping away ends the touch

The first attempt exposed a clothing-tracking problem and was not counted as a successful result. After that problem was repaired, the repeated test passed at rapid chat speed.

The system remembered the touch, correctly described the character's shirt between the player's hand and her shoulder, and ended the touch when the player stepped back. It did not bring the touch back later.

### Time passing ends the touch

The first attempt did not create a valid ongoing touch and therefore could not prove what would happen after a time jump.

After repairs, the repeated test passed. The touch began before the three-hour jump, was no longer active afterward, and was referred to only as something that had happened earlier.

### An unreachable touch no longer lands

Without the feature, the narration allowed the player to touch a character across a café counter without first moving close enough.

After repairs, both repeated tests kept the physical distance intact. The attempted touch did not land, and the narration did not move either person merely to make the action possible.

### The affectionate-only boundary held

The test phrase “I kiss her” was not accepted as an affectionate-contact action. Enabling this feature did not broaden its scope into romantic contact that had not been approved for this release.

### Scene changes end contact, but narration can still invent a scene

When the player introduced a desk that had not previously existed in the scene, the system correctly ended the ongoing touch because the situation had changed.

However, the narration still accepted the invented desk and moved the characters there too easily. This is a separate narration and scene-continuity problem. It does not block the affectionate-contact result, but it remains unresolved outside this trial.

### A character ending the touch was not observed naturally

Three live attempts were made to observe a character clearly end an ongoing touch. In each attempt, the character chose to keep the touch in place, so the specific behavior could not be observed in a natural conversation.

The ending behavior passed its dedicated automated tests, including protection against a finished touch reappearing later. Because the live conversation never produced the necessary situation, the first natural production occurrence remains a monitoring item rather than a reason to fail the trial.

## Problems found and corrected

The trial found several defects before enablement:

- Rapid messages could arrive before all necessary scene information was ready. This was corrected and the affected tests passed at rapid chat speed.
- The narration needed clearer guidance when a requested touch was physically out of reach. After that guidance was added, the narration stopped impossible touches without inventing movement.
- A description of an existing outfit could be mistaken for an actual clothing change, causing the system to forget the structured wardrobe. The final correction now requires evidence that a clothing change really happened and that it belongs to the correct person.
- Statements about clothing that are negated, planned, hypothetical, questioned, quoted, incomplete, or about someone else no longer count as completed clothing changes.
- Explicit clothing changes still work, including adding or removing garments, changing to another outfit, and replacing a garment with a different one.

These clothing corrections were reviewed and merged before the contact feature was enabled. They apply consistently to the player, the main character, and other characters in a group conversation.

## Final outcome

The trial passed because the feature delivered the intended continuity improvements without making the writing worse:

- Ongoing touches persist across conversation beats.
- Touches end when the player releases them, someone moves away, time advances, or the scene changes.
- Clothing between the characters is reflected in the narration.
- Physically impossible touches do not land.
- The affectionate-only scope remains enforced.
- The narration remained natural and unobtrusive throughout the enabled runs.

The completed build was deployed on 2026-08-02, and both parts of the feature were confirmed to be enabled in the running application.

## Remaining follow-up

- Monitor the first natural production case in which a character clearly ends an ongoing touch.
- Address the separate narration problem that allows newly mentioned furniture or locations to cause implausible scene changes.
- Continue the next approved contact-plan items in their existing order.

## Supporting record

The [technical evidence appendix](romantic-contact-affordances.trial.evidence.md) contains the complete audit record, including transcripts, test attempts, internal state records, diagnostics, implementation references, and verification details.
