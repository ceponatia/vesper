import { attributeRegistry } from "@/contracts/attributes";
import { resolveAttributes, type AttributeValue } from "@/contracts/attributes/value";
import { realizeBody, speciesLorePhrase } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";

/**
 * The character-chat harness prompt (docs/developer-notes/character-chat.plan.md).
 *
 * A focused, single-character system prompt for the 1-on-1 Chat tab — built to
 * tune how faithfully the narrator voices a character's PERSONALITY from its
 * saved attributes, without standing up a session. It deliberately reuses the
 * SAME representation the in-game narrator gets — resolved attribute values via
 * the registry, plus each attribute's `promptHints` as phrasing guidance (the
 * narrator keeps hints; only the image prompt strips them, images/prompts.ts) —
 * but drops all the session machinery (presence, wardrobe state, meters,
 * exposure, RAG). Pure and snapshot-testable; no IO.
 */

const BIO_EXCERPT_CHARS = 600;

export interface CharacterChatPromptInput {
  name: string;
  profile: CharacterProfile;
}

const humanize = (value: string): string => value.replaceAll("_", " ").trim();

/** One resolved attribute → a `label: value` phrase, or null for empty/false. */
function attributePhrase(label: string, unit: string | undefined, value: AttributeValue["value"]): string | null {
  if (typeof value === "boolean") return value ? label.toLowerCase() : null;
  if (typeof value === "number") return `${label.toLowerCase()}: ${value}${unit ? ` ${unit}` : ""}`;
  if (Array.isArray(value)) {
    const joined = value.map((v) => humanize(String(v))).join(", ");
    return joined ? `${label.toLowerCase()}: ${joined}` : null;
  }
  const text = humanize(value);
  return text ? `${label.toLowerCase()}: ${text}` : null;
}

function excerpt(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}

const CHAT_RULES = (name: string): string =>
  [
    "How to respond:",
    `1. Stay fully in character as ${name}. Never break character, never mention being an AI, a model, or a chat app, never address the user as anyone but the person ${name} is talking to.`,
    `2. Speak in the first person as ${name}; address the user directly as "you". The user's message is what they just said or did to you.`,
    `3. Start every line of your spoken dialogue with the tag [${name}] followed by the words in quotes, e.g. [${name}] "It's good to see you." Keep actions, gestures, and description as untagged prose on their own lines.`,
    "4. Keep replies conversational — one or two short paragraphs. Resolve the immediate beat and end on a present moment (a line, a gesture, a look), never a summary or reflection.",
    "5. Let the personality, voice, and attributes above drive your word choice, rhythm, reactions, and opinions — show it through how you speak, don't recite the traits.",
    "6. Respond directly to what the user just said before adding anything new.",
  ].join("\n");

/**
 * Build the system prompt embodying `name` from their saved profile. Attribute
 * applicability is checked against the realized body (`realizeBody`) so a stale
 * attribute (e.g. wings left on a character after a species change) never leaks,
 * mirroring images/prompts.ts and engine/scene.ts.
 */
export function buildCharacterChatSystemPrompt(input: CharacterChatPromptInput): string {
  const { name, profile } = input;
  const displayName = name.trim() || "this character";

  const realizedBody = realizeBody({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: profile.intimateRegions,
    bodyFeatures: profile.bodyFeatures,
  });

  const resolved = resolveAttributes(profile.attributes, []);
  const age = resolved.find((v) => v.id === "identity.apparent_age");
  const agePhrase = typeof age?.value === "string" ? humanize(age.value) : "";
  const species = speciesLorePhrase(profile.speciesId, profile.heritageId);

  // Attribute lines + a deduped phrasing-guidance set (same shape as
  // engine/scene.buildGlanceImpressions) so a hint shared by many attributes is
  // stated once instead of repeated per line.
  const attributeLines: string[] = [];
  const hints = new Set<string>();
  for (const value of resolved) {
    if (value.id === "identity.apparent_age") continue; // surfaced in the identity block
    const def = attributeRegistry.byId(value.id);
    if (!def) continue; // unknown vocabulary — never leak a raw id
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const phrase = attributePhrase(def.label, def.unit, value.value);
    if (!phrase) continue;
    attributeLines.push(`- ${phrase}`);
    for (const hint of def.promptHints ?? []) hints.add(hint);
  }

  const identity = [
    `You are ${displayName}, speaking with the user in a one-on-one conversation.`,
    agePhrase ? `You appear ${agePhrase}.` : "",
    species ? `Species: ${species}.` : "",
    profile.bio.trim() ? `Background: ${excerpt(profile.bio, BIO_EXCERPT_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const sections = [
    identity,
    profile.personality.trim() ? `Personality:\n${profile.personality.trim()}` : "",
    profile.voice?.trim() ? `Voice (how you sound): ${profile.voice.trim()}` : "",
    attributeLines.length
      ? `Attributes (who you are — express these naturally, never list them):\n${attributeLines.join("\n")}`
      : "",
    hints.size ? `Phrasing guidance:\n${[...hints].map((h) => `- ${h}`).join("\n")}` : "",
    CHAT_RULES(displayName),
  ];

  return sections.filter(Boolean).join("\n\n");
}
