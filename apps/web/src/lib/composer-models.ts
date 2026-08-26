/**
 * Curated **scene composer** model options — the shot planner that turns chat state
 * into the structured `sceneSpecSchema` object every scene render is built from
 * (`server/images/prompts-scene-composer.ts`). One pure list shared by the admin
 * dropdown (components/chat/scene-composer-select.tsx) and the server's
 * `sceneComposerModelId` resolver (server/ai/provider.ts). Ids are OpenRouter slugs.
 *
 * Out of scope by design: the narrator (narrative-models.ts), the in-session agents
 * (agent-models.ts), and the image models themselves (the `image_models` registry —
 * this list is the TEXT model that plans the shot, never the one that paints it).
 *
 * ## Why the composer gets its own list at all
 *
 * The composer is a **structured-output** call over the most explicit stretch of a
 * chat, and those two facts pull in opposite directions. A moderation-prone model
 * answers an intimate beat with vague poses ("close to the viewer, intimate"), which
 * is a grounding failure before it is a moderation one — the render then gets anatomy
 * with no act (owner ruling 2026-08-10). A permissive model that cannot emit clean
 * JSON is no better: it degrades to the schema defaults, which parse and look exactly
 * like a composition.
 *
 * This list is the owner-approved **candidate shortlist**, not a claim that every row
 * has already passed the A/B. The probe that validates a candidate is
 * `scripts/eval/scene-images/composer-model-ab.ts` — it runs the real system prompt,
 * the real schema and the real evidence gates over the seven fixture beats, four of
 * them explicitly intimate. **Promotion to the app default requires a recorded A/B
 * verdict**; admin/eval candidates may exist here before that verdict so they can
 * be tried without a deploy.
 *
 * Nothing here needs tool calling or `response_format`: `generateChecked` sends the
 * JSON Schema as TEXT and parses the reply locally, deliberately not using
 * provider-side constrained decoding (which degenerated on some models —
 * followups.phase2.md #20). That is why Aion 2.0, which advertises no structured-output
 * support, is a legitimate candidate.
 */

export interface SceneComposerModelOption {
  /** OpenRouter model id, e.g. "aion-labs/aion-3.0". */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /**
   * One line of operator-facing guidance, shown under the admin dropdown. Says what
   * this model costs you and what it is good at — the whole reason an admin would move
   * a chat off the default.
   */
  description: string;
}

/**
 * The curated candidate set. Ordered cheapest-blended-cost LAST is deliberately NOT
 * the rule: the **shipped default sits first**, the A/B control second (it is the row
 * every other one was measured against), and the rest run roughly fastest-first, which
 * is the axis an operator is switching on. Floating aliases are allowed here for
 * evaluation/admin use; the app default is separately required to be pinned.
 *
 * The pinned default and the `~…-latest` alias below are the SAME weights today
 * (the alias resolved to `deepseek-v4-flash-0731` when the default was promoted).
 * They are both listed on purpose: the pin is what production is measured on, and the
 * alias is how a newer snapshot gets tried on one conversation before it is promoted.
 */
export const SCENE_COMPOSER_MODELS: readonly SceneComposerModelOption[] = [
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek 4 Flash (default)",
    description: "The shipped default. Matched Aion 3.0's score in the A/B at ~1/12 the latency and ~1/45 the cost; runs with reasoning off.",
  },
  {
    id: "aion-labs/aion-3.0",
    label: "Aion 3.0 (former default)",
    description: "The A/B control. Most permissive, most expensive, and slowest — reasoning is mandatory on this endpoint.",
  },
  {
    id: "aion-labs/aion-3.0-mini",
    label: "Aion 3.0 Mini",
    description: "Same lab as the control, ~4× cheaper. The safe landing spot if a flash model refuses intimate beats.",
  },
  {
    id: "aion-labs/aion-2.0",
    label: "Aion 2.0",
    description: "The session narrator's model. Permissive and proven on this repo's most explicit text; no structured-output support needed.",
  },
  {
    id: "~deepseek/deepseek-v4-flash-latest",
    label: "DeepSeek 4 Flash (latest)",
    description: "The floating alias the agent lane rides. Same family as the default, but follows new releases — for trying a newer snapshot without a deploy.",
  },
  {
    id: "qwen/qwen3.7-flash",
    label: "Qwen3.7 Flash",
    description: "The cheapest capable arm. Fast classifier-class model with a very large context window.",
  },
  {
    id: "z-ai/glm-4.7-flash",
    label: "GLM 4.7 Flash",
    description: "Flash-tier sibling of the curated GLM narrator. Cheap input, pricier output than the other flash rows.",
  },
  {
    id: "inclusionai/ling-3.0-flash",
    label: "Ling 3.0 Flash",
    description: "The cheapest model on the board. Included as the floor — if quality holds here, nothing beats it on price.",
  },
] as const;

/**
 * The composer model used when the chat has no admin override.
 *
 * **DeepSeek 4 Flash, pinned, reasoning off** (owner ruling 2026-08-15, promoted from
 * Aion 3.0). The A/B scored it level with the control across seven beats — four of them
 * explicitly intimate — at roughly a twelfth of the latency and a forty-fifth of the
 * cost, and it never once degraded, so the Aion 2.0 refusal rung stays unexercised
 * (0/14 measured, against the owner's 10% review threshold). Aion 3.0's reasoning is
 * mandatory on its endpoint, so every composition it planned paid for a trace nothing
 * read; the winning arm turns reasoning off instead, which is why promoting it is a
 * model id **plus** a call policy — see `composerDisablesReasoning` in
 * `server/ai/provider.ts`. Changing this constant alone would ship a different product
 * from the one that was measured.
 *
 * Pinned to the dated snapshot rather than `~deepseek/deepseek-v4-flash-latest`, which
 * is the id the A/B actually asked: the alias resolved to this exact snapshot at
 * promotion time, and pinning is what stops a provider-side release from silently
 * changing scene composition. `composer-models.test.ts` rejects a `~`-prefixed or
 * `-latest` default so the pin cannot be undone by accident.
 *
 * The dated slug is listed at ~2× the alias's price because OpenRouter prices a slug by
 * its cheapest endpoint and the alias reaches a cheaper pool. `PROVIDER_ORDER`
 * (`server/ai/provider.ts`) closes that gap by routing this snapshot to the cheap fp8
 * endpoints directly, so the pin costs what the tested alias cost.
 */
export const DEFAULT_SCENE_COMPOSER_MODEL_ID = "deepseek/deepseek-v4-flash-0731";

/**
 * Resolve a persisted/over-the-wire composer id to a curated one. STRICT, for the
 * reason every other model resolver in this app is strict (codebase-review B3):
 * without it an authenticated user could bill arbitrary OpenRouter slugs — frontier
 * models included — to the deployment's key through a chat PATCH.
 *
 * An empty value means "no override", which is the overwhelmingly common case and not
 * an error. An unrecognised one is: it is a dropped registry entry or a typo, and both
 * should land on the default rather than 404 a render.
 */
export function resolveSceneComposerModelId(id: string | null | undefined): string {
  const trimmed = id?.trim();
  if (!trimmed) return DEFAULT_SCENE_COMPOSER_MODEL_ID;
  return SCENE_COMPOSER_MODELS.some((option) => option.id === trimmed)
    ? trimmed
    : DEFAULT_SCENE_COMPOSER_MODEL_ID;
}
