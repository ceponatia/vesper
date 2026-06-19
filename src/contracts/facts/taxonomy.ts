import { z } from "zod";

/** Stable fact categories. Extend by adding to the array (docs/contracts/facts.md). */
export const factKindIds = [
  "relationship",
  "knowledge",
  "commitment",
  "attribute_revelation",
  "item",
  "location",
  "event",
  "preference",
  "secret",
] as const;

export const factKindSchema = z.enum(factKindIds);
export type FactKind = z.infer<typeof factKindSchema>;

/** Optional normalized verbs (aionchat-style second dimension, starter set). */
export const factVerbIds = [
  "promise",
  "threaten",
  "request",
  "refuse",
  "confess",
  "reveal_trait",
  "reveal_history",
  "show_affection",
  "show_trust",
  "show_fear",
  "show_anger",
  "reject_advance",
  "accept_advance",
  "acquire",
  "lose",
  "discover",
  "learn",
] as const;

export const factVerbSchema = z.enum(factVerbIds);
export type FactVerb = z.infer<typeof factVerbSchema>;

export const factSubjectKinds = ["character", "player", "location", "item", "world"] as const;
export const factSubjectKindSchema = z.enum(factSubjectKinds);
export type FactSubjectKind = z.infer<typeof factSubjectKindSchema>;

export const factStatusSchema = z.enum(["active", "superseded", "retracted"]);
export type FactStatus = z.infer<typeof factStatusSchema>;

export const factDraftSchema = z.object({
  kind: factKindSchema.catch("knowledge"),
  verb: factVerbSchema.optional().catch(undefined),
  subjectName: z.string().min(1),
  subjectKind: factSubjectKindSchema.catch("character"),
  text: z.string().min(1),
  tags: z
    .array(z.string().min(1))
    .default([])
    .transform((tags) => tags.map((t) => t.toLowerCase())),
  confidence: z.number().min(0).max(1).catch(0.5),
});

export type FactDraft = z.infer<typeof factDraftSchema>;
