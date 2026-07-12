# Chat scene fidelity — followups

Post-ship fixes for [chat-scene-fidelity.plan.md](chat-scene-fidelity.plan.md)
(shipped 2026-07-10).

## 2026-07-10 — player references in composer pose/activity text (owner report)

A live render prompt carried `Pose: Walking beside the player, one hand resting on his
arm, head turned slightly toward him with a bright, teasing smile.; Leading the player
back toward the main gallery…` — the POV rule keeps the player out of frame, but the
composer's pose text still *anchored on* him (the old rule forbade describing the
player, not referencing him), handing the render an unpaintable instruction. Also
visible: the `.; ` stitch (pose's trailing period + the `"; "` join) and redundant
facial beats split across pose ("teasing smile") and activity ("mid-laugh").

Fixes, all in `images/prompts.ts`:

1. **Composer rule + worked example** (`SCENE_COMPOSER_SYSTEM`): every
   pose/activity/action phrase must describe the character ALONE — player-directed
   beats translate to their solo visual equivalent (gaze → "toward the viewer";
   touching/leading → the character's own posture and motion; keep the expression,
   lose the contact), with the reported gallery beat as the worked example. Pose and
   activity must not repeat each other's beats (one facial expression, stated once,
   in pose).
2. **Deterministic backstop** (`scrubPlayerFromAction`, applied in `characterSpec` so
   composer text and the session posture/activity fallback both pass through):
   gaze-type references (`toward/at the player`) rewrite to "the viewer" — exactly
   right for a POV shot; any clause still naming the player drops whole. Pronoun
   references ("his arm") are deliberately NOT scrubbed: in a multi-character scene a
   pronoun may be another character — that case belongs to the composer rule.
3. **Join tidy** (`resolveScenePlan`): trailing periods stripped from pose/activity
   before the `"; "` join.
