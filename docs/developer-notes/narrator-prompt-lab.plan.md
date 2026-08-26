# Narrator Prompt Lab

Status: active

Outcome: The owner can create, edit, duplicate, delete, and select named handwritten narrator instruction prompts, then use one as a per-conversation experiment in Character Chat without removing Vesper's authoritative world/character context, runtime constraints, or machine response contracts. Every generated take records enough provenance to identify the exact test prompt revision and narrator model that produced it.

## Why

Vesper's narrator prompt has become a substantial part of gameplay behavior. Today, testing a materially different narrator instruction strategy means editing code, rebuilding/deploying, and then trying to remember which build produced which result. That makes prompt experiments slow, discourages larger rewrites, and makes comparisons hard to trust.

The Prompt Lab turns narrator instructions into an explicit experimental surface. The owner can write a prompt such as:

> You are the narrator for a roleplaying game and embody all NPCs. Never speak on behalf of the player. Resolve the immediate beat before advancing the scene...

save it under a name, select it for one conversation, and compare that conversation against another conversation still using Vesper's production narrator instructions. A prompt can be duplicated to create an independent variant, while revision history preserves the exact text used by earlier generations.

This is deliberately **not** a raw replacement for every byte Vesper currently calls a system prompt. In the legacy chat lane, the system prompt also carries identity, authored profile, relationship state, memory, current meters/conditions, scene state, physical guidance, sensory permissions and other runtime facts. In the successor lane, the narrator prompt additionally carries committed world truth, opaque beat/effect handles and a strict structured-output contract used by the parser and presentation audit. Replacing all of that with handwritten text would test "a new prompt with Vesper's grounding removed," not a new narrator instruction strategy.

The experiment therefore replaces only the narrator's **behavior/craft instruction layer**. Vesper continues to supply authoritative context, current-turn constraints, safety/integrity fences, and required transport/output contracts. This makes production-vs-test comparisons interpretable: the facts stay the same; the narrator's instructions change.

## Product rulings

### 1. The tool is the Narrator Prompt Lab

The owner-admin username menu gains a standalone **Narrator prompts** entry alongside the existing image tools and Engine Comparison. The page is a developer tool, not account settings and not a character-authoring field.

Suggested route: `/settings/narrator-prompts`.

### 2. v1 is owner-admin only

This is an experimental developer surface. Both the page and every backing API re-check the owner-admin role server-side. Hiding the menu entry is convenience only, not authorization.

The persisted rows are also owner-scoped so the design remains safe if the feature is widened later.

### 3. Prompt selection belongs to a conversation

A test prompt is selected **per `character_chat`**, not per character.

The existing narrator-model pick is character-level because it is a general preference reused across that character's conversations. Prompt experiments need the opposite behavior: two conversations with the same character must be able to run different instruction prompts for parallel A/B testing.

The selection is operational configuration, not story state. It is not part of `ChatScenario`, is not copied into scenario presets, and is not rolled back by state reset, regenerate, rerun, or simulation rollback.

### 4. A selected prompt replaces behavior/craft instructions, not runtime truth

The custom body may replace production instructions about:

- narrator role and NPC embodiment;
- player agency;
- prose camera/viewpoint style;
- dialogue/attribution style;
- pacing and forward movement;
- prose richness and scene texture;
- topic discipline;
- character expression/initiative;
- sensory-description habits;
- other narrator craft behavior that is presently authored as instruction text.

It does **not** replace:

- authored character/player data;
- relationship, memory, scene, state, wardrobe or visual-state context;
- committed simulation truth;
- current-turn physical/perception constraints;
- untrusted-data fencing;
- minor/content integrity fences that are required independently of prose style;
- opaque handle/ID rules;
- structured output schemas and parser contracts;
- retry correction blocks;
- transport mechanics required to persist or audit a reply.

The concrete section classification is an implementation detail, but this authority boundary is product law.

### 5. Saved prompts have immutable revisions

A prompt has a stable template identity plus immutable body revisions.

Editing the prompt and pressing **Save** creates revision `N + 1`; it does not overwrite the previous body. Conversations select the template, not a permanently pinned revision, so they receive the template's newest saved revision beginning with their next exchange.

The editor warns when a prompt is currently in use, for example:

> Used by 3 conversations. Saving will apply revision 5 to their next replies.

One exchange resolves one exact revision after taking its exchange lock, and that revision remains frozen for generation, hidden retries, audit, settlement and provenance even if the template is edited in another browser tab while the reply is streaming.

### 6. Duplicate creates an independent experiment

**Duplicate** creates a new template with:

- a new template id;
- revision 1 containing the source template's current body and notes;
- a derived name such as `Player Agency Minimal — Copy`;
- no selected conversations;
- optional `duplicated_from_id` provenance.

Duplication is the version-branching workflow. Revision history explains what a template used to contain; duplication creates a variant that may diverge independently.

### 7. Delete removes the active template but preserves historical provenance

Delete is soft in v1.

Deleting a template:

1. hides it from normal Prompt Lab lists;
2. clears it from conversations currently selecting it;
3. makes those conversations fall back to Vesper production instructions on their next exchange;
4. preserves immutable historical revisions so older reply/take provenance still resolves.

A permanent purge is out of scope.

### 8. No autosave

The prompt editor uses explicit **Save**. A saved body is an experimental revision, so an accidental keystroke must not silently alter every attached conversation.

Optimistic concurrency prevents two browser tabs from silently overwriting one another: a save made from stale revision `N` after revision `N + 1` already exists returns `409 prompt_conflict` and asks the editor to reload/merge.

### 9. Variables are a separate follow-on

v1 bodies are literal text. Braces and similar syntax have no special meaning.

Agent/state variables, interpolation, conditionals and a template compiler are explicitly deferred to a separate plan. They introduce a language, typed variable catalog, authority/visibility rules and deterministic compilation, and should not be smuggled into the storage/UI work here.

The persistence schema reserves a `template_language` value of `plain_v0` so future syntax can be opt-in rather than retroactively interpreting braces in old handwritten prompts.

## What the owner gets

### Prompt Lab page

A master/detail developer page:

**Library pane**

- searchable saved-prompt list;
- name;
- current revision;
- last modified time;
- count of conversations currently using the template;
- **New prompt** action.

**Editor pane**

- prompt name;
- optional hypothesis/notes field;
- large monospaced body editor;
- current revision;
- unsaved-change indicator;
- character count;
- approximate token count;
- **Save**, **Duplicate**, and **Delete** actions.

A new prompt may start with a small editable example, but the body is otherwise unconstrained prose.

Recommended limits:

- name: 120 characters;
- notes: 2,000 characters;
- body: 64,000 characters;
- warn in the UI before the body approaches the supported context budget.

The body limit is storage/product policy, not a promise that every selected narrator model can fit a 64K-character custom prompt plus Vesper context. The runtime still owns context-fit handling for the effective narrator model.

### Conversation control

The Character Chat conversation menu gains an owner-admin selector immediately around the existing narrator-model/agent experiment controls:

> **Narrator instructions (admin)**
> - Vesper production prompt
> - Player Agency Minimal
> - Strict Physical Narrator
> - Dialogue-Heavy Test

Helper copy states that the choice replaces narrator behavior instructions while Vesper still supplies character/world state, memory, constraints and required response format.

The selection saves immediately and applies to the next exchange.

When a test prompt is active, the conversation shows a persistent developer badge outside the closed menu, for example:

> TEST PROMPT · Player Agency Minimal v4

The badge links to the Prompt Lab template. The purpose is not decoration: an easy-to-forget override would eventually turn prompt-specific behavior into a false production bug report.

## Persistence

### `narrator_prompt_templates`

Suggested columns:

```text
id
owner_id
name
notes
current_revision
current_revision_id
created_at
updated_at
deleted_at
```

Recommended invariants:

- owner-scoped;
- active names unique case-insensitively per owner;
- `deleted_at` hides the row from ordinary lists;
- `current_revision_id` always points to the template's current immutable revision;
- deleting the owner cascades templates/revisions.

### `narrator_prompt_revisions`

Suggested columns:

```text
id
template_id
revision
body
body_hash
template_language
created_at
```

Recommended invariants:

- `(template_id, revision)` unique;
- revisions immutable after insert;
- `body_hash` is deterministic over the stored body and language version;
- `template_language` is `plain_v0` for every v1 row.

### `character_chats`

Add:

```text
narrator_prompt_template_id nullable
```

This is operational configuration. It should be stored beside `agent_reasoning_profile`, `scene_composer_model` and the other per-chat experiment switches rather than inside the resettable chat-state projection.

Whether the column uses a database FK or the app's existing soft-pointer style is an implementation ruling for the coding pass. Whichever is chosen, owner checks are mandatory and deleting/soft-deleting a template must never leave a live chat unable to narrate: missing/deleted selection degrades to production instructions with an observable diagnostic.

## API shape

Owner-admin CRUD routes:

```text
GET    /api/admin/self/narrator-prompts
POST   /api/admin/self/narrator-prompts
GET    /api/admin/self/narrator-prompts/:promptId
PATCH  /api/admin/self/narrator-prompts/:promptId
DELETE /api/admin/self/narrator-prompts/:promptId
POST   /api/admin/self/narrator-prompts/:promptId/duplicate
```

Per-chat operational route:

```text
GET   /api/admin/self/narrator-prompt/:chatId
PATCH /api/admin/self/narrator-prompt/:chatId
```

**Corrected during the build (2026-08-26):** this section originally suggested
CRUD under a bare `/api/admin/…`. The owner-admin route wrapper fails closed for
any path outside `/api/admin/self`, so those routes would have answered 404 by
construction. Everything the owner-admin role reaches lives under `/self/`,
whether it is a collection or a single conversation's setting.

The chat PATCH accepts only:

```ts
{ promptId: string | null }
```

A normal chat-send request must **not** accept raw prompt text, arbitrary revision bodies, or a one-call prompt id override. The server resolves the selected template from the owned chat. This keeps authorization/provenance server-owned and prevents request-level prompt spoofing.

## Narrator instruction source

Introduce one typed source resolved for an exchange:

```ts
type NarratorInstructionSource =
  | {
      kind: "production";
      instructionHash: string;
    }
  | {
      kind: "test";
      templateId: string;
      templateName: string;
      revisionId: string;
      revision: number;
      body: string;
      bodyHash: string;
      templateLanguage: "plain_v0";
    };
```

Resolution happens **after the conversation exchange lock is acquired** and before narrator prompt construction. That source is then reused unchanged by every narrator attempt associated with the exchange.

The ordinary chat route already forks between legacy and successor authority. Resolve the operational instruction source before entering the narrator build/call for either lane so both consume the same contract rather than implementing independent selectors.

## Prompt composition boundary

The implementation should move toward explicit prompt-section authority rather than editing giant concatenated strings ad hoc.

A useful internal shape is:

```ts
type NarratorPromptSectionAuthority =
  | "behavior"
  | "runtime_context"
  | "runtime_invariant"
  | "transport_contract";

interface NarratorPromptSection {
  id: string;
  authority: NarratorPromptSectionAuthority;
  stability: "stable" | "volatile";
  placement: "system" | "turn";
  text: string;
}
```

This exact type is not normative. The normative property is that every replaceable production instruction is distinguishable from context/invariants/contracts, so the test assembler can swap the former without accidentally deleting the latter.

### Legacy one-on-one chat

The existing production builder currently separates a stable prefix from a volatile tail for provider prefix caching, and the optional `turn_context` layout moves the volatile tail beside the current player input.

The Prompt Lab must preserve those placement/caching semantics:

- production with no override stays byte-identical;
- a test prompt replaces the classified behavior/craft sections;
- identity, profile, persona, relationship, memory and other runtime context remain;
- physical guidance, perception/sensory ceilings and other selected per-turn invariants remain;
- `system_tail` and `turn_context` keep their current placement behavior;
- current player input is still fenced/wrapped by the current lane rules rather than pasted into the custom body.

### Legacy ensemble chat

The ensemble builder receives the same instruction source and follows the same replacement law while retaining:

- roster and presence truth;
- per-member authored sheets/state;
- pair relationships;
- scene/supporting cast/plans;
- ensemble-specific runtime invariants;
- current-turn notes and synthetic cues.

A custom prompt may change general narrator behavior, but it does not erase the fact that an ensemble reply has multiple NPCs and a fixed player-authority boundary.

### Successor co-present narrator

The successor renderer keeps:

- the persisted/hash-verified `NarrativeCut`;
- authored canon/presentation state;
- committed truth;
- deterministic beat/effect handles;
- strict JSON response schema instructions;
- trust-boundary parsing;
- structural presentation audit;
- hidden targeted retry correction;
- effect confirmation behavior.

Only the narrator behavior/craft instruction layer is replaceable.

A hidden retry rebuilds the runtime/correction prompt as it does today, but the same resolved custom revision remains fixed across attempts.

### Successor solo narrator

Solo rendering follows the selected prompt too. Leaving the primary character's physical scene must not silently switch the conversation back to production narrator behavior.

The solo renderer keeps its own required current-world context, output contract, normalization/audit and deterministic fallback rules.

## Agent isolation

The Prompt Lab is narrator-only.

The selected prompt must not reach:

- reaction pulse/state agents;
- memory extraction or archivist;
- visual extraction;
- physical/contact classifiers;
- permission classifiers;
- scene composer;
- meanwhile/off-screen agents;
- successor deliberator;
- any other structured helper.

The only consumers are the prose-producing narrator paths: legacy one-on-one/ensemble, successor co-present, and successor solo.

## Provenance

Prompt experimentation is not useful if the app cannot later answer "which prompt made this take?"

Every generated assistant take should carry a compact narrator-run provenance record. Suggested shape:

```ts
interface NarratorRunProvenance {
  lane: "legacy_chat" | "successor";
  modelId: string;

  promptSource: "production" | "test";
  templateId?: string;
  templateName?: string;
  revisionId?: string;
  revision?: number;

  instructionHash: string;
  assembledSystemHash: string;
  mode: "instruction_override_v1";

  attempts?: number;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}
```

The exact fields may reuse existing completion/model metadata rather than duplicating it. The required facts are:

- lane;
- effective model;
- production vs test source;
- exact template revision when test source;
- stable content hash sufficient to identify the instruction body used.

Do **not** store the full assembled Vesper prompt on every message. Immutable test revisions retain the custom body, and hashes/provenance identify the assembly without copying large runtime prompts throughout the transcript.

### Alternate takes

The existing take ring must gain optional provenance while remaining backward-compatible with historical take objects.

On the first regenerate that converts the row's current content into a browsable historical take, the current take keeps the provenance that originally generated it. The newly generated take records the newly resolved prompt/model provenance.

This enables the most useful manual A/B workflow:

1. generate a reply with production instructions;
2. select a test template;
3. request **another take**;
4. rollback restores the same pre-exchange story state;
5. the replacement generation uses the test prompt;
6. both takes remain browsable and visibly labeled by model and prompt revision.

A future evaluator can then compare like-for-like takes instead of relying on memory.

## Failure and degradation rules

Prompt experimentation must not create a new class of dead-ended conversations.

- Selected template missing or soft-deleted at exchange resolution: use production instructions and emit an operational diagnostic.
- Selected current revision missing/corrupt: use production instructions and emit an operational diagnostic.
- Custom body empty: allowed only if product/UI explicitly permits it; if allowed, it means "no replaceable handwritten behavior text" rather than deleting runtime invariants/contracts.
- Assembled prompt exceeds the effective model's supported context: use the narrator lane's truthful context-window failure/degradation policy; never silently truncate authoritative runtime state to make the custom prompt fit.
- Invalid `template_language`: reject at persistence/parse boundary; an unknown future language never executes as `plain_v0` by guess.

## Package ruling

**Do not create a new monorepo package for v1.**

Vesper's package rule is that a folder graduates to a workspace package when it has become a subsystem that operates without knowing about the database, routes or game application. Prompt Lab v1 is intentionally dominated by app concerns: owner-scoped persistence, admin APIs/UI, `character_chats` operational configuration and integration with Vesper-specific narrator builders.

Keep the pure prompt-composition seam organized so it could later be extracted, but do not pay the package-boundary cost prematurely.

The separate variables/template-language follow-on is the likely package candidate. A deterministic parser/compiler, AST, conditional/fallback syntax, variable-reference extraction and expansion limits can become an app-independent subsystem once there are multiple consumers. That work is explicitly not part of this plan.

## Slices

### Slice 1 — establish the replaceable instruction boundary

Status: built 2026-08-26.

- Introduce the typed narrator instruction source.
- Classify/extract the existing production behavior/craft instruction units from runtime context and transport contracts.
- Add override-aware composition for:
  - legacy one-on-one `system_tail`;
  - legacy one-on-one `turn_context`;
  - legacy ensemble;
  - successor co-present;
  - successor solo.
- No persistence or UI yet; tests inject a custom source directly.
- Preserve all existing output parsing, speaker-tag normalization, retries and audits.

**Gate:** with `kind: "production"`, existing narrator prompt snapshots and call behavior are byte-identical wherever they are byte-pinned today. This slice is a seam extraction, not a production prompt rewrite.

### Slice 2 — persist templates and immutable revisions

Status: built 2026-08-26; the migration is generated but not applied.

- Add template/revision tables and migration.
- Add `character_chats.narrator_prompt_template_id`.
- Add server-side schemas/services for list/read/create/save/duplicate/soft-delete.
- Implement optimistic revision concurrency.
- Enforce owner-admin role and owner scoping.
- Make missing/deleted selections degrade to production instructions.

**Gate:** CRUD/revision integration tests prove no cross-owner read/write and no stale-save overwrite.

### Slice 3 — Prompt Lab canvas

Status: built 2026-08-26; unexercised until the migration is applied.

- Add username-menu entry.
- Build master/detail library/editor page.
- Add explicit Save, Duplicate and Delete.
- Add dirty-state navigation protection.
- Show revision, usage count, character count and approximate token count.
- Show conflict recovery for a stale save.

**Gate:** an owner can create, edit to a second revision, duplicate, delete and recover from a stale editor without using an API client.

### Slice 4 — per-conversation selector and active badge

Status: built 2026-08-26; unexercised until the migration is applied.

- Add dedicated owner-admin per-chat GET/PATCH route.
- Add selector to the Character Chat conversation menu.
- Add persistent active-test badge with prompt name/revision and edit link.
- Ensure selection is conversation-scoped and is not included in scenario preset/state-edit flows.

**Gate:** two conversations containing the same primary character may select different test prompts without changing the character or one another.

### Slice 5 — wire the live narrator lanes

Status: built 2026-08-26; never run on a real exchange.

- Resolve one exact instruction source/revision under the exchange lock.
- Carry it into legacy one-on-one/ensemble narration.
- Carry it into successor co-present/solo narration.
- Freeze the resolved revision through hidden retries and settlement.
- Keep all helper agents and successor deliberation on their existing prompts.
- Preserve narrator model selection as an independent axis.

**Gate:** test-vs-production fixtures prove that authoritative runtime context remains present and only the classified behavior/craft layer changes.

### Slice 6 — take-level provenance

Status: built 2026-08-26; never run on a real exchange.

- Add prompt/model provenance to assistant messages/takes using backward-compatible schemas.
- Preserve provenance when the current content becomes the first historical take.
- Record new provenance on regenerate/rerun where those operations exist.
- Surface compact model + prompt revision labels in the take browser for owner-admin users.

**Gate:** a production take and a regenerated custom-prompt take over the same exchange can be browsed later and unambiguously identified.

### Slice 7 — hardening and owner rollout

Status: not started.

Cover at minimum:

- production byte-parity snapshots;
- owner/admin authorization and IDOR attempts;
- case-insensitive active-name uniqueness;
- revision conflict behavior;
- duplicate independence;
- soft delete clearing live selections;
- parallel-chat isolation;
- mid-stream template edit/selection change applying only to the next exchange;
- legacy 1:1, legacy ensemble and `turn_context` coverage;
- successor co-present and solo coverage;
- hidden retry using one fixed revision;
- helper-agent non-interference;
- context-overflow honesty;
- historical take provenance compatibility.

No feature flag is required if the nullable chat selection defaults to production behavior and the no-override build remains byte-identical. The owner-admin UI itself is the opt-in surface.

## Success criteria

The plan is complete when all of the following are true:

- The owner can create, name, edit, duplicate and soft-delete handwritten narrator prompts from the UI.
- Every save creates an immutable revision, and stale editors cannot silently overwrite a newer revision.
- One conversation can select a test prompt while another conversation with the same character remains on production or selects a different test prompt.
- A visible in-chat indicator makes an active override difficult to forget.
- The custom prompt changes only narrator behavior/craft instructions; the same authoritative character/world state, memory, current-turn constraints and output contracts remain available to the narrator.
- Legacy one-on-one, legacy ensemble, successor co-present and successor solo narration all honor the selected prompt.
- Helper agents and the successor deliberator are completely unaffected.
- Production/no-selection behavior remains byte-identical at the prompt boundaries covered by existing snapshots.
- One exchange uses one immutable resolved revision across all hidden retries even if the template changes mid-stream.
- Alternate takes preserve the exact model and prompt revision that produced each one.
- A deleted/missing test prompt never dead-ends gameplay; the conversation falls back to production instructions with an observable diagnostic.
- No prompt variables, dynamic object traversal or agent-output interpolation enter v1 by accident.

## Non-goals

- No raw replacement of the entire live system/user message stack.
- No prompt variables or interpolation.
- No conditionals, loops or expression language.
- No arbitrary access to state objects, database rows or agent outputs.
- No helper-agent prompt editor.
- No shared/community prompt marketplace.
- No prompt inheritance/composable fragment system.
- No automatic prompt optimizer.
- No automatic winner/default-promotion logic.
- No scoring dashboard in v1.
- No character-level default test prompt.
- No scenario-preset integration.
- No permanent purge UI.
- No new monorepo package in this plan.

## Follow-on: evaluation UI

Take-level qualitative evaluation is useful but does not block the Prompt Lab itself. A follow-on may add owner grading such as:

- Better / about the same / worse;
- player agency;
- character fidelity;
- state obedience;
- physical/spatial consistency;
- pacing;
- dialogue quality;
- prose quality;
- repetition;
- appropriate initiative;
- freeform notes.

That evidence can later summarize a prompt across models and scenes, but v1's responsibility is to make every experiment reproducible first.

## Follow-on: variables and compiled templates

A separate plan should define an allow-listed, perception-safe variable catalog and a deterministic versioned template language. It should consume authoritative projections rather than raw agent responses, use stable semantic selectors rather than roster ordinals such as `npc1`, and never expose arbitrary application object traversal.

That follow-on is the candidate for an app-independent prompt-template/compiler package once its pure parser/compiler is useful to multiple consumers.

## Related work

- [Narrator model profiles and test bench](narrator-model-bench.plan.md) — model choice and model-specific presentation profiles remain a separate experimental axis. Prompt Lab must record the effective narrator model but does not replace the model bench.
- [Narrator model test bench — technical spec](narrator-model-bench.spec.md) — current narrator/provider behavior and successor-model parity work.
- [Character-chat prompt architecture](../character-chat/prompts.md) — current stable-prefix/volatile-tail layout and narrator prompt contents.
- [Character-chat exchange pipeline](../character-chat/pipeline.md) — exchange lock, regenerate/rerun semantics, state rollback and narrator call lifecycle.
- [Architecture](../architecture.md) — package graduation and application/workspace dependency rules.
