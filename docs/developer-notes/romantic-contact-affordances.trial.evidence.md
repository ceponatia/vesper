# Affectionate-contact trial — evidence appendix

Status: evidence appendix for
[romantic-contact-affordances.trial.md](romantic-contact-affordances.trial.md)
(trial closed — passed 2026-08-01; appendix amended 2026-08-01, rev 3)

Companion to [the trial report](romantic-contact-affordances.trial.md). This
document is the auditable record: every original A/B scenario and every rerun,
with full untruncated ids, verbatim transcripts, ledger rows, scene
projections, diagnostics, and per-axis scores. Every attempt is preserved and
labeled — including the rerun attempt that failed and the fix it exposed.
No credentials, connection strings, or session material appear here.

**Amended 2026-08-01 (rev 3, per the owner's verdict):** every section that
summarized or truncated a response has been replaced with the complete stored
message text, read back from the production rows — no conversation was rerun.
S5's mechanism wording is corrected (the skip endpoint stamps the pending
skip; the first subsequent exchange writes the ending — see §Rerun B — S5).

## Shared configuration

| Item           | Value                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App            | `vesper` on Fly.io, `https://vesper.fly.dev`                                                                                                                       |
| Database       | Neon project `round-sky-30947574` (production)                                                                                                                     |
| Account        | dedicated QA account `uxtest-main@vesper.local` (`uxtestmaina1b2c3d4e5f6g7`)                                                                                       |
| Character      | Sabrina Vale, id `wdijgtnp5dnosx3or16wwsvv` — every chat fresh-start (`memory: "fresh"`), 1-on-1                                                                   |
| Model          | chat default: `z-ai/glm-5.2` via OpenRouter (per-model reasoning `effort: low`), temperature = the narrative default                                               |
| Flags          | `CHAT_CONTACT_ACTIONS` / `CHAT_PHYSICAL_CONSTRAINTS` — exact values per section below; **both off outside the labeled windows and returned to off after the runs** |
| Player wording | player lines sent via `POST /api/chats/:id {kind:"send"}`; the reply is the streamed text verbatim; timestamps are client wall-clock UTC around each stream        |

**Deployments.**

| Window                                   | Fly release               | Git commit                                        | Notes                        |
| ---------------------------------------- | ------------------------- | ------------------------------------------------- | ---------------------------- |
| Original trial (2026-07-31 19:20–19:57Z) | v13x (pre-1.2 build)      | `875ddb7` lineage (item 1.1 build)                | both flags ON for the window |
| Rerun flag-off baselines (23:12–23:14Z)  | v139                      | `7eb1ea1` (item 1.2)                              | flags off                    |
| Rerun flag-on attempt 1 (23:15–23:16Z)   | v140 (same image as v139) | `7eb1ea1`                                         | flags ON via secrets         |
| Rerun flag-on attempts 2+ (23:27–23:38Z) | v141                      | `370d583` (item 1.2 + wardrobe restatement guard) | flags ON                     |
| After the window                         | v142                      | `370d583`                                         | flags unset (off)            |

**Disclosed setup change for the rerun.** The rerun requirements name a
*modeled dressed* target. The original trial's Sabrina had **no modeled
wardrobe at all** (see §"What the original state actually said" below), so
before the rerun her character profile was given a real library garment —
item `sabrinacottonshirt0trial` ("soft cotton shirt", category top, coverage
shoulders/chest/back/waist/upper_arms, layer 1) as outfit preset `work`
("Work clothes") — so every fresh chat seeds her structurally dressed. This is
a data setup change on the QA account only, made 2026-07-31 ~23:05Z, and it is
why rerun narration names a "soft cotton work shirt".

---

## Part 1 — the original trial (2026-07-31, 19:20–19:57 UTC)

Config A = both flags off (run first). Config B = both flags on. Scored
per-scenario on COHERENCE / CONTINUITY / NATURALNESS / NON-INTRUSION (1–5).

### Chat ids (full)

| Scenario                  | Config A chat              | Config B chat              |
| ------------------------- | -------------------------- | -------------------------- |
| S1 approach/touch/release | `z0tlhojudqzlcqwri7po75gn` | `j7w7q40vnhk08zwzb15bilqi` |
| S2 move-away              | `zamcimg2wks0a5bo283mgcec` | `whbzjjehvfu5cgqfo6rzmp8g` |
| S3 unreachable            | `lqxpkkby2ednq5fmww0oh09n` | `i5tsnhquv8c3oo4nqsr1p24d` |
| S4 romantic veto          | `drlq19sbofw802ieht87j076` | `s846492ywx34w11kg88bargb` |
| S5 skip                   | `es2qpgedogfxs5pvo1mfl4nx` | `rtrev99vg7geetv802j70bc6` |
| S6 object movement        | `txixuysqd17l85rx7cu4xxgd` | `syyaiqp2dwmbwgtpret85jof` |

### What the original state actually said (correction to the report's premise)

The trial premise described Sabrina as "dressed". The fiction agreed; the
STATE did not:

- **B-S1** (`j7w7q40vnhk08zwzb15bilqi`): `worn_item_ids: []`, `outfit: ""`,
  zero garment instances. The wardrobe authoritatively said *nothing worn*, so
  the committed touch's material read was **bare skin**
  (`materialBetween: []`, `directSkinContact: true`) — honest against the
  state, wrong against the fiction.
- **B-S2** (`whbzjjehvfu5cgqfo6rzmp8g`): `outfit: "a flour-dusted apron over
  her clothes"` — free text the archivist folded from the opening reply's
  prose at the FIRST settle. Dressed-but-unmodelled ⇒ the touch honestly
  no-opped `contact.material_unavailable`.
- **B-S5** (`rtrev99vg7geetv802j70bc6`): `outfit: "sleeves pushed up"` — same
  mechanism, same no-op.

So the "settle race" the report described was two stacked failures: the
coverage capture landing at the previous settle (the race item 1.2 fixed), and
the archivist's legacy outfit bridge **de-modelling the wardrobe** by folding a
narrator paraphrase as a free-text replacement (exposed and fixed during the
rerun — commit `370d583`).

### Original transcripts, verbatim and in order

Format: `[message id] role @ time — content`. All ids/timestamps are the
stored rows.

#### A-S1 `z0tlhojudqzlcqwri7po75gn`

- `vl0v01ps8wk9okfxjjdmr9pm` user @ 19:21:36.674Z — "I walk over to her.I walk over to her." *(the doubled text is the stored row, verbatim — an input-paste artifact of the original run)*
- `swymcyqneoypc3gxt15kmck8` assistant @ 19:21:56.244Z — "The corner café sits quiet under pale January light, the front windows still holding a thin frost at the edges. Behind the bar Sabrina Vale tightens the portafilter with a soft metallic click, the machine already breathing out its first warm hiss of steam.\n\nShe glances up as you walk over, one eyebrow lifting just a fraction.\n\n[Sabrina Vale] \"Morning. You look like you need something hot.\""
- `ed479jyjxgcgy5shk3efklvi` user @ 19:23:15.029Z — "I rest my hand on her shoulder.I rest my hand on her shoulder." *(same artifact)*
- `ic46zvoyoa9ywag06omszryt` assistant @ 19:23:28.156Z — "Sabrina Vale feels the weight of your hand settle on her shoulder and glances sideways at it, one corner of her mouth tipping up.\n\n[Sabrina Vale] \"Easy there. We haven't even gotten to drink orders yet.\"\n\nShe eases a half-step along the bar, the contact slipping off as the espresso machine hisses warm steam near you, and tilts her head."
- `k5lib8axp5gcll0zf6g567ga` user @ 19:23:58.132Z — "How was your day?"
- `vjsk1lvl8f6thnju9czx65ql` assistant @ 19:24:05.652Z — "Sabrina Vale glances up from the machine, a small wry tilt to her mouth as she catches the question.\n\n[Sabrina Vale] \"Day's barely started. Ask me again after the lunch rush.\"\n\nShe taps the portafilter once against the counter, watching you."
- `p0laebaaamilw9iir91iy5wb` user @ 19:24:57.270Z — "I pull my hand back."
- `pd5krvqgq8t8kczhrgxotwpo` assistant @ 19:25:06.889Z — "Sabrina Vale watches your hand drop away, that same wry little tilt still at the corner of her mouth.\n\n[Sabrina Vale] \"There we go. Safer already.\"\n\nShe turns back to the machine and knocks the spent grounds into the knock box with a clean thud."
- `mczitla9zd07ut6lotk8ci5a` user @ 19:25:32.336Z — "I should get going soon."
- `m7qx8naogm2qyhw9hloizotz` assistant @ 19:25:40.792Z — "Sabrina Vale glances over as you speak, the wry tilt still at her mouth while she wipes a cloth once across the counter.\n\n[Sabrina Vale] \"Fair enough. Door's right there when you're ready.\""

**A-S1 failure of record:** the touch she eased off at exchange 2 was
RESURRECTED by the release exchange ("watches your hand drop away" — a hand
the prose had already shed two beats earlier). Scores C4 / Ct3 / N5 / NI5.

#### B-S1 `j7w7q40vnhk08zwzb15bilqi`

- `uvz50yvcqv37gjeuhtklmbsy` user @ 19:40:21.449Z — "I walk over to her."
- `gtsvsjadupuf7quszx6lto9x` assistant @ 19:40:31.211Z — "The corner café is just coming alive at 8:01 on New Year's morning—thin winter light slanting across the empty tables, the espresso machine hissing as it warms up. Sabrina Vale stands behind the bar, tapping a portafilter empty into the knock box.\n\nShe glances up as you walk over, one eyebrow lifting a fraction.\n\n[Sabrina Vale] \"Hey. You're early.\""
- `m5klutduf30i5sko42jxhn5j` user @ 19:40:55.256Z — "I rest my hand on her shoulder."
- `uu4nxpvuxy9tw9b2cx5u6m47` assistant @ 19:41:03.817Z — "Sabrina Vale feels the weight of your hand settle on her shoulder. She doesn't pull away—just turns her head enough to glance at it, then up at you, that same mild curiosity still in her eyes.\n\n[Sabrina Vale] \"Bold for New Year's morning.\""
- `v25eypu2dpm8yjgmt89bo61u` user @ 19:41:36.075Z — "How was your day?"
- `dvkxa0ri6v80t5e0xh2zpq7s` assistant @ 19:41:42.108Z — "Sabrina Vale's mouth quirks at the question, still under your hand on her shoulder.\n\n[Sabrina Vale] \"It started three minutes ago. Ask me at close.\""
- `myp9c520wfy09lris5mdra46` user @ 19:42:12.913Z — "I pull my hand back."
- `xcfiee1jubenbu0e12mildm0` assistant @ 19:42:17.966Z — "Sabrina Vale watches your hand leave her shoulder. The corner of her mouth tips up a little more.\n\n[Sabrina Vale] \"There it goes.\""
- `r0mbx6f1k2glxhiolm8bi43j` user @ 19:42:46.948Z — "I should get going soon."
- `nbn8p2opirx9c1pj3e3tiy74` assistant @ 19:42:53.669Z — "Sabrina Vale tips her head a little, watching you.\n\n[Sabrina Vale] \"Soon.\""

**B-S1 ledger rows** (`chat_contact_events`, complete):

| guard                      | event_ref                          | seq | kind            | contact_id                                                                                       | reason    | story_minute | payload highlights                                                                                                                                               |
| -------------------------- | ---------------------------------- | --- | --------------- | ------------------------------------------------------------------------------------------------ | --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m5klutduf30i5sko42jxhn5j` | `contact:m5klutduf30i5sko42jxhn5j` | 0   | contact_started | `body␟player␟hands␟␟␞body␟wdijgtnp5dnosx3or16wwsvv␟shoulders␟␟␝contact:m5klutduf30i5sko42jxhn5j` | —         | 2            | affectionate rest, pressure light, `materialBetween: []`, `directSkinContact: true` (the state said nothing was worn), actorControl allowed, policy not_required |
| `myp9c520wfy09lris5mdra46` | `contact:myp9c520wfy09lris5mdra46` | 0   | contact_ended   | same contact id                                                                                  | withdrawn | 4            | endedByEventRef = the release exchange's own ref                                                                                                                 |

Scores C5 / Ct5 / N5 / NI5 — held across an unrelated beat ("still under your
hand"), clean state-aligned release, no resurrection.

#### A-S2 `zamcimg2wks0a5bo283mgcec`

- `pu7zu224baj0uwhf13hxi12q` user @ 19:27:10.262Z — "I walk over to her."
- `n2jnq0elsfku8fgwk9o2m5sr` assistant @ 19:27:18.693Z — "The corner café is still half-asleep at 8:01 on New Year's morning, pale winter light slanting through the front windows onto the empty tables. The espresso machine hisses as it warms, filling the quiet with the sharp bite of fresh grounds.\n\nSabrina Vale glances up from wiping down the bar as you walk over. She sets the cloth aside and rests her hands on the counter.\n\n[Sabrina Vale] \"Morning. You're my first one in.\""
- `fefoqrd8w8lwrtzkropl61gb` user @ 19:27:45.311Z — "I rest my hand on her shoulder."
- `ms7yoqx1vxv44kb7h5k56skr` assistant @ 19:27:55.326Z — "Sabrina Vale feels the weight of your hand settle on her shoulder and glances sideways at it, one brow lifting. She doesn't pull away hard—just shifts a half-step so the contact eases off on its own, still easy at the counter.\n\n[Sabrina Vale] \"Bold for eight in the morning.\" A small, wry curve touches her mouth. \"Coffee first?\""
- `skuo7qysskkwlhoklpm61vr2` user @ 19:28:21.450Z — "I step back."
- `h2t5g23k6u4byqc88kp45kpu` assistant @ 19:28:30.004Z — "Sabrina Vale watches you ease back, the wry little curve still on her mouth. She gives a small nod, like that tracks, and turns toward the machine without making a thing of it.\n\n[Sabrina Vale] \"Coffee first it is. What are we making?\""
- `bd5050n11dpp4ex71ws4qu6v` user @ 19:28:53.211Z — "What were you saying earlier?"
- `lkwgvzd299486dkpfvrr5awg` assistant @ 19:29:02.660Z — "Sabrina Vale glances back over her shoulder, one hand already on the portafilter.\n\n[Sabrina Vale] \"Just that coffee comes first. You still need to pick what we're pulling.\""

Scores 5/5/5/5 (she pre-ended the touch herself in prose).

#### B-S2 `whbzjjehvfu5cgqfo6rzmp8g`

- `vdckl3h7vbg18ej8koa9ahb7` user @ 19:44:15.138Z — "I walk over to her."
- `vcyg75otwwe646b32lm2vmax` assistant @ 19:44:22.003Z — "The corner café is just waking up with the new year—Monday morning light slanting through the front windows onto scuffed wood floors, the espresso machine hissing as it comes up to temperature. Sabrina Vale stands behind the bar in a flour-dusted apron, tamping a fresh shot, the rich bitter scent of ground beans hanging in the air.\n\nShe glances up as you walk over, a small wry smile tugging at one corner of her mouth.\n\n[Sabrina Vale] \"Morning. You're early—what can I get started for you?\""
- `lx81yyqm2if92hx5g3rls90m` user @ 19:44:39.009Z — "I rest my hand on her shoulder."
- `fxs65s03wfln6nxlotiwbveb` assistant @ 19:44:49.670Z — "Sabrina Vale feels the weight of your hand settle on her shoulder and goes still for half a beat, eyes flicking sideways to it. She eases a half-step back along the bar, the contact sliding off as she reaches for a clean cup instead—nothing sharp, just space reclaimed.\n\n[Sabrina Vale] \"Easy there. Counter's for elbows, not hands. What are we making this morning?\""
- `qq4k9a1394lp7g9r4gcorxjq` user @ 19:45:21.410Z — "I step back."
- `omzwouv1ud24w51k78v4uqc8` assistant @ 19:45:30.344Z — "Sabrina Vale watches you step back, the wary line in her shoulders easing a fraction. She gives a small nod—message received—and turns to the grinder, tapping grounds into the portafilter with a clean, practiced motion.\n\n[Sabrina Vale] \"Whenever you're ready.\""
- `uefdbe17qjp23a0yuo3akbcc` user @ 19:45:57.260Z — "What were you saying earlier?"
- `n623aoph9f5mhf0xlfjbnl04` assistant @ 19:46:04.628Z — "Sabrina Vale glances over from the portafilter, one eyebrow lifting a fraction as she settles the grounds.\n\n[Sabrina Vale] \"Just asking what I can get started for you. Coffee, or are you still deciding?\""

**B-S2 ledger rows: NONE.** The touch resolved `unresolved /
material_unavailable` (dressed-unmodelled — the settle-1 outfit fold). The
departure producer still wrote proximity `near` with
`chat.contact.departure` provenance into `character_chats.scene`. **This run
therefore proves the movement/scene half only; it is NOT a valid
contact-lifecycle proof** — the original report's 5/5/5/5 stands for prose
quality, not for the machinery.

#### A-S3 `lqxpkkby2ednq5fmww0oh09n`

- `iwij5p5mftufesjyqmjnuei6` user @ 19:30:25.486Z — "Hello again."
- `fcwe5s79yxj51fucztwonr5w` assistant @ 19:30:38.832Z — "The corner café is just unlocking its doors on a cold New Year's morning, pale winter light slanting across the empty tables. Behind the espresso bar Sabrina Vale tamps a fresh portafilter, the machine hissing softly as it comes up to pressure.\n\nShe glances up at the sound of the bell.\n[Sabrina Vale] \"Hey. Back already?\""
- `vtdaia0i4gn3874loop04mcx` user @ 19:30:59.625Z — "I rest my hand on her shoulder."
- `nkfteg430sh1h9tzc667ahd4` assistant @ 19:31:09.664Z — "Sabrina Vale feels the weight of your hand and glances sideways at it, one brow ticking up. She doesn't pull away hard—just shifts a half-step so the contact slips off as she reaches for a clean cup.\n[Sabrina Vale] \"Bold for eight in the morning.\""
- `nhg3r1y83u9cz4sldrdnwhlh` user @ 19:31:35.476Z — "Sorry — I'm being forward."
- `zdxguuzegl9537id7zwc5jg9` assistant @ 19:31:41.325Z — "Sabrina Vale huffs a quiet laugh through her nose, eyes still on the cup as she sets it under the spout.\n[Sabrina Vale] \"Noted. Coffee first, maybe.\""

**A-S3 failure of record: TELEPORT** — the player is at the door ("the sound
of the bell"), the very next line lands a hand on her shoulder and the prose
depicts it landing. C2.

#### B-S3 `i5tsnhquv8c3oo4nqsr1p24d`

- `c0wst5jjqaqaukqeqj59vse5` user @ 19:46:58.988Z — "Hello again."
- `j6jk7kb6q4u0emlw5kco06u7` assistant @ 19:47:08.536Z — "The corner café is just coming awake on a cold New Year's morning, pale light slanting through the front windows across the empty tables. Behind the counter Sabrina Vale is already moving, flipping the switch on the espresso machine; it hisses and steams as it warms up.\n\nShe glances up at the sound of the door and your voice, a quick wry lift of one eyebrow.\n\n[Sabrina Vale] \"Hey. You're early.\""
- `xhik3j7wv45u1pb0lam040ww` user @ 19:47:23.466Z — "I rest my hand on her shoulder."
- `kz4qt84btqj0npzxvps817gq` assistant @ 19:47:34.312Z — "Sabrina Vale's shoulder stills under your hand. She glances sideways at it, then up at you, that same wry eyebrow ticking higher.\n\n[Sabrina Vale] \"Bold for eight in the morning.\""
- `kh4z631ihum5upnen0ot2ita` user @ 19:49:42.482Z — "Sorry — I'm being forward."
- `dnlx1ipg733u537g92d5rhot` assistant @ 19:49:52.898Z — "Sabrina Vale's mouth quirks, the dry edge softening just a fraction. She doesn't shrug the hand off.\n\n[Sabrina Vale] \"Forward's one word for it. Morning rush isn't exactly peak boldness hour, though.\""

**B-S3 record:** zero ledger rows, zero proximity, diagnostics
`scene.relation_unavailable` + `contact.pose_unavailable` filed — the state
stayed honest — but the PROSE still teleported the touch onto her shoulder
(C2 unchanged). Safety/presentation finding, not a visible-coherence pass.

#### A-S4 `drlq19sbofw802ieht87j076` (romantic veto)

- `jyukp49xdld4x7x5sa6x0np5` user @ 19:32:45.783Z — "I walk over to her."
- `h8tyvi8nnszowmvjmw8whqrb` assistant @ 19:33:00.527Z — "The corner café sits quiet under the pale January light, just past eight on a Monday morning. Behind the espresso bar, Sabrina Vale taps the portafilter against the knock box; the sharp metallic ring cuts through the low gurgle of the machine warming up.\n\nShe looks up as you walk over, one eyebrow lifting a fraction.\n\n[Sabrina Vale] \"Hey. Just opening up—what'll it be?\""
- `iv9120w16j19n3fga3sp8h8q` user @ 19:33:18.592Z — "I kiss her."
- `r9j1g3tht1lla1u57z3gy968` assistant @ 19:33:30.522Z — "Sabrina Vale stills as you lean in, then turns her face just enough that your mouth brushes her cheek instead. She eases half a step back along the bar, one hand coming up between you—not shoving, just there.\n\n[Sabrina Vale] \"Hey—slow down. We haven't even done the coffee part yet.\"\n\nA small, wry breath of a laugh. The scent of espresso and warm milk clings close when she speaks."

#### B-S4 `s846492ywx34w11kg88bargb` (romantic veto)

- `zfrhst5ddk7gtd0ivwrtgeie` user @ 19:50:35.754Z — "I walk over to her."
- `andfuhh2afe4hqc11mlexvwt` assistant @ 19:50:46.916Z — "The corner café is just waking up on New Year's morning, pale winter light cutting through the front windows onto the scuffed wood floor. The espresso machine hisses and steams behind the counter where Sabrina Vale is lining up clean cups, the air already sharp with fresh grounds.\n\nShe glances up as you walk over, a quick once-over, then a small wry tilt of her mouth.\n\n[Sabrina Vale] \"Morning. You're early—most people are still sleeping this one off. What can I get you?\""
- `znuuggcg2aucmzrq6fvespm1` user @ 19:51:11.292Z — "I kiss her."
- `i67v3zh5pp96x5ustft44wy5` assistant @ 19:51:20.211Z — "Sabrina Vale pulls back the second your mouth meets hers, palm flat against your chest to hold the distance. Her eyebrows lift, half amused, half startled.\n\n[Sabrina Vale] \"Whoa. We literally just said hi.\""

**B-S4 record:** the ledger is EMPTY — no `contact.*` codes at all; the
romantic line never became an attempt. The veto held in production. ✓

#### A-S5 `es2qpgedogfxs5pvo1mfl4nx`

- `ewzlk1c6ivjtvy484ya5mqdv` user @ 19:34:19.913Z — "I walk over to her."
- `mvstasdfmahrkfagsx9hhaix` assistant @ 19:34:29.647Z — "The corner café sits half-awake on the first morning of the year, thin winter light cutting across the counter and the low hiss of the espresso machine just coming up to heat. Sabrina Vale glances up from the portafilter in her hands as you walk over.\n\n[Sabrina Vale] \"Hey. Just us so far.\" She tips her chin toward the empty stools. \"Coffee, or still deciding?\""
- `aznfveh7v4ygvbot4no49ce3` user @ 19:34:43.613Z — "I rest my hand on her shoulder."
- `cdgalmuw4n6265fb4glu6utf` assistant @ 19:34:57.357Z — "Sabrina Vale feels the weight of your hand settle on her shoulder and glances at it, then up at you. One brow lifts a fraction; she eases half a step along the counter so the contact slides off on its own, easy and unfussed.\n\n[Sabrina Vale] \"Friendly.\" A dry little curve at the corner of her mouth. \"You picking a drink, or just testing the furniture?\""
- *(3-hour skip)* then `dwvlvkwx7ukpmrhgoo8t4g7e` user @ 19:35:38.230Z — "That was a nice morning."
- `oqeniag6fc8qet1z1lnqh1ei` assistant @ 19:35:52.514Z — "Sabrina Vale glances up from the group of cups she's just set to drain, the last of the mid-morning trickle already cleared. She'd spent the hours between wiping steam wands and restocking lids while the place slowly filled and emptied again.\n\n[Sabrina Vale] \"It was. Quiet enough to actually hear the machine.\" A small wry tip of her head. \"Glad you caught the easy part.\""

#### B-S5 `rtrev99vg7geetv802j70bc6`

- `oq4tq200c6691jrbxejdaj3b` user @ 19:52:20.238Z — "I walk over to her."
- `j83rzecotll3blc8px1nu2be` assistant @ 19:52:28.079Z — "The corner café is still shaking off the night — January cold pressed against the glass, the first real light of the morning thin and pale across the counter. The espresso machine hisses as Sabrina Vale wipes down the portafilter, sleeves pushed up, focused on the small ritual of getting the bar ready before the rush.\n\nShe glances up as you walk over, a quick read of the movement, then a small tilt of her head.\n\n[Sabrina Vale] \"Morning. You're early.\""
- `kfrx5t29wq0aw58p3b94rrs1` user @ 19:53:01.349Z — "I rest my hand on her shoulder."
- `xeq4bg55rlh8jxrlzetpsc3o` assistant @ 19:53:15.525Z — "Sabrina Vale feels the weight of your hand settle on her shoulder and goes still for a half-second, the portafilter paused mid-wipe. She glances sideways at the contact, one brow ticking up, then eases a half-step so the touch slips off without drama—close enough that the faint warmth of her skin reaches you through the pushed-up sleeve.\n\n[Sabrina Vale] \"Bold opener. You ordering, or just practicing?\""
- *(3-hour skip)* then `aeginlvbzcyoychup5t3iaov` user @ 19:54:00.313Z — "That was a nice morning."
- `fgds38u5sd90hg4hw719phqa` assistant @ 19:54:17.525Z — "The café has filled out since the early quiet—thin January light still hard at the windows, but the room now carries the low clatter of cups and the steady hiss of steam from the machine as the late-morning crowd filters through.\n\nSabrina Vale finishes tamping a shot, sleeves pushed up from the rush that hit after you left, and glances over when you speak.\n\n[Sabrina Vale] \"Yeah? Survived the opener, at least.\" She sets the portafilter down with a soft click. \"Back for round two, or just reviewing the morning?\""

**B-S5 ledger rows: NONE — the touch never committed**
(`contact.material_unavailable`, dressed-unmodelled). The clean post-skip
prose therefore proves nothing about the skip's `separated` sweep: there was
nothing to sweep. **Not a valid contact-lifecycle proof.**

#### A-S6 `txixuysqd17l85rx7cu4xxgd` (object movement / invented scene)

- `phdmh2iauv0is33hf97zdb4g` user @ 19:36:41.824Z — "I walk over to her."
- `fergotplmdw1w4k4ienlxzfk` assistant @ 19:36:50.663Z — "The corner café is just cracking open on a cold New Year's morning, pale light cutting through the front windows onto scuffed wood floors. Behind the espresso bar Sabrina Vale is lining up clean cups, the machine hissing as it comes up to temperature.\n\nShe glances up as you walk over, a quick once-over, then a small tilt of her head.\n\n[Sabrina Vale] \"Morning. We're still waking the place up—what can I get you?\""
- `s11t6esdjgfr0rnbvct5sm0v` user @ 19:37:06.690Z — "I rest my hand on her shoulder."
- `lyg2blhm8jki0o379tfxhfvw` assistant @ 19:37:15.452Z — "Sabrina Vale feels the weight of your hand settle on her shoulder and goes still for half a beat, eyes flicking to it, then back to your face. She eases half a step back so the contact drops, polite but clear, and gives a small wry smile.\n\n[Sabrina Vale] \"Easy there—we just met. Coffee first?\""
- `zfm8usgkixoijgpkjte3bin4` user @ 19:37:31.174Z — "I walk over to her desk."
- `n5d33x3tm8ejy8y5avn6sl0i` assistant @ 19:37:46.780Z — "The back room of the corner café holds a battered wooden desk under a single hanging lamp, its surface crowded with order slips and a half-finished sketchbook. The espresso machine's low rumble still filters through the open doorway from the front.\n\nSabrina Vale glances up from the papers as you walk over, staying seated, her posture a little more reserved than before.\n\n[Sabrina Vale] \"Didn't figure you'd wander back here.\"" *(prose INVENTS a back room and moves both bodies there)*
- `ozn1gff23k4in4wf8r1ho381` user @ 19:38:06.821Z — "I pick up the photo frame."
- `gbwruwkzsanh4yezzueqf2oa` assistant @ 19:38:40.210Z — "Sabrina Vale's gaze sharpens the second your fingers close on the frame. She stays in her chair but leans forward just enough to stay clear of you, one hand settling on the desk edge.\n\n[Sabrina Vale] \"That's not for customers.\""

Double teleport; held-touch continuity vanished silently. C2/Ct3.

#### B-S6 `syyaiqp2dwmbwgtpret85jof` (object movement / invented scene)

- `e80f4pmpv67lqpaapzz7pn1l` user @ 19:55:01.506Z — "I walk over to her."
- `w9vacohljjzxszdh6mvsiq8k` assistant @ 19:55:11.732Z — "Morning light cuts through the front windows of the corner café, catching on the chrome of the espresso machine as it hisses and sighs. Sabrina Vale is behind the bar, tamping a fresh shot, the low clink of ceramic cups the only other sound this early.\n\nShe glances up as you walk over, a small wry lift at the corner of her mouth.\n\n[Sabrina Vale] \"Morning. What can I get you?\""
- `v128hcbpx09rq1mhagemendp` user @ 19:55:39.799Z — "I rest my hand on her shoulder."
- `fgigdwz16zrilif8665s9cyr` assistant @ 19:55:56.320Z — "Sabrina Vale goes still for a half-second under your hand, the warmth of her shoulder solid through the thin cotton of her shirt. She glances sideways at the contact, one brow ticking up, then back to your face with that same mild, wry curiosity.\n\n[Sabrina Vale] \"Bold start for a Monday.\"" *(note the STATE's material read was `[]`/direct — the cotton is the model's own line, not the machinery's)*
- `xdame1lrkhcowsm0ovj42b3t` user @ 19:56:22.380Z — "I walk over to her desk."
- `r6bilx4r6843itz81ou5hzrs` assistant @ 19:56:31.269Z — "The morning light through the high window falls across a plain wooden desk cluttered with a half-finished sketchbook, loose charcoal sticks, and a cooling mug of black coffee. Somewhere nearby a radiator ticks softly as it warms the quiet room.\n\nSabrina Vale looks up from the page as you walk over, one elbow still propped on the desk's edge. Her expression stays easy, a little amused.\n\n[Sabrina Vale] \"Hey. Need something?\"" *(prose still invents the desk scene)*
- `s1h7msmpesyg5dfck2xvr3hd` user @ 19:57:07.681Z — "I pick up the photo frame."
- `ju3foizkn7hdn7trsmpejlzp` assistant @ 19:57:26.078Z — "Sabrina Vale's gaze follows your hand as you lift the frame from the desk. She stays seated, one brow lifting a fraction.\n\n[Sabrina Vale] \"That's not the sketchbook.\""

**B-S6 ledger rows** (complete):

| guard                      | event_ref                          | seq | kind            | reason        | story_minute |
| -------------------------- | ---------------------------------- | --- | --------------- | ------------- | ------------ |
| `v128hcbpx09rq1mhagemendp` | `contact:v128hcbpx09rq1mhagemendp` | 0   | contact_started | —             | 2            |
| `xdame1lrkhcowsm0ovj42b3t` | `contact:xdame1lrkhcowsm0ovj42b3t` | 0   | contact_ended   | scene_changed | 3            |

State-level win (the held touch ended durably through the place change);
prose-level failure (the invented desk scene still rendered). Partial.

---

## Part 2 — the reruns (2026-07-31, 23:12–23:38 UTC)

Fresh disposable chats; the EXACT original per-scenario scripts; flag-on lines
sent as soon as the prior stream completed (intervals recorded — no artificial
coverage-settlement delay anywhere). First configured runs are the trial
results; extra attempts are labeled.

### Rerun chat ids (full)

| Run                                       | Flags | Chat id                                                                            |
| ----------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| Rerun A — S2                              | off   | `f9ec0k1fn7lp3fkbiey6at6z`                                                         |
| Rerun A — S5                              | off   | `vibrhbd7g8pe5j8g4e0jream`                                                         |
| Rerun A — S3                              | off   | `hl8250gr81qd13aktazzd7xd`                                                         |
| Rerun B — S2 attempt 1                    | on    | `pdgfkcouaaviu2vyuuesfwgl`                                                         |
| Rerun B — S2 attempt 2                    | on    | `aqs0qog98ycgp3tzmp5komak`                                                         |
| Rerun B — S5                              | on    | `bhv7n9chmz2xxf4wahhabi68`                                                         |
| Rerun B — S3 attempt 1                    | on    | `lt22r1baj1xr8a6wt9au72o3`                                                         |
| Rerun B — S3 attempt 2 (guidance capture) | on    | `amwqncnhb7yr3k12aao4j8bk`                                                         |
| Rerun B — NPC withdrawal attempts 1–3     | on    | `ymhtiw6s0bz2xtt6uk8krpym`, `vj9923yvisr8cvpj3pbbjj0o`, `w6hsm91sxoo7je4brf2jwgjh` |

### Rerun A (flag-off baselines, v139)

#### Rerun A-S2 `f9ec0k1fn7lp3fkbiey6at6z`

- `xtkdq8r1frybzvizxytznaf4` user @ 23:12:10.907Z — "I walk over to her."
- `c50itlim4th3mezjc8lruebi` assistant @ 23:12:17.958Z — "Morning light cuts through the front windows of the corner café in thin stripes across the counter. The espresso machine hisses as it warms up, the sharp scent of fresh grounds already in the air.\n\nSabrina Vale glances up from wiping down the portafilter as you walk over. She sets the cloth aside and rests both hands on the bar.\n\n[Sabrina Vale] \"Morning. You're early.\""
- `hgm6aj4v378zngof8ygneb9r` user @ 23:12:20.410Z — "I rest my hand on her shoulder."
- `bb1mqxgsc1zn6hlgpx8a0bfz` assistant @ 23:12:40.651Z — "Sabrina Vale feels the weight of your hand settle on her shoulder and goes still for half a beat. Her eyes flick to it, then back up to your face—curious more than startled, one brow ticking up.\n\n[Sabrina Vale] \"Easy. We just met.\"\n\nShe shifts a half-step along the counter, enough that the contact slips off without a fuss. The cotton of her work shirt is warm under your palm for that second before it goes."
- `b3oncfrdjbmgehd0qbsrsa1g` user @ 23:12:43.264Z — "I step back."
- `ujxvzqodqrfu9l1ccdsbn4qq` assistant @ 23:12:50.384Z — "Sabrina Vale watches the space open back up between you. The corner of her mouth eases—not quite a smile, just the tension leaving.\n\n[Sabrina Vale] \"There we go.\"\n\nShe picks up the cloth again and gives the counter a quick wipe, glancing at you like the moment's already filed."
- `ei3apqzcyy0ixkjtsgxocbrb` user @ 23:12:52.081Z — "What were you saying earlier?"
- `w75zhda7k797t3ec37pf0hm0` assistant @ 23:13:00.820Z — "Sabrina Vale glances up from the counter, cloth still in hand, one corner of her mouth tipping up.\n\n[Sabrina Vale] \"That you're early. Or the 'easy' part—take your pick.\""

Baseline shape: she pre-ends the touch herself (the she-always-shrugs-it-off
default). Zero ledger rows, empty scene — correct for flags off.

#### Rerun A-S5 `vibrhbd7g8pe5j8g4e0jream`

- `wziyy9v4nnbx5yokkjmmtuy9` user @ 23:13:07.177Z — "I walk over to her."
- `jmshkzi68rl4rodu3n8z8289` assistant @ 23:13:14.766Z — "Morning light cuts through the front windows of the corner café in thin, pale strips, catching on the steel of the espresso machine. The air still carries the faint bite of fresh grounds from the first hopper Sabrina Vale filled.\n\nShe glances up from wiping down the bar as you walk over, one sleeve of her soft cotton work shirt already shoved to the elbow.\n\n[Sabrina Vale] \"Hey. We're just getting the machines awake.\""
- `fxgvch928dmndqjt49zwh9b9` user @ 23:13:17.330Z — "I rest my hand on her shoulder."
- `d47nog2j4m4ogn51dzccrfow` assistant @ 23:13:31.355Z — "Sabrina Vale stills under your hand for half a second, then eases half a step sideways so the contact slides off naturally. The cotton of her work shirt is soft and warm from the morning rush of opening.\n\n[Sabrina Vale] \"Easy there. Bar's still half-asleep — me too.\"" *(pre-ends it)*
- *(`hours` skip)* then `aeehy8ydre1gnyf7wvbap65v` user @ 23:13:34.355Z — "That was a nice morning."
- `yzuten94ew550pdxbnm9a9nc` assistant @ 23:13:47.863Z — "Sabrina Vale glances up from the register, the morning rush finally thinning behind her. She's spent the last couple hours pulling shots and keeping the line moving.\n\n[Sabrina Vale] \"It had its moments. You sticking around for the afternoon lull, or just passing through?\""

Zero rows.

#### Rerun A-S3 `hl8250gr81qd13aktazzd7xd`

- `d72w8zdqd9vvi9s9efxyugu1` user @ 23:13:55.697Z — "Hello again."
- `rz6rfswpwop6dr0vxv45fbhm` assistant @ 23:14:05.236Z — "The corner café is still shaking off the night on this cold Monday morning, January light thin through the front glass. Behind the espresso bar Sabrina Vale is already moving—pulling the first shots, steam wand hissing once as she works the milk. She glances up when you speak, a quick wry tilt of her head.\n\n[Sabrina Vale] \"Morning. You again, huh?\""
- `cyw7fj3t9w9uyahygnwaqxpv` user @ 23:14:07.545Z — "I rest my hand on her shoulder."
- `k7w0z7h1cxeezmq4xzimmkcr` assistant @ 23:14:20.374Z — "Sabrina Vale stills under your hand for half a beat, the steam wand quieting as she finishes the pour. The soft cotton of her work shirt is warm from the machines; you catch the faint roast-and-milk scent that clings to her when you're this close.\n\n[Sabrina Vale] \"Easy there.\" A quick sideways glance, wry but not unkind. \"Shoulder's not on the menu.\"" — **the baseline teleport, reproduced**: player at the door, touch lands instantly.
- `h1ifw4u0fmxxsyzs41x5k6al` user @ 23:14:24.033Z — "Sorry — I'm being forward."
- `nnyxd63eif4syslan3krcnp8` assistant @ 23:14:34.970Z — "Sabrina Vale's mouth quirks, the look she gives you mild and a little amused as she turns back toward the machine.\n\n[Sabrina Vale] \"Forward's one word for it. You're fine.\""

Zero rows (flags off).

### Rerun B — S2, attempt 1 (v140, image `7eb1ea1`) — FAILED, preserved

Chat `pdgfkcouaaviu2vyuuesfwgl`. Transcript (complete):

- `imzppboqrtk45in8odop8a7z` user @ 23:15:30.480Z — "I walk over to her."
- `wefc36d3r7d70eowwvwf9jjq` assistant @ 23:15:42.767Z — "The corner café is just cracking open on a cold Monday morning, pale light pooling across the counter and the espresso machine already sighing steam. Sabrina Vale stands behind the bar in a soft cotton work shirt with the sleeves shoved up, finishing a tamp as you walk over. She glances up, one eyebrow lifting a fraction.\n\n[Sabrina Vale] \"Hey. You're early.\""
- `tv23rndkf03kybp505i7uizm` user @ 23:15:46.014Z (**0.2s after the prior stream closed**) — "I rest my hand on her shoulder."
- `z68fshy1oec0lovgkqgitn5k` assistant @ 23:15:56.418Z — "Sabrina Vale feels the weight of your hand settle on her shoulder and goes still for half a beat, eyes flicking sideways to it. She shifts just enough that the contact slides off, easy, like she needed to reach for a clean portafilter anyway.\n\n[Sabrina Vale] \"Easy there. We've barely said hello.\" \n\nA small, wry tilt of her mouth. The cotton of her sleeve is still warm where you brushed it."
- `b4yt4emu7ofjn76b2zvrg5y1` user @ 23:16:00.844Z — "I step back."
- `lfhraj7k7hp8wlttf786ibyo` assistant @ 23:16:07.981Z — "Sabrina Vale watches you step back, the wariness in her eyes easing a fraction but not vanishing. She gives a short nod, more acknowledgment than invitation, and turns the portafilter under the group head with a quiet click.\n\n[Sabrina Vale] \"There we go.\""
- `e3mmpcqh8anqkn2amtgujb46` user @ 23:16:09.784Z — "What were you saying earlier?"
- `mfiyx6yntnui56y2j5lsx3nk` assistant @ 23:16:16.724Z — "Sabrina Vale glances up from the machine, one corner of her mouth tipping in a dry little half-smile.\n\n[Sabrina Vale] \"Just that you're early. And that we've barely said hello.\" \n\nShe taps the portafilter once against the knock box, keeping it light."

**Result: zero ledger rows** — the touch filed `contact.material_unavailable`
(diagnostics @23:16:00.526Z). Root cause established from the settle-1
diagnostics (`chat_garments.legacy_outfit_bridge` @23:15:45.706Z) and the
state row: the archivist extracted the opening prose's paraphrase of her
outfit and the legacy outfit bridge folded it as a FREE-TEXT REPLACEMENT,
wiping `worn_item_ids` and de-modelling the wardrobe before the touch
exchange read it. The item-1.2 race fix behaved correctly against the state it
was handed; the state itself had been demoted. **Fix:** commit `370d583` — a
restatement of the worn look no longer wipes the modelled wardrobe
(`chat_wardrobe.outfit_restatement`). The departure/scene half still passed
(final proximity `near`, provenance `chat.contact.departure`, contacts empty).

### Rerun B — S2, attempt 2 (v141, `370d583`) — PASS

Chat `aqs0qog98ycgp3tzmp5komak`. Intervals: each line sent ≤0.3s after the
prior reply stream closed (client stamps: 23:27:25.320 → :36.211 close /
:36.227 next send; :52.831 close / :52.841 send; 23:28:01.867 close / :01.884
send).

- `o6se5gk8ds4574hnzx2yh8da` user @ 23:27:25.678Z — "I walk over to her."
- `t1nuh1c3wesdxa12dz6jqzf5` assistant @ 23:27:33.667Z — "The corner café is just coming alive at 8:01 on a Monday morning, January light thin through the front windows. The espresso machine hisses as Sabrina Vale wipes down the bar, sleeves of her soft cotton work shirt pushed up.\n\nShe glances up as you walk over, a small wry tilt to her mouth.\n\n[Sabrina Vale] \"Morning. What can I get you?\""
- `hfd48gsby9ts24716zvm26lk` user @ 23:27:36.492Z — "I rest my hand on her shoulder."
- `lushggzlyttbxmrd7mz296jp` assistant @ 23:27:50.264Z — "Sabrina Vale stills under the weight of your hand on her shoulder, **the cotton of her work shirt warm between you**. She glances sideways at the contact, one brow ticking up, then back to your face.\n\n[Sabrina Vale] \"Bold start for a Monday.\" A small wry curve touches her mouth. \"Coffee, or did you just come to lean?\"" — the touch HELD, and the material reached the prose.
- `f1nzendkis4xwq42ixgp4zoe` user @ 23:27:53.096Z — "I step back."
- `kcfkygk6tfcrkmwmdwxrzpnm` assistant @ 23:28:00.093Z — "Sabrina Vale's shoulder eases as you step back. The wry tilt stays on her mouth, softer now.\n\n[Sabrina Vale] \"There we go.\" She turns half toward the espresso machine, giving you the bar again."
- `e6eblxvj1u7dhaw7rt3ienus` user @ 23:28:02.150Z — "What were you saying earlier?"
- `xdsp5gzganz8k7jkl0r9oj10` assistant @ 23:28:08.378Z — "Sabrina Vale glances over from the machine, one corner of her mouth lifting.\n\n[Sabrina Vale] \"Asked if you wanted coffee. Or if you were just here to lean.\"" — no resurrection.

**Ledger rows (complete):**

| guard                      | event_ref                          | seq | kind            | reason        | story_minute | payload (decisive fields)                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------- | --- | --------------- | ------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hfd48gsby9ts24716zvm26lk` | `contact:hfd48gsby9ts24716zvm26lk` | 0   | contact_started | —             | 2            | `materialBetween: [{layerId: "osj9y0tvpcplggns5vljdgev:root", order: 0, tactileTransmission: 6000, thermalTransmission: 4000, moistureTransmission: 0, visibleThrough: false, evidence: [{kind: "coverage", ref: "coverage:shoulders", detail: "opaque"}]}]` — **the cloth layer, from the CURRENT cut with no persisted capture and no settle wait** |
| `f1nzendkis4xwq42ixgp4zoe` | `contact:f1nzendkis4xwq42ixgp4zoe` | 0   | contact_ended   | **separated** | 3            | same contact id; endedBy the step-back exchange's ref                                                                                                                                                                                                                                                                                                 |

**Scene projection after:** `contacts: []`; proximity `player ↔ Sabrina =
near`, provenance evidence `chat.contact.departure` (storyTime 3); facing
toward (from the approach). Diagnostics: `chat_wardrobe.outfit_restatement`
at settle 1 (the guard holding), NO `contact.material_unavailable` anywhere.

**Every S2 flag-on requirement met:** approach facts ✓, `contact_started` ✓,
committed material layer (not `material_unavailable`) ✓, `contact_ended /
separated` ✓, proximity `near` with departure provenance ✓, empty active
projection ✓, no prose resurrection ✓. Scores: C5 / Ct5 / N5 / NI5.

### Rerun B — S5 (v141) — PASS

Chat `bhv7n9chmz2xxf4wahhabi68`.

- `h621qxadoimtq9kho1ubyplg` user @ 23:28:45.543Z — "I walk over to her."
- `jat40ixz56ko4qxvr6jcpgd2` assistant @ 23:28:54.485Z — "The corner café is just coming alive at a little past eight on a cold New Year's morning, winter light slanting through the front windows onto the worn counter. Sabrina Vale is behind the espresso bar in her soft cotton work shirt, sleeves already pushed up, wiping down the steam wand with a practiced twist of the cloth as the machine hisses softly.\n\nShe glances up as you walk over, a quick once-over that lands somewhere between curious and dryly amused.\n\n[Sabrina Vale] \"Morning. You're either an early bird or you really need the caffeine.\""
- `jwe8c9rjulaxpqqxmkhlf7rr` user @ 23:28:57.211Z (0.3s after the prior close) — "I rest my hand on her shoulder."
- `rol6vlkpoyt26zu36wuqvp3y` assistant @ 23:29:10.686Z — "Sabrina Vale stills under the weight of your hand on her shoulder, the soft cotton of her work shirt warm from the espresso machine's heat. She glances sideways at the contact, one brow ticking up, then meets your eyes with that same dry little half-smile.\n\n[Sabrina Vale] \"Bold opener for a Monday.\"" — held.
- `POST /time-skip {amount: "hours"}` @23:29:12.437Z (0.015s after close) — +180 story minutes.
- `hhbm1qtzpbraic6aglprzn56` user @ 23:29:12.948Z — "That was a nice morning."
- `jkcjxpc91ifrkyvl5oyyh3wm` assistant @ 23:29:31.443Z — "Late-morning light pools brighter across the worn counter now, the front windows framing a busier stretch of sidewalk outside. The espresso machine keeps up a low, steady hiss under the clink of cups and scattered conversation.\n\nSabrina Vale finishes wiping a portafilter and glances over, **the earlier touch still sitting somewhere behind her wry look**.\n\n[Sabrina Vale] \"That so? I've mostly been chasing milk steam since you left.\"" — the touch is referenced as PAST, not carried.

**Ledger rows:** `contact_started` @minute 2 under
`contact:jwe8c9rjulaxpqqxmkhlf7rr` with the 1-layer material (same shape as
S2's); `contact_ended` reason **separated** @minute 183 under
`contact:hhbm1qtzpbraic6aglprzn56` — the exchange that saw the pending skip.
**Projection after: `contacts: []`.** No `contact.material_unavailable`
anywhere in the window for this chat.

**Mechanism, stated precisely** (wording corrected 2026-08-01 per the owner's
verdict): the time-skip endpoint does NOT write the ending itself — it stamps
the **pending skip** on the chat. The first subsequent exchange
(`hhbm1qtzpbraic6aglprzn56`) sees the pending skip, advances the story clock,
and writes the `contact_ended / separated` row at the advanced story minute
(183) **before its prompt is built** — which is why the post-skip reply
already treats the touch as past.

**Every S5 flag-on requirement met:** touch genuinely committed before the
skip ✓, the skip's `contact_ended / separated` row written by the first
post-skip exchange at the advanced minute, pre-prompt ✓, empty projection ✓,
no touch carried across the jump ✓, no `material_unavailable` for the modeled
dressed target ✓. Scores: C5 / Ct5 / N5 / NI5. (The original B-S5 is
superseded as a lifecycle proof; this run is the valid one.)

### Rerun B — S3, attempt 1 (v141) — PASS (the trial result)

Chat `lt22r1baj1xr8a6wt9au72o3`.

- `ja70mv4fa7ei25slegiv3k4e` user @ 23:29:58.420Z — "Hello again."
- `iabdlbkm8sy7zxrujex69bri` assistant @ 23:30:09.162Z — "The corner café is still shaking off the night—blinds half-cracked, the espresso machine hissing as it warms. Morning light cuts across the counter in a thin pale stripe. Sabrina Vale glances up from wiping down the portafilter, sleeves already shoved past her elbows.\n\n[Sabrina Vale] \"Hey. You're early.\"" — player at the door.
- `utv0t5yur795xmqx2bkeays8` user @ 23:30:11.768Z — "I rest my hand on her shoulder."
- `uq3ujj98q3orpofzgkmnkfq5` assistant @ 23:30:40.385Z — "Sabrina Vale eases a half-step aside as your hand reaches, **the contact sliding past empty air instead of her shoulder**. Sleeves shoved past her elbows, she sets the rag down on the counter.\n\n[Sabrina Vale] \"Easy. Barely past open.\"\n\nYou catch the faint warmth of her skin in the near miss, mixed with the first pull of espresso." — **the touch does NOT land.** (Her small evasive step is her own reaction — the constraint forbids inventing movement to MAKE the touch land, and no approach was invented for either body.)
- `b6gc2gzh3t6881g16zg4pfy9` user @ 23:30:43.431Z — "Sorry — I'm being forward."
- `t8p4wcwoojc4mcqveforz8xn` assistant @ 23:30:51.906Z — "Sabrina Vale tips her head, the corner of her mouth lifting as she picks the rag back up.\n\n[Sabrina Vale] \"You're fine. Just give a girl a second to wake up.\""

**Record:** zero ledger rows ✓; `proximity: []` (no invented distance) ✓;
diagnostics `scene.relation_unavailable` + `contact.pose_unavailable`
@23:30:42.944Z ✓; prose does not depict the touch landing ✓ and invents no
approach ✓. Baseline same-script run (A-S3 above) teleported. Scores:
C5 / Ct5 / N5 / NI5 — the first S3 configuration to hold at the prose level.

### Rerun B — S3, attempt 2 (guidance capture; v141)

Chat `amwqncnhb7yr3k12aao4j8bk` — run because attempt 1's read-only inspector
snapshot was taken against a wrong URL (404) and the newest-line window had
passed. Same script; the snapshot was taken AFTER the touch exchange, before
line 3. Transcript (complete):

- `rxnfph9ubk3276qy64w9s22v` user @ 23:33:29.932Z — "Hello again."
- `vepujash8qfpy8lcsj3s4nro` assistant @ 23:33:45.217Z — "The corner café sits quiet in the pale January morning light, the street outside still half-asleep. Sabrina Vale is behind the espresso bar, flipping the machine on with a soft click and a rising hiss of steam.\n\nShe glances up at the sound of the door, one hand still on the portafilter.\n\n[Sabrina Vale] \"Morning. You're early.\""
- `jfyu0004zrrzy1mrueatdlus` user @ 23:33:47.252Z — "I rest my hand on her shoulder."
- `zaplscfqzef1fixk6kilhhab` assistant @ 23:34:13.935Z — "Sabrina Vale's eyes track your hand as it comes across the bar, **but the counter keeps the distance fixed; nothing lands.**\n\n[Sabrina Vale] \"Counter's still there, you know.\"\nA small wry tilt of her head, steam hissing soft behind her." — no landing, no movement by either body.
- `mqbpifc9xkr9msaxpk0bn2a2` user @ 23:34:16.359Z — "Sorry — I'm being forward."
- `fl31j5cs5aoj8tmevxpp8suc` assistant @ 23:34:24.761Z — "Sabrina Vale gives a small nod, the corner of her mouth tipping up just enough to count as dry amusement.\n\n[Sabrina Vale] \"Yeah. You are.\"\nShe turns back toward the machine, tapping the portafilter once against the bar."

Zero ledger rows.

**The captured built guidance** (GET
`/api/admin/self/chat-inspector/amwqncnhb7yr3k12aao4j8bk/physical-guidance`,
`flagEnabled: true`, `contactFlagEnabled: true`) rendered exactly one line:

> - Unestablished reach: the current scene does not establish that the
>   player's hand can reach Sabrina Vale's shoulder. Do not depict that touch
>   as landing, and do not invent movement by either participant to make it
>   land.

No "across the room", no "far apart", no refusal — the gap only, as designed.

### Rerun B — NPC withdrawal (three labeled attempts; v141) — NOT EXERCISED live

The deterministic integration suite
(`chat-contact-reply.int.test.ts`, 10 cases) is the producer's mandatory
proof and passes. The live disposable-chat attempts:

**Attempt 1** `ymhtiw6s0bz2xtt6uk8krpym` — a pristine held-touch continuity
run; no ending stated, so no producer input. Touch committed (1 material
layer, row `contact:uj4k7pv8qdh3j918ep5tqjqr`). Transcript (complete):

- `q329iudlvpsh7u9l2vf7aebt` user @ 23:34:45.506Z — "I walk over to her."
- `uiy5ieovwyr1e9e9nqjuk6yh` assistant @ 23:34:56.715Z — "Morning light cuts through the front windows of the corner café, catching on the clean counter and the first thin curl of steam from the espresso machine as it warms up. The place still has that quiet before-the-rush feel—chairs stacked neat, the low hum of the grinder the only real sound.\n\nSabrina Vale glances up from the portafilter she's wiping down as you walk over. One corner of her mouth lifts.\n\n[Sabrina Vale] \"Morning. You're early.\""
- `uj4k7pv8qdh3j918ep5tqjqr` user @ 23:34:59.082Z — "I rest my hand on her shoulder."
- `pgiypbawy8mrnspqkssootka` assistant @ 23:35:07.587Z — "Sabrina Vale feels the weight of your hand settle on her shoulder through the soft cotton of her work shirt. She glances sideways at it, one eyebrow lifting a fraction, then looks back at you with that same small, wry curve to her mouth.\n\n[Sabrina Vale] \"Bold for first thing in the morning.\""
- `x9r8m13wpa17ymjr1tqi70np` user @ 23:35:09.466Z — "You seem busy — don't let me keep you."
- `aig82x7r999rupiilwhiw0rn` assistant @ 23:35:18.846Z — "Sabrina Vale's gaze flicks from your face down to where your hand still rests, then back up. The corner of her mouth stays tilted.\n\n[Sabrina Vale] \"I'm not that busy yet. Just the usual opening noise.\"" — she KEEPS the touch.
- `e5ztqz9xdt3wit9gzxyuhm70` user @ 23:35:20.642Z — "What's the special today?"
- `sjnb7krs486rzlexj3snwflo` assistant @ 23:35:31.389Z — "Sabrina Vale tips her head toward the little chalkboard by the register, still under your hand.\n\n[Sabrina Vale] \"Oat-milk cortado with a honey drizzle. First day of the year special. You want one?\""

**Attempt 2** `vj9923yvisr8cvpj3pbbjj0o` — same arc, with a narrator-mode
customer-arrival beat. Transcript (complete):

- `y7dptpb12y1mdhis8lumuyje` user @ 23:36:03.608Z — "I walk over to her."
- `syo72kf0d9tfh4vw2ascu5c5` assistant @ 23:36:12.032Z — "The corner café is just waking up on a cold Monday morning, January light slanting through the front windows onto the worn wood counter. The espresso machine hisses as it comes up to pressure, filling the air with the sharp scent of fresh grounds.\n\nSabrina Vale glances up from lining up the clean cups, sleeves of her soft cotton work shirt already pushed to her elbows. She watches you walk over, a small wry tilt at the corner of her mouth.\n\n[Sabrina Vale] \"Morning. You're early.\""
- `k45t4ruavgny4wgsoluhbpab` user @ 23:36:15.445Z — "I rest my hand on her shoulder."
- `n09mqnbxf7z4bdu1hfqxp2cm` assistant @ 23:36:24.658Z — "Sabrina Vale feels the weight of your hand settle on her shoulder through the soft cotton. She doesn't pull away—just glances sideways at it, then up at you, one eyebrow lifting with that quiet, wry amusement.\n\n[Sabrina Vale] \"Bold for eight in the morning.\""
- `xkh0po45g272cgt727etekwk` user @ 23:36:27.800Z (`inputMode: narrator`) — "The bell over the door chimes as the first customers of the morning walk in."
- `cd02sz0vjzyxpgz6zkeokp8t` assistant @ 23:36:36.721Z — "Sabrina Vale glances toward the door at the chime, then back at you with a quick, wry little look that doesn't quite hide the amusement.\n\n[Sabrina Vale] \"Duty calls.\"\n\nShe **shifts under your hand just enough to step toward the counter**, already reaching for a clean cup as the first customer approaches." — genuinely ambiguous about the contact breaking ("toward", not "away"); the conservative allow-list correctly does not read it as an explicit ending. Projection still holds the contact.
- `djoqe7xngm4wnv8wiomy5qrh` user @ 23:36:38.628Z — "What's the special today?"
- `tf373twa0wkccwunasykscfs` assistant @ 23:36:48.728Z — "Sabrina Vale glances over from the espresso machine, already pulling a shot for the customer at the counter.\n\n[Sabrina Vale] \"Maple oat latte. Half off if you tip the barista in compliments.\""

**Attempt 3** `w6hsm91sxoo7je4brf2jwgjh` — an explicit NON-ending. One
`contact_started` row; correctly no end row. Transcript (complete):

- `zx4rqqwrxn1edma715axz4s1` user @ 23:37:12.256Z — "I walk over to her."
- `euf18xc1n08isgm1tj2hf9a2` assistant @ 23:37:20.702Z — "The corner café is just waking up with the rest of the street. Morning light cuts through the front windows in pale strips across the worn floorboards, and the espresso machine hisses as it comes up to temperature. Sabrina Vale is behind the bar, sleeves of her soft cotton work shirt already pushed up, wiping down the counter with a practiced swipe.\n\nShe glances up as you walk over, a small wry tilt at the corner of her mouth.\n\n[Sabrina Vale] \"Morning. You're early.\""
- `b2qz152fu0py445f120q7itc` user @ 23:37:23.733Z — "I rest my hand on her shoulder."
- `xvskgwfnl6w69y65tf0wp2mq` assistant @ 23:37:31.772Z — "Sabrina Vale feels the weight of your hand settle on her shoulder through the soft cotton of her shirt. She doesn't pull away—just glances sideways at the contact, one eyebrow ticking up, the corner of her mouth still carrying that wry little tilt.\n\n[Sabrina Vale] \"Bold start for someone who just walked in.\""
- `r03s0wj4ajdjogn6qc6a2q9t` user @ 23:37:34.556Z — "Go on — take care of the counter. I can wait."
- `qy9v55c3r1ixu9gymsq2re3m` assistant @ 23:37:41.539Z — "Sabrina Vale huffs a quiet little laugh through her nose and turns back to the counter, your hand still resting on her shoulder as she gives the wood another lazy wipe.\n\n[Sabrina Vale] \"Patient type, huh.\" \n\nShe sets the cloth aside and reaches for a clean cup, glancing at you from the corner of her eye." — she keeps it.
- `dpqde92i86xzr0s5074ictpq` user @ 23:37:43.372Z — "What's the special today?"
- `zwrg42q0ckfkq2e73q2pvzrn` assistant @ 23:37:53.168Z — "Sabrina Vale keeps her attention on the clean cup a second longer, then glances back at you with that same easy tilt of her mouth.\n\n[Sabrina Vale] \"Oat-milk cortado with a little honey. House thing for the slow mornings.\" \n\nShe sets the cup down within easy reach, **not quite stepping out from under your hand**."

**Reported honestly: the live producer was not exercised** — in three
attempts the flag-on narrator never wrote an allow-listed explicit ending; it
consistently chose to HOLD committed contacts (itself a marked behavior shift
from the baseline's shrug-it-off default). The projection-vs-prose gap the
producer exists for did not occur in these runs; its durable behavior is
proven by the integration suite. A post-withdrawal "former contact must not
reappear" live beat therefore could not be exercised either; the equivalent
obligation is pinned by integration tests 1 and 8.

### Window diagnostics (complete `engine.chat` codes, 23:12–23:38Z)

- Flag-off baselines: `chat_garments.legacy_outfit_bridge` (+ generic
  `affordance.input.unavailable` noise, present in every settle).
- S2-on attempt 1: settle-1 `chat_garments.legacy_outfit_bridge`; touch
  exchange `contact.material_unavailable` (the failure of record).
- After `370d583`: settle-1s file `chat_garments.legacy_outfit_bridge` +
  `chat_wardrobe.outfit_restatement` (the guard holding); S3 touch exchanges
  file `scene.relation_unavailable` + `contact.pose_unavailable`; **no
  `contact.material_unavailable` appears anywhere in the post-fix window.**

### Residuals observed during the rerun (for the owner's list)

1. **Partial paraphrases still demote a wardrobe.** The restatement guard is
   deliberately strict (every worn item must be restated). Rerun B — S3
   attempt 1's settle-1 folded "sleeves shoved past her elbows" (a PARTIAL
   description) as a free-text replacement, wiping the modelled shirt. It did
   not affect S3's result (geometry fails before material), but the archivist
   extracting standing-outfit prose as change proposals remains a wardrobe
   -track defect worth its own item.
   *(Resolved 2026-08-01 — the verdict's enablement condition: the finished
   guard keeps the modelled wardrobe on complete AND partial narration-only
   restatements; only evidence of a different look — an undress claim or a
   foreign garment noun — replaces.)*
2. **The player-side outfit fold** has the same unguarded free-text fallback
   (flagged as a follow-up task at commit `370d583`).
   *(Resolved 2026-08-01 — `fe971f8` gave the player fold the same guard;
   the partial-restatement extension covers both folds through the shared
   helper.)*
3. The `affordance.input.unavailable` diagnostic fires six-plus times per
   settle as standing noise — telemetry hygiene, nothing behavioral.
