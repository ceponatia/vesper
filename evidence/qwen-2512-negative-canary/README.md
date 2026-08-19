# Qwen Image 2512 — negative-prompt canary

The evidence behind the ruling that `qwen/qwen-image-2512` ignores its
`negative_prompt` field (model-aware-image-prompts.spec.md).

**The test.** Positive prompt asks for "a bright red apple beside a blue ceramic
mug". The negative arm sends `red apple, apple` in `negative_prompt`. If the
field steers content at all, the apple should weaken or disappear.

**The result.** It never does.

| Sheet                              | Arm                              | Apple present |
| ---------------------------------- | -------------------------------- | ------------- |
| `A-gofast-on-off-arm.webp`         | no negative, `go_fast: true`     | 10/10         |
| `A-gofast-on-negative-arm.webp`    | negative sent, `go_fast: true`   | 10/10         |
| `A2-gofast-off-negative-arm.webp`  | negative sent, `go_fast: false`  | 6/6           |

`go_fast: true` is production's setting; the `false` arm rules out accelerated
sampling skipping negative conditioning. The blue mug survives everywhere, so
nothing is steering in either direction.

Paired seeds (101+), everything else held constant. The OFF and ON renders do
differ from each other — a changed conditioning tensor perturbs the sampling
trajectory — but the content is unmoved, which is what "present but untrained"
predicts and why a single differing image pair is not evidence of steering.

Full per-seed grading in the two CSVs.
