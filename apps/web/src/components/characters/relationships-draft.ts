import { z } from "zod";
import { authoredRelationshipRecordSchema } from "@/contracts";

const edgeDraftSchema = z.object({
  toCharacterId: z.string().min(1),
  toName: z.string(),
  record: authoredRelationshipRecordSchema,
});
export type EdgeDraft = z.infer<typeof edgeDraftSchema>;
export const relationshipRecoverySchema = z.object({ base: z.string(), edges: z.array(edgeDraftSchema) }).nullable();
export type RelationshipRecovery = z.infer<typeof relationshipRecoverySchema>;

/** Display names are not saved relationship state and cannot make a draft dirty. */
export const relationshipSnapshot = (edges: readonly EdgeDraft[]): string =>
  JSON.stringify(edges.map(({ toCharacterId, record }) => ({
    toCharacterId,
    record: {
      familiarity: record.familiarity,
      regard: record.regard,
      kind: record.kind,
      history: record.history,
      presented: record.presented ? { lean: record.presented.lean, note: record.presented.note } : null,
      looming: record.looming,
    },
  })).sort((a, b) => a.toCharacterId.localeCompare(b.toCharacterId)));

/** An acknowledgement changes the baseline of local edits, never the edits themselves.
 * A recovered version from another baseline still requires explicit reconciliation. */
export function rebaseRelationshipRecovery(
  current: RelationshipRecovery,
  previousBase: string,
  savedBase: string,
  blocked: boolean,
): RelationshipRecovery {
  if (!current || blocked || current.base !== previousBase) return current;
  return { base: savedBase, edges: current.edges };
}
