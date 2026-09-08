import { z } from "zod";
import type { CharacterProfile, DiagnosticSink, ItemDefinition, SpeciesDefinition } from "@/contracts";
import type { ClothingCandidateLookup, LibraryLookup } from "../library";
import type { CharacterSheetScope } from "@/lib/character-scopes";
import type { CharacterDraft } from "../drafts";

/** Shared low-latency, reasoning-off options for all three structured forge legs. */
export const FORGE_LEG_OPTIONS = { disableReasoning: true, lowLatencyRouting: true } as const;

export const characterForgeSections = ["profile", "attributes", "outfit"] as const;
export const characterForgeSectionSchema = z.enum(characterForgeSections);
export type CharacterForgeSection = (typeof characterForgeSections)[number];

export interface CharacterForgeContext {
  prompt: string;
  /** Limit structured output to one visible authoring section. */
  scope?: CharacterSheetScope;
  userId: string;
  sink?: DiagnosticSink;
  /** Current draft, for single-section regeneration context. */
  draft?: CharacterDraft;
  /** Item-library lookup; defaults to an ILIKE query against the items table. */
  findItems?: LibraryLookup;
  /** Wardrobe reuse candidates for the outfit agent; defaults to a DB query. */
  listCandidates?: ClothingCandidateLookup;
  /** Demo content is available only for editable, human-reviewed drafts. */
  useFallbacks?: boolean;
  /** Deterministic registry match from the forge prompt, shared by all sections. */
  inferredSpecies?: SpeciesDefinition;
}

export interface CharacterSectionPatch {
  name?: string;
  tags?: string[];
  profile?: Partial<CharacterProfile>;
  suggestedItems?: ItemDefinition[];
}

export interface ForgeCharacterInput {
  prompt: string;
  userId: string;
  sink?: DiagnosticSink;
  findItems?: LibraryLookup;
  listCandidates?: ClothingCandidateLookup;
  useFallbacks?: boolean;
}
