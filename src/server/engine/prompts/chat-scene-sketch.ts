import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "./untrusted";

/**
 * The chat location-sketch prompt (chat-scene-fidelity.plan.md slice 2b). A small,
 * single-concern background agent (like the ./chat-extractors.ts legs): when the conversation
 * introduces a place, expand it into a compact visual sketch — 2–4 sentences of layout,
 * light, palette, and a few fixtures — stored on the place's scene-memory record and
 * consumed by the scene image (`room`) and the narrator's Scene block. Runs detached
 * after the reply settles, so it never delays a turn. Pure and snapshot-testable; no IO.
 */

export const CHAT_SCENE_SKETCH_SYSTEM = `You are the location artist for a private one-on-one roleplay chat. You are given a place the story just moved into, along with everything the fiction has established about it. Produce a single JSON object:

{ "sketch": "<2-4 sentences describing the place visually>" }

Rules:
1. Output ONLY the JSON object — no markdown, no commentary.
2. Describe the PLACE only: layout, light, palette, and a handful of concrete fixtures. Never people, never events, never sounds or smells alone — this drives an image.
3. Every established detail given below MUST appear in the sketch (rephrased naturally is fine). Invent only compatible texture around them — modest, generic furnishings that fit the scenario's tone — and contradict nothing.
4. Match the scenario's setting, era, and tone. A modest loft stays modest; a fantasy tavern stays in-world.
5. Concrete and paintable over poetic: "a low couch under tall windows, morning light on bare brick" beats "a cozy sanctuary of dreams".
6. Keep it under 100 words.
7. ${UNTRUSTED_DATA_NOTICE}`;

export interface ChatSceneSketchPromptInput {
  placeName: string;
  /** Durable details the fiction established ("blue sofa", "tall windows"). */
  details: readonly string[];
  /** Named connections ("kitchen through the doorway") — context for layout. */
  connections: readonly string[];
  timeOfDay?: string;
  /** The chat's scenario premise — the setting/tone authority. */
  premise?: string;
  characterName: string;
  /** Recent narration (oldest first) — how the fiction has painted the place so far. */
  recentNarration: readonly string[];
}

export function buildChatSceneSketchPrompt(input: ChatSceneSketchPromptInput): string {
  const details = input.details.map((d) => `- ${d}`).join("\n");
  const connections = input.connections.map((c) => `- ${c}`).join("\n");
  const narration = input.recentNarration.filter((t) => t.trim()).slice(-3).join("\n\n");
  return [
    `Place to sketch: ${input.placeName}`,
    input.timeOfDay ? `Time of day: ${input.timeOfDay}` : "",
    input.premise ? `Scenario (setting/tone authority):\n${fenceUntrusted("scenario", input.premise)}` : "",
    `Established details (each MUST appear in the sketch):\n${details || "(none yet — invent modest, tone-appropriate furnishings)"}`,
    connections ? `Connections (layout context):\n${connections}` : "",
    narration
      ? `Recent narration featuring ${input.characterName} (how the fiction painted it):\n${fenceUntrusted("recent narration", narration)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
