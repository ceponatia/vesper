# Affectionate-contact trial — evidence appendix

Companion to [the trial report](romantic-contact-affordances.trial.md). This
document is the auditable record: every original A/B scenario and every rerun,
with full untruncated ids, verbatim transcripts, ledger rows, scene
projections, diagnostics, and per-axis scores. Every attempt is preserved and
labeled — including the rerun attempt that failed and the fix it exposed.
No credentials, connection strings, or session material appear here.

## Shared configuration

| Item | Value |
| --- | --- |
| App | `vesper` on Fly.io, `https://vesper.fly.dev` |
| Database | Neon project `round-sky-30947574` (production) |
| Account | dedicated QA account `uxtest-main@vesper.local` (`uxtestmaina1b2c3d4e5f6g7`) |
| Character | Sabrina Vale, id `wdijgtnp5dnosx3or16wwsvv` — every chat fresh-start (`memory: "fresh"`), 1-on-1 |
| Model | chat default: `z-ai/glm-5.2` via OpenRouter (per-model reasoning `effort: low`), temperature = the narrative default |
| Flags | `CHAT_CONTACT_ACTIONS` / `CHAT_PHYSICAL_CONSTRAINTS` — exact values per section below; **both off outside the labeled windows and returned to off after the runs** |
| Player wording | player lines sent via `POST /api/chats/:id {kind:"send"}`; the reply is the streamed text verbatim; timestamps are client wall-clock UTC around each stream |

**Deployments.**

| Window | Fly release | Git commit | Notes |
| --- | --- | --- | --- |
| Original trial (2026-07-31 19:20–19:57Z) | v13x (pre-1.2 build) | `875ddb7` lineage (item 1.1 build) | both flags ON for the window |
| Rerun flag-off baselines (23:12–23:14Z) | v139 | `7eb1ea1` (item 1.2) | flags off |
| Rerun flag-on attempt 1 (23:15–23:16Z) | v140 (same image as v139) | `7eb1ea1` | flags ON via secrets |
| Rerun flag-on attempts 2+ (23:27–23:38Z) | v141 | `370d583` (item 1.2 + wardrobe restatement guard) | flags ON |
| After the window | v142 | `370d583` | flags unset (off) |

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

| Scenario | Config A chat | Config B chat |
| --- | --- | --- |
| S1 approach/touch/release | `z0tlhojudqzlcqwri7po75gn` | `j7w7q40vnhk08zwzb15bilqi` |
| S2 move-away | `zamcimg2wks0a5bo283mgcec` | `whbzjjehvfu5cgqfo6rzmp8g` |
| S3 unreachable | `lqxpkkby2ednq5fmww0oh09n` | `i5tsnhquv8c3oo4nqsr1p24d` |
| S4 romantic veto | `drlq19sbofw802ieht87j076` | `s846492ywx34w11kg88bargb` |
| S5 skip | `es2qpgedogfxs5pvo1mfl4nx` | `rtrev99vg7geetv802j70bc6` |
| S6 object movement | `txixuysqd17l85rx7cu4xxgd` | `syyaiqp2dwmbwgtpret85jof` |

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

| guard | event_ref | seq | kind | contact_id | reason | story_minute | payload highlights |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `m5klutduf30i5sko42jxhn5j` | `contact:m5klutduf30i5sko42jxhn5j` | 0 | contact_started | `body␟player␟hands␟␟␞body␟wdijgtnp5dnosx3or16wwsvv␟shoulders␟␟␝contact:m5klutduf30i5sko42jxhn5j` | — | 2 | affectionate rest, pressure light, `materialBetween: []`, `directSkinContact: true` (the state said nothing was worn), actorControl allowed, policy/eligibility not_required |
| `myp9c520wfy09lris5mdra46` | `contact:myp9c520wfy09lris5mdra46` | 0 | contact_ended | same contact id | withdrawn | 4 | endedByEventRef = the release exchange's own ref |

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

#### A-S4 / B-S4 (romantic veto)

A-S4 `drlq19sbofw802ieht87j076`: `jyukp49xdld4x7x5sa6x0np5` "I walk over to
her." → `h8tyvi8nnszowmvjmw8whqrb` (café opening); `iv9120w16j19n3fga3sp8h8q`
"I kiss her." → `r9j1g3tht1lla1u57z3gy968` "Sabrina Vale stills as you lean
in, then turns her face just enough that your mouth brushes her cheek instead.
She eases half a step back along the bar, one hand coming up between you—not
shoving, just there. [Sabrina Vale] \"Hey—slow down. We haven't even done the
coffee part yet.\" A small, wry breath of a laugh. The scent of espresso and
warm milk clings close when she speaks."

B-S4 `s846492ywx34w11kg88bargb`: `zfrhst5ddk7gtd0ivwrtgeie` "I walk over to
her." → `andfuhh2afe4hqc11mlexvwt` (café opening); `znuuggcg2aucmzrq6fvespm1`
"I kiss her." → `i67v3zh5pp96x5ustft44wy5` "Sabrina Vale pulls back the second
your mouth meets hers, palm flat against your chest to hold the distance. Her
eyebrows lift, half amused, half startled. [Sabrina Vale] \"Whoa. We literally
just said hi.\""

**B-S4 record:** the ledger is EMPTY — no `contact.*` codes at all; the
romantic line never became an attempt. The veto held in production. ✓

#### A-S5 `es2qpgedogfxs5pvo1mfl4nx`

- `ewzlk1c6ivjtvy484ya5mqdv` user @ 19:34:19.913Z — "I walk over to her."
- `mvstasdfmahrkfagsx9hhaix` assistant @ 19:34:29.647Z — (café opening; "Coffee, or still deciding?")
- `aznfveh7v4ygvbot4no49ce3` user @ 19:34:43.613Z — "I rest my hand on her shoulder."
- `cdgalmuw4n6265fb4glu6utf` assistant @ 19:34:57.357Z — "…she eases half a step along the counter so the contact slides off on its own…"
- *(3-hour skip)* then `dwvlvkwx7ukpmrhgoo8t4g7e` user @ 19:35:38.230Z — "That was a nice morning."
- `oqeniag6fc8qet1z1lnqh1ei` assistant @ 19:35:52.514Z — clean post-skip beat (mid-morning, no stale touch).

#### B-S5 `rtrev99vg7geetv802j70bc6`

- `oq4tq200c6691jrbxejdaj3b` user @ 19:52:20.238Z — "I walk over to her."
- `j83rzecotll3blc8px1nu2be` assistant @ 19:52:28.079Z — (café opening, "sleeves pushed up")
- `kfrx5t29wq0aw58p3b94rrs1` user @ 19:53:01.349Z — "I rest my hand on her shoulder."
- `xeq4bg55rlh8jxrlzetpsc3o` assistant @ 19:53:15.525Z — "…eases a half-step so the touch slips off without drama…"
- *(3-hour skip)* then `aeginlvbzcyoychup5t3iaov` user @ 19:54:00.313Z — "That was a nice morning."
- `fgds38u5sd90hg4hw719phqa` assistant @ 19:54:17.525Z — clean post-skip beat ("the rush that hit after you left").

**B-S5 ledger rows: NONE — the touch never committed**
(`contact.material_unavailable`, dressed-unmodelled). The clean post-skip
prose therefore proves nothing about the skip's `separated` sweep: there was
nothing to sweep. **Not a valid contact-lifecycle proof.**

#### A-S6 / B-S6 (object movement / invented scene)

A-S6 `txixuysqd17l85rx7cu4xxgd`: approach (`phdmh2iauv0is33hf97zdb4g` /
`fergotplmdw1w4k4ienlxzfk`), touch (`s11t6esdjgfr0rnbvct5sm0v` /
`lyg2blhm8jki0o379tfxhfvw` — she eases back so the contact drops), "I walk
over to her desk." (`zfm8usgkixoijgpkjte3bin4` → `n5d33x3tm8ejy8y5avn6sl0i` —
prose INVENTS a back room and moves both bodies there), "I pick up the photo
frame." (`ozn1gff23k4in4wf8r1ho381` → `gbwruwkzsanh4yezzueqf2oa`). Double
teleport; held-touch continuity vanished silently. C2/Ct3.

B-S6 `syyaiqp2dwmbwgtpret85jof`: approach (`e80f4pmpv67lqpaapzz7pn1l` /
`w9vacohljjzxszdh6mvsiq8k`), touch (`v128hcbpx09rq1mhagemendp` /
`fgigdwz16zrilif8665s9cyr` — "the warmth of her shoulder solid **through the
thin cotton of her shirt**"; note the STATE's material read was `[]`/direct —
the cotton is the model's own line, not the machinery's), desk line
(`xdame1lrkhcowsm0ovj42b3t` → `r6bilx4r6843itz81ou5hzrs` — prose still invents
the desk scene), frame line (`s1h7msmpesyg5dfck2xvr3hd` →
`ju3foizkn7hdn7trsmpejlzp`).

**B-S6 ledger rows** (complete):

| guard | event_ref | seq | kind | reason | story_minute |
| --- | --- | --- | --- | --- | --- |
| `v128hcbpx09rq1mhagemendp` | `contact:v128hcbpx09rq1mhagemendp` | 0 | contact_started | — | 2 |
| `xdame1lrkhcowsm0ovj42b3t` | `contact:xdame1lrkhcowsm0ovj42b3t` | 0 | contact_ended | scene_changed | 3 |

State-level win (the held touch ended durably through the place change);
prose-level failure (the invented desk scene still rendered). Partial.

---

## Part 2 — the reruns (2026-07-31, 23:12–23:38 UTC)

Fresh disposable chats; the EXACT original per-scenario scripts; flag-on lines
sent as soon as the prior stream completed (intervals recorded — no artificial
coverage-settlement delay anywhere). First configured runs are the trial
results; extra attempts are labeled.

### Rerun chat ids (full)

| Run | Flags | Chat id |
| --- | --- | --- |
| Rerun A — S2 | off | `f9ec0k1fn7lp3fkbiey6at6z` |
| Rerun A — S5 | off | `vibrhbd7g8pe5j8g4e0jream` |
| Rerun A — S3 | off | `hl8250gr81qd13aktazzd7xd` |
| Rerun B — S2 attempt 1 | on | `pdgfkcouaaviu2vyuuesfwgl` |
| Rerun B — S2 attempt 2 | on | `aqs0qog98ycgp3tzmp5komak` |
| Rerun B — S5 | on | `bhv7n9chmz2xxf4wahhabi68` |
| Rerun B — S3 attempt 1 | on | `lt22r1baj1xr8a6wt9au72o3` |
| Rerun B — S3 attempt 2 (guidance capture) | on | `amwqncnhb7yr3k12aao4j8bk` |
| Rerun B — NPC withdrawal attempts 1–3 | on | `ymhtiw6s0bz2xtt6uk8krpym`, `vj9923yvisr8cvpj3pbbjj0o`, `w6hsm91sxoo7je4brf2jwgjh` |

### Rerun A (flag-off baselines, v139)

**A-S2** `f9ec0k1fn7lp3fkbiey6at6z` — messages `xtkdq8r1frybzvizxytznaf4`
("I walk over to her.", 23:12:10.907Z) → `c50itlim4th3mezjc8lruebi`;
`hgm6aj4v378zngof8ygneb9r` ("I rest my hand on her shoulder.") →
`bb1mqxgsc1zn6hlgpx8a0bfz` ("…She shifts a half-step along the counter, enough
that the contact slips off without a fuss. The cotton of her work shirt is
warm under your palm for that second before it goes."); `b3oncfrdjbmgehd0qbsrsa1g`
("I step back.") → `ujxvzqodqrfu9l1ccdsbn4qq` ("There we go.");
`ei3apqzcyy0ixkjtsgxocbrb` ("What were you saying earlier?") →
`w75zhda7k797t3ec37pf0hm0`. Baseline shape: she pre-ends the touch herself
(the she-always-shrugs-it-off default). Zero ledger rows, empty scene —
correct for flags off.

**A-S5** `vibrhbd7g8pe5j8g4e0jream` — same arc; touch reply
`d47nog2j4m4ogn51dzccrfow` (pre-ends it); `hours` skip; post-skip beat clean.
Zero rows.

**A-S3** `hl8250gr81qd13aktazzd7xd` — "Hello again." →
`rz6rfswpwop6dr0vxv45fbhm`; touch → `k7w0z7h1cxeezmq4xzimmkcr` "Sabrina Vale
stills under your hand for half a beat…" — **the baseline teleport,
reproduced**: player at the door, touch lands instantly. Zero rows (flags
off).

### Rerun B — S2, attempt 1 (v140, image `7eb1ea1`) — FAILED, preserved

Chat `pdgfkcouaaviu2vyuuesfwgl`. Lines/replies (full):

1. `imzppboqrtk45in8odop8a7z` "I walk over to her." (23:15:30.480Z) →
   `wefc36d3r7d70eowwvwf9jjq` — opening names "a soft cotton work shirt with
   the sleeves shoved up".
2. `tv23rndkf03kybp505i7uizm` "I rest my hand on her shoulder."
   (23:15:46.014Z, **0.2s after the prior stream closed**) →
   `z68fshy1oec0lovgkqgitn5k` — "She shifts just enough that the contact
   slides off… The cotton of her sleeve is still warm where you brushed it."
3. `b4yt4emu7ofjn76b2zvrg5y1` "I step back." → `lfhraj7k7hp8wlttf786ibyo`.
4. `e3mmpcqh8anqkn2amtgujb46` "What were you saying earlier?" →
   `mfiyx6yntnui56y2j5lsx3nk`.

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

1. `o6se5gk8ds4574hnzx2yh8da` "I walk over to her." →
   `t1nuh1c3wesdxa12dz6jqzf5` — "…Sabrina Vale wipes down the bar, sleeves of
   her soft cotton work shirt pushed up… [Sabrina Vale] \"Morning. What can I
   get you?\""
2. `hfd48gsby9ts24716zvm26lk` "I rest my hand on her shoulder." →
   `lushggzlyttbxmrd7mz296jp` — "Sabrina Vale stills under the weight of your
   hand on her shoulder, **the cotton of her work shirt warm between you**.
   …\"Bold start for a Monday.\" …\"Coffee, or did you just come to lean?\"" —
   the touch HELD, and the material reached the prose.
3. `f1nzendkis4xwq42ixgp4zoe` "I step back." → `kcfkygk6tfcrkmwmdwxrzpnm` —
   "Sabrina Vale's shoulder eases as you step back… \"There we go.\""
4. `e6eblxvj1u7dhaw7rt3ienus` "What were you saying earlier?" →
   `xdsp5gzganz8k7jkl0r9oj10` — no resurrection.

**Ledger rows (complete):**

| guard | event_ref | seq | kind | reason | story_minute | payload (decisive fields) |
| --- | --- | --- | --- | --- | --- | --- |
| `hfd48gsby9ts24716zvm26lk` | `contact:hfd48gsby9ts24716zvm26lk` | 0 | contact_started | — | 2 | `materialBetween: [{layerId: "osj9y0tvpcplggns5vljdgev:root", order: 0, tactileTransmission: 6000, thermalTransmission: 4000, moistureTransmission: 0, visibleThrough: false, evidence: [{kind: "coverage", ref: "coverage:shoulders", detail: "opaque"}]}]` — **the cloth layer, from the CURRENT cut with no persisted capture and no settle wait** |
| `f1nzendkis4xwq42ixgp4zoe` | `contact:f1nzendkis4xwq42ixgp4zoe` | 0 | contact_ended | **separated** | 3 | same contact id; endedBy the step-back exchange's ref |

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

1. `h621qxadoimtq9kho1ubyplg` "I walk over to her." → `jat40ixz56ko4qxvr6jcpgd2`.
2. `jwe8c9rjulaxpqqxmkhlf7rr` "I rest my hand on her shoulder."
   (0.3s after the prior close) → `rol6vlkpoyt26zu36wuqvp3y` — "…the soft
   cotton of her work shirt warm from the espresso machine's heat…" — held.
3. `POST /time-skip {amount: "hours"}` @23:29:12.437Z (0.015s after close) —
   +180 story minutes.
4. `hhbm1qtzpbraic6aglprzn56` "That was a nice morning." →
   `jkcjxpc91ifrkyvl5oyyh3wm` — "Late-morning light… Sabrina Vale finishes
   wiping a portafilter and glances over, **the earlier touch still sitting
   somewhere behind her wry look**. \"That so? I've mostly been chasing milk
   steam since you left.\"" — the touch is referenced as PAST, not carried.

**Ledger rows:** `contact_started` @minute 2 under
`contact:jwe8c9rjulaxpqqxmkhlf7rr` with the 1-layer material (same shape as
S2's); `contact_ended` reason **separated** @minute 183 under
`contact:hhbm1qtzpbraic6aglprzn56` — the exchange that saw the pending skip.
**Projection after: `contacts: []`.** No `contact.material_unavailable`
anywhere in the window for this chat.

**Every S5 flag-on requirement met:** touch genuinely committed before the
skip ✓, skip wrote `contact_ended / separated` ✓, empty projection ✓, no
touch carried across the jump ✓, no `material_unavailable` for the modeled
dressed target ✓. Scores: C5 / Ct5 / N5 / NI5. (The original B-S5 is
superseded as a lifecycle proof; this run is the valid one.)

### Rerun B — S3, attempt 1 (v141) — PASS (the trial result)

Chat `lt22r1baj1xr8a6wt9au72o3`.

1. `ja70mv4fa7ei25slegiv3k4e` "Hello again." → `iabdlbkm8sy7zxrujex69bri` —
   player at the door.
2. `utv0t5yur795xmqx2bkeays8` "I rest my hand on her shoulder." →
   `uq3ujj98q3orpofzgkmnkfq5` — "Sabrina Vale eases a half-step aside as your
   hand reaches, **the contact sliding past empty air instead of her
   shoulder**… You catch the faint warmth of her skin in the near miss…" —
   **the touch does NOT land.** (Her small evasive step is her own reaction —
   the constraint forbids inventing movement to MAKE the touch land, and no
   approach was invented for either body.)
3. `b6gc2gzh3t6881g16zg4pfy9` "Sorry — I'm being forward." →
   `t8p4wcwoojc4mcqveforz8xn`.

**Record:** zero ledger rows ✓; `proximity: []` (no invented distance) ✓;
diagnostics `scene.relation_unavailable` + `contact.pose_unavailable`
@23:30:42.944Z ✓; prose does not depict the touch landing ✓ and invents no
approach ✓. Baseline same-script run (A-S3 above) teleported. Scores:
C5 / Ct5 / N5 / NI5 — the first S3 configuration to hold at the prose level.

### Rerun B — S3, attempt 2 (guidance capture; v141)

Chat `amwqncnhb7yr3k12aao4j8bk` — run because attempt 1's read-only inspector
snapshot was taken against a wrong URL (404) and the newest-line window had
passed. Same script; the snapshot was taken AFTER the touch exchange, before
line 3 (messages `rxnfph9ubk3276qy64w9s22v`, `jfyu0004zrrzy1mrueatdlus`,
`mqbpifc9xkr9msaxpk0bn2a2` + replies). The touch reply
(`zaplscfqzef1fixk6kilhhab`): "Sabrina Vale's eyes track your hand as it
comes across the bar, **but the counter keeps the distance fixed; nothing
lands.** \"Counter's still there, you know.\"" — no landing, no movement by
either body. Zero ledger rows.

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

- **Attempt 1** `ymhtiw6s0bz2xtt6uk8krpym`: approach → touch (committed, 1
  material layer, row `contact:uj4k7pv8qdh3j918ep5tqjqr`) → "You seem busy —
  don't let me keep you." → she KEEPS the touch ("your hand still rests…"),
  then "What's the special today?" → "…still under your hand." A pristine
  held-touch continuity run; no ending stated, so no producer input.
- **Attempt 2** `vj9923yvisr8cvpj3pbbjj0o`: same arc; narrator-mode beat "The
  bell over the door chimes as the first customers of the morning walk in."
  (message `xkh0po45g272cgt727etekwk`, `inputMode: narrator`) → reply
  `cd02sz0vjzyxpgz6zkeokp8t`: "She **shifts under your hand just enough to
  step toward the counter**…" — genuinely ambiguous about the contact
  breaking ("toward", not "away"); the conservative allow-list correctly does
  not read it as an explicit ending. Projection still holds the contact.
- **Attempt 3** `w6hsm91sxoo7je4brf2jwgjh`: "Go on — take care of the
  counter. I can wait." → she keeps it ("your hand still resting on her
  shoulder"), later "**not quite stepping out from under your hand**" — an
  explicit NON-ending. One `contact_started` row; correctly no end row.

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
2. **The player-side outfit fold** has the same unguarded free-text fallback
   (flagged as a follow-up task at commit `370d583`).
3. The `affordance.input.unavailable` diagnostic fires six-plus times per
   settle as standing noise — telemetry hygiene, nothing behavioral.
